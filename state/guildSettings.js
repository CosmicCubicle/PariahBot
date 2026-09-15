const db = require('./db');

// General per-guild bot settings — not specific to voice/hubs, even though this
// module's first (and so far only) consumer is the hub-desync alert feature. The
// guild_settings and guild_alert_recipients tables were always named and shaped
// generically; this module just gives them a home that matches that, instead of
// living inside state/voiceChannels.js where they never conceptually belonged.

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

// Adding the same recipient twice is a harmless no-op — there's no meaningful
// "you already did this" error worth surfacing here.
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
		modRoleId: row?.mod_role_id ?? null,
		ownerKickDisabled: !!row?.owner_kick_disabled,
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

// Sticky: marks this guild as opted out, so the auto-provisioning in
// lib/defaultAlertInfra.js never recreates it later just because the columns are
// null again.
function clearDefaultAlertInfra(guildId) {
	clearDefaultAlertInfraStmt.run({ guildId });
}

// mod_role_id shipped with this table back in Stage 1 checkpoint 1 but had no
// reader/writer until Stage 2 needed a way to distinguish "mod" from "regular
// owner" for /vc claim's override rules — see lib/permissions.js.
const upsertModRoleStmt = db.prepare(`
	INSERT INTO guild_settings (guild_id, mod_role_id)
	VALUES (@guildId, @roleId)
	ON CONFLICT(guild_id) DO UPDATE SET mod_role_id = excluded.mod_role_id
`);

function setModRole(guildId, roleId) {
	upsertModRoleStmt.run({ guildId, roleId });
}

function clearModRole(guildId) {
	upsertModRoleStmt.run({ guildId, roleId: null });
}

const selectModRoleStmt = db.prepare('SELECT mod_role_id FROM guild_settings WHERE guild_id = ?');

function getModRole(guildId) {
	return selectModRoleStmt.get(guildId)?.mod_role_id ?? null;
}

const setOwnerKickDisabledStmt = db.prepare(`
	INSERT INTO guild_settings (guild_id, owner_kick_disabled)
	VALUES (@guildId, @disabled)
	ON CONFLICT(guild_id) DO UPDATE SET owner_kick_disabled = excluded.owner_kick_disabled
`);

function disableOwnerKick(guildId) {
	setOwnerKickDisabledStmt.run({ guildId, disabled: 1 });
}

function enableOwnerKick(guildId) {
	setOwnerKickDisabledStmt.run({ guildId, disabled: 0 });
}

const selectOwnerKickDisabledStmt = db.prepare('SELECT owner_kick_disabled FROM guild_settings WHERE guild_id = ?');

function isOwnerKickDisabled(guildId) {
	return !!selectOwnerKickDisabledStmt.get(guildId)?.owner_kick_disabled;
}

module.exports = {
	setAlertChannel,
	getAlertChannel,
	addAlertRecipient,
	removeAlertRecipient,
	listAlertRecipients,
	getGuildSettings,
	setDefaultAlertInfra,
	clearDefaultAlertInfra,
	setModRole,
	clearModRole,
	getModRole,
	disableOwnerKick,
	enableOwnerKick,
	isOwnerKickDisabled,
};
