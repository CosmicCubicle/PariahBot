const db = require('./db');

function mapRow(row) {
	if (!row) return null;
	return {
		guildId: row.guild_id,
		userId: row.user_id,
		xp: row.xp,
		level: row.level,
		lastXpAt: row.last_xp_at,
	};
}

const selectUserStmt = db.prepare('SELECT * FROM user_levels WHERE guild_id = ? AND user_id = ?');

function getUser(guildId, userId) {
	return mapRow(selectUserStmt.get(guildId, userId));
}

const upsertUserStmt = db.prepare(`
	INSERT INTO user_levels (guild_id, user_id, xp, level, last_xp_at)
	VALUES (@guildId, @userId, @xp, @level, @lastXpAt)
	ON CONFLICT(guild_id, user_id) DO UPDATE SET
		xp = excluded.xp,
		level = excluded.level,
		last_xp_at = excluded.last_xp_at
`);

function setUser({ guildId, userId, xp, level, lastXpAt }) {
	upsertUserStmt.run({ guildId, userId, xp, level, lastXpAt });
}

const selectLeaderboardStmt = db.prepare(`
	SELECT * FROM user_levels WHERE guild_id = ? ORDER BY xp DESC LIMIT ?
`);

function listTopForGuild(guildId, limit = 10) {
	return selectLeaderboardStmt.all(guildId, limit).map(mapRow);
}

module.exports = {
	getUser,
	setUser,
	listTopForGuild,
};
