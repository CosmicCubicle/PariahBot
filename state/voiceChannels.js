const db = require('./db');

function mapHub(row) {
	if (!row) return null;
	return {
		channelId: row.channel_id,
		guildId: row.guild_id,
		categoryId: row.category_id,
		nameTemplate: row.name_template,
		defaultLimit: row.default_limit,
		minLimit: row.min_limit,
		maxLimit: row.max_limit,
	};
}

function mapTempChannel(row) {
	if (!row) return null;
	return {
		channelId: row.channel_id,
		guildId: row.guild_id,
		hubChannelId: row.hub_channel_id,
		ownerId: row.owner_id,
		createdAt: row.created_at,
		minLimit: row.min_limit,
		maxLimit: row.max_limit,
	};
}

const insertHubStmt = db.prepare(`
	INSERT INTO hubs (channel_id, guild_id, category_id)
	VALUES (@channelId, @guildId, @categoryId)
`);

// Throws (SqliteError, unique constraint) if channelId is already a hub;
// the command layer decides how to surface that to the admin.
function addHub(guildId, channelId, categoryId) {
	insertHubStmt.run({ guildId, channelId, categoryId: categoryId ?? null });
}

const deleteHubStmt = db.prepare('DELETE FROM hubs WHERE channel_id = ?');

function removeHub(channelId) {
	return deleteHubStmt.run(channelId).changes > 0;
}

const selectHubStmt = db.prepare('SELECT * FROM hubs WHERE channel_id = ?');

function getHub(channelId) {
	return mapHub(selectHubStmt.get(channelId));
}

const selectHubsForGuildStmt = db.prepare('SELECT * FROM hubs WHERE guild_id = ? ORDER BY channel_id');

function listHubs(guildId) {
	return selectHubsForGuildStmt.all(guildId).map(mapHub);
}

const insertTempChannelStmt = db.prepare(`
	INSERT INTO temp_channels (channel_id, guild_id, hub_channel_id, owner_id, created_at, min_limit, max_limit)
	VALUES (@channelId, @guildId, @hubChannelId, @ownerId, @createdAt, @minLimit, @maxLimit)
`);

function createTempChannel({ channelId, guildId, hubChannelId, ownerId, minLimit, maxLimit }) {
	insertTempChannelStmt.run({
		channelId,
		guildId,
		hubChannelId,
		ownerId,
		createdAt: new Date().toISOString(),
		minLimit,
		maxLimit,
	});
}

const deleteTempChannelStmt = db.prepare('DELETE FROM temp_channels WHERE channel_id = ?');

function removeTempChannel(channelId) {
	return deleteTempChannelStmt.run(channelId).changes > 0;
}

const selectTempChannelStmt = db.prepare('SELECT * FROM temp_channels WHERE channel_id = ?');

function getTempChannel(channelId) {
	return mapTempChannel(selectTempChannelStmt.get(channelId));
}

function isTempChannel(channelId) {
	return getTempChannel(channelId) !== null;
}

// Alert routing (Stage 1 checkpoint 5): where a hub-desync notice gets sent for a
// guild — an alert channel, a DM recipient list, both, or neither if unconfigured.

const upsertAlertChannelStmt = db.prepare(`
	INSERT INTO guild_settings (guild_id, alert_channel_id)
	VALUES (@guildId, @channelId)
	ON CONFLICT(guild_id) DO UPDATE SET alert_channel_id = excluded.alert_channel_id
`);

function setAlertChannel(guildId, channelId) {
	upsertAlertChannelStmt.run({ guildId, channelId });
}

const selectAlertChannelStmt = db.prepare('SELECT alert_channel_id FROM guild_settings WHERE guild_id = ?');

function getAlertChannel(guildId) {
	return selectAlertChannelStmt.get(guildId)?.alert_channel_id ?? null;
}

// Adding the same recipient twice is a harmless no-op, unlike addHub's duplicate
// check — there's no meaningful "you already did this" error worth surfacing here.
const insertAlertRecipientStmt = db.prepare('INSERT OR IGNORE INTO guild_alert_recipients (guild_id, user_id) VALUES (?, ?)');

function addAlertRecipient(guildId, userId) {
	insertAlertRecipientStmt.run(guildId, userId);
}

const deleteAlertRecipientStmt = db.prepare('DELETE FROM guild_alert_recipients WHERE guild_id = ? AND user_id = ?');

function removeAlertRecipient(guildId, userId) {
	return deleteAlertRecipientStmt.run(guildId, userId).changes > 0;
}

const selectAlertRecipientsStmt = db.prepare('SELECT user_id FROM guild_alert_recipients WHERE guild_id = ? ORDER BY user_id');

function listAlertRecipients(guildId) {
	return selectAlertRecipientsStmt.all(guildId).map((row) => row.user_id);
}

// The bot's own auto-provisioned default alert category/channel — a fallback used
// only when the admin hasn't set alert_channel_id explicitly. See the comment in
// state/db.js for why default_alerts_disabled needs to be tracked separately from
// "the IDs are null."

const selectGuildSettingsStmt = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?');

function getGuildSettings(guildId) {
	const row = selectGuildSettingsStmt.get(guildId);
	return {
		alertChannelId: row?.alert_channel_id ?? null,
		defaultCategoryId: row?.default_category_id ?? null,
		defaultChannelId: row?.default_channel_id ?? null,
		defaultAlertsDisabled: !!row?.default_alerts_disabled,
	};
}

const setDefaultAlertInfraStmt = db.prepare(`
	INSERT INTO guild_settings (guild_id, default_category_id, default_channel_id, default_alerts_disabled)
	VALUES (@guildId, @categoryId, @channelId, 0)
	ON CONFLICT(guild_id) DO UPDATE SET
		default_category_id = excluded.default_category_id,
		default_channel_id = excluded.default_channel_id,
		default_alerts_disabled = 0
`);

// Also clears the disabled flag: (re)pointing at a real category/channel always
// means the default is active, whether this is the first creation or a restore.
function setDefaultAlertInfra(guildId, categoryId, channelId) {
	setDefaultAlertInfraStmt.run({ guildId, categoryId, channelId });
}

const clearDefaultAlertInfraStmt = db.prepare(`
	INSERT INTO guild_settings (guild_id, default_category_id, default_channel_id, default_alerts_disabled)
	VALUES (@guildId, NULL, NULL, 1)
	ON CONFLICT(guild_id) DO UPDATE SET
		default_category_id = NULL,
		default_channel_id = NULL,
		default_alerts_disabled = 1
`);

// Sticky: marks this guild as opted out, so GuildCreate's auto-provisioning never
// recreates it later just because the columns are null again.
function clearDefaultAlertInfra(guildId) {
	clearDefaultAlertInfraStmt.run({ guildId });
}

module.exports = {
	addHub,
	removeHub,
	getHub,
	listHubs,
	createTempChannel,
	removeTempChannel,
	getTempChannel,
	isTempChannel,
	setAlertChannel,
	getAlertChannel,
	addAlertRecipient,
	removeAlertRecipient,
	listAlertRecipients,
	getGuildSettings,
	setDefaultAlertInfra,
	clearDefaultAlertInfra,
};
