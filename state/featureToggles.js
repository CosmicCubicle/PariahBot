const db = require('./db');

// Per-guild feature switches (#69). Only rows an admin has actually set exist:
// a missing row means "use the default", which lib/features.js owns. That's
// what lets a new feature ship without backfilling every guild, and what stops
// this table from being a second, driftable copy of the feature list.

const upsertStmt = db.prepare(`
	INSERT INTO guild_feature_toggles (guild_id, feature, enabled)
	VALUES (@guildId, @feature, @enabled)
	ON CONFLICT(guild_id, feature) DO UPDATE SET enabled = excluded.enabled
`);

function setEnabled(guildId, feature, enabled) {
	upsertStmt.run({ guildId, feature, enabled: enabled ? 1 : 0 });
}

// Returns null rather than a boolean when nothing is stored, so the caller can
// tell "an admin set this off" apart from "never touched" — only the former
// should override a default.
const selectStmt = db.prepare('SELECT enabled FROM guild_feature_toggles WHERE guild_id = ? AND feature = ?');

function getEnabled(guildId, feature) {
	const row = selectStmt.get(guildId, feature);
	return row ? !!row.enabled : null;
}

// One query for the whole guild, for /setup feature list, /help and the
// dashboard — all three show every feature at once, and a query per feature
// would be a dozen round trips to render one reply.
const selectAllStmt = db.prepare('SELECT feature, enabled FROM guild_feature_toggles WHERE guild_id = ?');

function getAllForGuild(guildId) {
	const map = new Map();
	for (const row of selectAllStmt.all(guildId)) map.set(row.feature, !!row.enabled);
	return map;
}

const deleteStmt = db.prepare('DELETE FROM guild_feature_toggles WHERE guild_id = ? AND feature = ?');

// Back to the default, rather than storing the default as an explicit value —
// so a feature whose default changes later follows the new one.
function clear(guildId, feature) {
	return deleteStmt.run(guildId, feature).changes > 0;
}

// Guilds that explicitly switched a feature on. Only useful for a feature
// whose default is off (banned words), where "has a row set to 1" and
// "enabled" are the same set — lib/bannedWords.js uses it at startup to
// re-sync just those guilds. A default-on feature would also need every guild
// with no row at all, which this deliberately does not try to answer.
const selectGuildsWithStmt = db.prepare('SELECT guild_id FROM guild_feature_toggles WHERE feature = ? AND enabled = 1');

function listGuildsExplicitlyEnabled(feature) {
	return selectGuildsWithStmt.all(feature).map((row) => row.guild_id);
}

module.exports = { setEnabled, getEnabled, getAllForGuild, clear, listGuildsExplicitlyEnabled };
