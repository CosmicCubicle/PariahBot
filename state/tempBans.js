const db = require('./db');

// Pending unbans for /mod ban duration:… — see lib/moderation.js, which
// schedules them and does the unbanning.

function mapTempBan(row) {
	if (!row) return null;
	return {
		guildId: row.guild_id,
		userId: row.user_id,
		unbanAt: row.unban_at,
		bannedBy: row.banned_by,
		reason: row.reason,
	};
}

// A second temporary ban on the same person replaces the first, so the
// latest duration is the one that counts.
const upsertTempBanStmt = db.prepare(`
	INSERT INTO temp_bans (guild_id, user_id, unban_at, banned_by, reason)
	VALUES (@guildId, @userId, @unbanAt, @bannedBy, @reason)
	ON CONFLICT(guild_id, user_id) DO UPDATE SET
		unban_at = excluded.unban_at,
		banned_by = excluded.banned_by,
		reason = excluded.reason
`);

function setTempBan(guildId, userId, unbanAt, bannedBy, reason) {
	upsertTempBanStmt.run({ guildId, userId, unbanAt, bannedBy, reason: reason ?? null });
}

const selectTempBanStmt = db.prepare('SELECT * FROM temp_bans WHERE guild_id = ? AND user_id = ?');

function getTempBan(guildId, userId) {
	return mapTempBan(selectTempBanStmt.get(guildId, userId));
}

const deleteTempBanStmt = db.prepare('DELETE FROM temp_bans WHERE guild_id = ? AND user_id = ?');

function removeTempBan(guildId, userId) {
	return deleteTempBanStmt.run(guildId, userId).changes > 0;
}

const selectAllTempBansStmt = db.prepare('SELECT * FROM temp_bans ORDER BY unban_at');

// Every guild at once, for scheduling at startup.
function listTempBans() {
	return selectAllTempBansStmt.all().map(mapTempBan);
}

module.exports = {
	setTempBan,
	getTempBan,
	removeTempBan,
	listTempBans,
};
