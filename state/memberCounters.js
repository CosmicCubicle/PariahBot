const db = require('./db');

// Member count channels (#90). One row per counter channel; the channel's own
// name is the output, so there is no stored "current value" — the live count is
// recomputed each time (lib/memberCounters.js) and the name rewritten.

function mapCounter(row) {
	if (!row) return null;
	return {
		channelId: row.channel_id,
		guildId: row.guild_id,
		type: row.type,
		roleId: row.role_id,
		nameTemplate: row.name_template,
	};
}

const insertStmt = db.prepare(`
	INSERT INTO member_counters (channel_id, guild_id, type, role_id, name_template)
	VALUES (@channelId, @guildId, @type, @roleId, @nameTemplate)
`);

// Throws on a duplicate channel_id (SQLITE_CONSTRAINT_PRIMARYKEY); the command
// layer decides what to tell the admin, the way state/voiceChannels.js does.
function addCounter({ channelId, guildId, type, roleId = null, nameTemplate }) {
	insertStmt.run({ channelId, guildId, type, roleId, nameTemplate });
}

const updateTemplateStmt = db.prepare(`
	UPDATE member_counters SET name_template = @nameTemplate
	WHERE channel_id = @channelId AND guild_id = @guildId
`);

// guild_id is in the WHERE for the same reason as state/voiceChannels.js's
// removeHub: a channel id typed by hand could belong to another guild the bot
// is also in (WorkingAgreements.md § 2).
function setTemplate(channelId, guildId, nameTemplate) {
	return updateTemplateStmt.run({ channelId, guildId, nameTemplate }).changes > 0;
}

const deleteStmt = db.prepare('DELETE FROM member_counters WHERE channel_id = ? AND guild_id = ?');

function removeCounter(channelId, guildId) {
	return deleteStmt.run(channelId, guildId).changes > 0;
}

// Used when the channel is gone from Discord: no guild to scope by, because the
// row is being cleaned up rather than acted on for someone.
const deleteByChannelStmt = db.prepare('DELETE FROM member_counters WHERE channel_id = ?');

function forgetChannel(channelId) {
	return deleteByChannelStmt.run(channelId).changes > 0;
}

const selectForGuildStmt = db.prepare('SELECT * FROM member_counters WHERE guild_id = ? ORDER BY type, channel_id');

function listForGuild(guildId) {
	return selectForGuildStmt.all(guildId).map(mapCounter);
}

const selectAllStmt = db.prepare('SELECT * FROM member_counters ORDER BY guild_id, channel_id');

// For the refresh timer, which sweeps every guild at once.
function listAll() {
	return selectAllStmt.all().map(mapCounter);
}

const selectOneStmt = db.prepare('SELECT * FROM member_counters WHERE channel_id = ?');

function getCounter(channelId) {
	return mapCounter(selectOneStmt.get(channelId));
}

const countForGuildStmt = db.prepare('SELECT COUNT(*) AS n FROM member_counters WHERE guild_id = ?');

function countForGuild(guildId) {
	return countForGuildStmt.get(guildId).n;
}

// Whether this guild already counts this thing. Stops a second "humans"
// counter, while allowing one per role for the role type.
const existsStmt = db.prepare(`
	SELECT 1 FROM member_counters
	WHERE guild_id = ? AND type = ? AND IFNULL(role_id, '') = IFNULL(?, '')
`);

function hasCounter(guildId, type, roleId = null) {
	return Boolean(existsStmt.get(guildId, type, roleId));
}

module.exports = {
	addCounter,
	setTemplate,
	removeCounter,
	forgetChannel,
	listForGuild,
	listAll,
	getCounter,
	countForGuild,
	hasCounter,
};
