const db = require('./db');

// Per-guild server log sections (#81): whether each is on, and its channel.
// Which sections exist, and what each logs, is lib/serverLog.js's business.

function mapSection(row) {
	return {
		enabled: !!row?.enabled,
		channelId: row?.channel_id ?? null,
	};
}

const selectSectionStmt = db.prepare('SELECT enabled, channel_id FROM guild_log_sections WHERE guild_id = ? AND section = ?');

// Never null: a section nobody has touched is simply off with no channel.
function getSection(guildId, section) {
	return mapSection(selectSectionStmt.get(guildId, section));
}

const selectSectionsStmt = db.prepare('SELECT section, enabled, channel_id FROM guild_log_sections WHERE guild_id = ?');

// One query for the whole guild, for /logging status and the dashboard.
function getSections(guildId) {
	const map = new Map();
	for (const row of selectSectionsStmt.all(guildId)) map.set(row.section, mapSection(row));
	return map;
}

// Picking a channel switches the section on: choosing where a log goes and
// then having to turn it on separately would be one step too many.
const upsertChannelStmt = db.prepare(`
	INSERT INTO guild_log_sections (guild_id, section, enabled, channel_id)
	VALUES (@guildId, @section, 1, @channelId)
	ON CONFLICT(guild_id, section) DO UPDATE SET enabled = 1, channel_id = excluded.channel_id
`);

function setChannel(guildId, section, channelId) {
	upsertChannelStmt.run({ guildId, section, channelId });
}

const upsertEnabledStmt = db.prepare(`
	INSERT INTO guild_log_sections (guild_id, section, enabled)
	VALUES (@guildId, @section, @enabled)
	ON CONFLICT(guild_id, section) DO UPDATE SET enabled = excluded.enabled
`);

function setEnabled(guildId, section, enabled) {
	upsertEnabledStmt.run({ guildId, section, enabled: enabled ? 1 : 0 });
}

module.exports = { getSection, getSections, setChannel, setEnabled };
