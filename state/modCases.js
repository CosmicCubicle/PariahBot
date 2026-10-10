const db = require('./db');

// The moderation record behind /mod history — see lib/moderation.js, which
// writes a case for every action.

function mapCase(row) {
	if (!row) return null;
	return {
		id: row.id,
		guildId: row.guild_id,
		userId: row.user_id,
		moderatorId: row.moderator_id,
		action: row.action,
		reason: row.reason,
		durationSeconds: row.duration_seconds,
		createdAt: row.created_at,
	};
}

const insertCaseStmt = db.prepare(`
	INSERT INTO mod_cases (guild_id, user_id, moderator_id, action, reason, duration_seconds, created_at)
	VALUES (@guildId, @userId, @moderatorId, @action, @reason, @durationSeconds, @createdAt)
`);

// moderatorId is null when the bot acted on its own. Returns the case number.
function addCase({ guildId, userId, moderatorId = null, action, reason = null, durationSeconds = null }) {
	const { lastInsertRowid } = insertCaseStmt.run({
		guildId, userId, moderatorId, action, reason, durationSeconds, createdAt: new Date().toISOString(),
	});
	return Number(lastInsertRowid);
}

const selectCasesStmt = db.prepare(`
	SELECT * FROM mod_cases WHERE guild_id = ? AND user_id = ?
	ORDER BY created_at DESC, id DESC LIMIT ?
`);

// Newest first.
function listCasesForUser(guildId, userId, limit) {
	return selectCasesStmt.all(guildId, userId, limit).map(mapCase);
}

const countCasesStmt = db.prepare(`
	SELECT action, COUNT(*) AS count FROM mod_cases WHERE guild_id = ? AND user_id = ? GROUP BY action
`);

// { warn: 3, kick: 1, … } across their whole history.
function countCasesByAction(guildId, userId) {
	return Object.fromEntries(countCasesStmt.all(guildId, userId).map((row) => [row.action, row.count]));
}

const countWarningsSinceStmt = db.prepare(`
	SELECT COUNT(*) AS count FROM mod_cases
	WHERE guild_id = ? AND user_id = ? AND action = 'warn' AND created_at >= ?
`);

function countWarningsSince(guildId, userId, sinceIso) {
	return countWarningsSinceStmt.get(guildId, userId, sinceIso).count;
}

// The case number comes from a free-typed option; guild_id in the WHERE keeps
// it to this server's own cases (WorkingAgreements.md § 2).
const selectCaseStmt = db.prepare('SELECT * FROM mod_cases WHERE id = ? AND guild_id = ?');

function getCase(guildId, caseId) {
	return mapCase(selectCaseStmt.get(caseId, guildId));
}

const deleteCaseStmt = db.prepare('DELETE FROM mod_cases WHERE id = ? AND guild_id = ?');

function removeCase(guildId, caseId) {
	return deleteCaseStmt.run(caseId, guildId).changes > 0;
}

module.exports = {
	addCase,
	listCasesForUser,
	countCasesByAction,
	countWarningsSince,
	getCase,
	removeCase,
};
