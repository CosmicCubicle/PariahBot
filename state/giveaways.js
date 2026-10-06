const db = require('./db');

const insertGiveaway = db.prepare(`
	INSERT INTO giveaways (giveaway_id, guild_id, channel_id, prize, winner_count, ends_at, created_by)
	VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const setMessage = db.prepare('UPDATE giveaways SET message_id = ? WHERE giveaway_id = ? AND guild_id = ?');
const getGiveaway = db.prepare('SELECT * FROM giveaways WHERE giveaway_id = ? AND guild_id = ?');
const listActive = db.prepare("SELECT * FROM giveaways WHERE status = 'active'");
const enterGiveaway = db.prepare(`
	INSERT OR IGNORE INTO giveaway_entries (giveaway_id, user_id, entered_at)
	VALUES (?, ?, ?)
`);
const listEntries = db.prepare('SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?');
const finishGiveaway = db.prepare("UPDATE giveaways SET status = 'ended' WHERE giveaway_id = ? AND status = 'active'");

function create(giveaway) {
	insertGiveaway.run(giveaway.id, giveaway.guildId, giveaway.channelId, giveaway.prize, giveaway.winnerCount, giveaway.endsAt, giveaway.createdBy);
}

function attachMessage(id, guildId, messageId) {
	setMessage.run(messageId, id, guildId);
}

function get(id, guildId) {
	return getGiveaway.get(id, guildId);
}

function listActiveGiveaways() {
	return listActive.all();
}

function enter(id, userId) {
	return enterGiveaway.run(id, userId, new Date().toISOString()).changes > 0;
}

function getEntries(id) {
	return listEntries.all(id).map((entry) => entry.user_id);
}

function finish(id) {
	return finishGiveaway.run(id).changes > 0;
}

module.exports = { create, attachMessage, get, listActiveGiveaways, enter, getEntries, finish };