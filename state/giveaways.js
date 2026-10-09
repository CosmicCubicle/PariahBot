const db = require('./db');

function mapGiveaway(row) {
	if (!row) return null;
	return {
		id: row.giveaway_id,
		guildId: row.guild_id,
		channelId: row.channel_id,
		messageId: row.message_id,
		prize: row.prize,
		winnerCount: row.winner_count,
		endsAt: row.ends_at,
		createdBy: row.created_by,
		status: row.status,
	};
}

const insertGiveawayStmt = db.prepare(`
	INSERT INTO giveaways (giveaway_id, guild_id, channel_id, prize, winner_count, ends_at, created_by)
	VALUES (@id, @guildId, @channelId, @prize, @winnerCount, @endsAt, @createdBy)
`);

function create(giveaway) {
	const { id, guildId, channelId, prize, winnerCount, endsAt, createdBy } = giveaway;
	insertGiveawayStmt.run({ id, guildId, channelId, prize, winnerCount, endsAt, createdBy });
}

// The giveaway row is written before its message is posted (the message
// needs the ID for its button), so the message ID is attached afterwards.
const setMessageStmt = db.prepare('UPDATE giveaways SET message_id = ? WHERE giveaway_id = ? AND guild_id = ?');

function attachMessage(id, guildId, messageId) {
	setMessageStmt.run(messageId, id, guildId);
}

// guild_id is in the WHERE because the ID can come from a free-typed string
// option (/giveaway end) — see WorkingAgreements.md § 2.
const selectGiveawayStmt = db.prepare('SELECT * FROM giveaways WHERE giveaway_id = ? AND guild_id = ?');

function get(id, guildId) {
	return mapGiveaway(selectGiveawayStmt.get(id, guildId));
}

const selectActiveStmt = db.prepare("SELECT * FROM giveaways WHERE status = 'active'");

// Every guild at once: used at startup to reschedule each giveaway's end
// timer — see lib/giveaways.js.
function listActiveGiveaways() {
	return selectActiveStmt.all().map(mapGiveaway);
}

const insertEntryStmt = db.prepare(`
	INSERT OR IGNORE INTO giveaway_entries (giveaway_id, user_id, entered_at)
	VALUES (?, ?, ?)
`);

// False when this member had already entered.
function enter(id, userId) {
	return insertEntryStmt.run(id, userId, new Date().toISOString()).changes > 0;
}

const selectEntriesStmt = db.prepare('SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?');

function getEntries(id) {
	return selectEntriesStmt.all(id).map((entry) => entry.user_id);
}

// The status condition makes ending a giveaway a one-time claim: if the timer
// and /giveaway end race, only the first gets `true` and announces winners.
const finishGiveawayStmt = db.prepare("UPDATE giveaways SET status = 'ended' WHERE giveaway_id = ? AND status = 'active'");

function finish(id) {
	return finishGiveawayStmt.run(id).changes > 0;
}

module.exports = { create, attachMessage, get, listActiveGiveaways, enter, getEntries, finish };
