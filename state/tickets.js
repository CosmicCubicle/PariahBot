const db = require('./db');

// Support tickets (#89). The tickets themselves are private threads in
// Discord; what lives here is the numbering, who opened and is handling each
// one, and whether it's open — the parts Discord has no notion of.

function mapConfig(row) {
	return {
		panelChannelId: row?.panel_channel_id ?? null,
		panelMessageId: row?.panel_message_id ?? null,
		logChannelId: row?.log_channel_id ?? null,
	};
}

function mapTicket(row) {
	if (!row) return null;
	return {
		id: row.id,
		guildId: row.guild_id,
		number: row.number,
		threadId: row.thread_id,
		openerId: row.opener_id,
		subject: row.subject,
		status: row.status,
		claimedBy: row.claimed_by,
		createdAt: row.created_at,
		closedAt: row.closed_at,
		closedBy: row.closed_by,
	};
}

// --- Configuration -------------------------------------------------------------

const selectConfigStmt = db.prepare('SELECT * FROM ticket_config WHERE guild_id = ?');

function getConfig(guildId) {
	return mapConfig(selectConfigStmt.get(guildId));
}

const upsertConfigStmt = db.prepare(`
	INSERT INTO ticket_config (guild_id, panel_channel_id, panel_message_id, log_channel_id)
	VALUES (@guildId, @panelChannelId, @panelMessageId, @logChannelId)
	ON CONFLICT(guild_id) DO UPDATE SET
		panel_channel_id = excluded.panel_channel_id,
		panel_message_id = excluded.panel_message_id,
		log_channel_id   = excluded.log_channel_id
`);

function setConfig(guildId, { panelChannelId, panelMessageId, logChannelId }) {
	upsertConfigStmt.run({ guildId, panelChannelId, panelMessageId, logChannelId });
}

// Turns tickets off without touching the tickets themselves: open ones still
// close normally, and their history stays for /ticket list.
const clearConfigStmt = db.prepare(`
	UPDATE ticket_config SET panel_channel_id = NULL, panel_message_id = NULL
	WHERE guild_id = ? AND panel_channel_id IS NOT NULL
`);

function clearConfig(guildId) {
	return clearConfigStmt.run(guildId).changes > 0;
}

// --- Tickets -------------------------------------------------------------------

const nextNumberStmt = db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS next FROM tickets WHERE guild_id = ?');
const insertTicketStmt = db.prepare(`
	INSERT INTO tickets (guild_id, number, opener_id, subject, created_at)
	VALUES (@guildId, @number, @openerId, @subject, @createdAt)
`);

// Reading MAX and inserting in one transaction is what stops two members
// pressing the button at the same moment from getting the same number —
// better-sqlite3 runs it synchronously, so nothing can interleave. The
// UNIQUE (guild_id, number) constraint backs that up.
const createTicketTx = db.transaction((guildId, openerId, subject) => {
	const { next } = nextNumberStmt.get(guildId);
	const createdAt = new Date().toISOString();
	const { lastInsertRowid } = insertTicketStmt.run({ guildId, number: next, openerId, subject, createdAt });
	return { id: Number(lastInsertRowid), guildId, number: next, threadId: null, openerId, subject, status: 'open', claimedBy: null, createdAt, closedAt: null, closedBy: null };
});

function createTicket(guildId, openerId, subject) {
	return createTicketTx(guildId, openerId, subject);
}

const attachThreadStmt = db.prepare('UPDATE tickets SET thread_id = ? WHERE id = ? AND guild_id = ?');

function attachThread(id, guildId, threadId) {
	attachThreadStmt.run(threadId, id, guildId);
}

// Only for a ticket whose thread could never be created, so the attempt
// leaves no row behind and its number is free for the next one.
const deleteUnstartedStmt = db.prepare('DELETE FROM tickets WHERE id = ? AND guild_id = ? AND thread_id IS NULL');

function discardUnstarted(id, guildId) {
	return deleteUnstartedStmt.run(id, guildId).changes > 0;
}

// guild_id is in the WHERE on both lookups. The thread one is always the
// channel a command was run in, which is safe on its own, but the number one
// comes from a typed option (/ticket reopen) — WorkingAgreements.md § 2.
const selectByThreadStmt = db.prepare('SELECT * FROM tickets WHERE thread_id = ? AND guild_id = ?');

function getByThread(threadId, guildId) {
	return mapTicket(selectByThreadStmt.get(threadId, guildId));
}

const selectByNumberStmt = db.prepare('SELECT * FROM tickets WHERE number = ? AND guild_id = ?');

function getByNumber(number, guildId) {
	return mapTicket(selectByNumberStmt.get(number, guildId));
}

const listByStatusStmt = db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND status = ? ORDER BY number DESC LIMIT ?');
const listAllStmt = db.prepare('SELECT * FROM tickets WHERE guild_id = ? ORDER BY number DESC LIMIT ?');

// Newest first. status is 'open', 'closed', or null for both.
function listTickets(guildId, status, limit) {
	const rows = status ? listByStatusStmt.all(guildId, status, limit) : listAllStmt.all(guildId, limit);
	return rows.map(mapTicket);
}

const countOpenStmt = db.prepare("SELECT COUNT(*) AS count FROM tickets WHERE guild_id = ? AND status = 'open'");

function countOpen(guildId) {
	return countOpenStmt.get(guildId).count;
}

// The status conditions make closing and reopening one-time claims, like
// ending a giveaway: if the Close button and /ticket close race, only the
// first gets `true` and posts the closing message.
const closeStmt = db.prepare(`
	UPDATE tickets SET status = 'closed', closed_at = @closedAt, closed_by = @closedBy
	WHERE id = @id AND guild_id = @guildId AND status = 'open'
`);

// closedBy is null when nobody closed it through the bot (the thread was
// deleted by hand).
function closeTicket(id, guildId, closedBy) {
	return closeStmt.run({ id, guildId, closedBy, closedAt: new Date().toISOString() }).changes > 0;
}

const reopenStmt = db.prepare(`
	UPDATE tickets SET status = 'open', closed_at = NULL, closed_by = NULL
	WHERE id = ? AND guild_id = ? AND status = 'closed'
`);

function reopenTicket(id, guildId) {
	return reopenStmt.run(id, guildId).changes > 0;
}

const setClaimStmt = db.prepare('UPDATE tickets SET claimed_by = ? WHERE id = ? AND guild_id = ?');

// userId null unclaims.
function setClaim(id, guildId, userId) {
	return setClaimStmt.run(userId, id, guildId).changes > 0;
}

module.exports = {
	getConfig,
	setConfig,
	clearConfig,
	createTicket,
	attachThread,
	discardUnstarted,
	getByThread,
	getByNumber,
	listTickets,
	countOpen,
	closeTicket,
	reopenTicket,
	setClaim,
};
