const db = require('./db');

// A guild's /bannedwords configuration: the ready-made lists it picked and
// its own custom words. Whether it's switched on is in guild_settings (see
// state/guildSettings.js). The AutoMod rules built from this live in Discord —
// see lib/bannedWords.js.

const insertListStmt = db.prepare('INSERT OR IGNORE INTO banned_word_lists (guild_id, list_key) VALUES (?, ?)');

function addList(guildId, listKey) {
	return insertListStmt.run(guildId, listKey).changes > 0;
}

const deleteListStmt = db.prepare('DELETE FROM banned_word_lists WHERE guild_id = ? AND list_key = ?');

function removeList(guildId, listKey) {
	return deleteListStmt.run(guildId, listKey).changes > 0;
}

const selectListsStmt = db.prepare('SELECT list_key FROM banned_word_lists WHERE guild_id = ? ORDER BY list_key');

function listLists(guildId) {
	return selectListsStmt.all(guildId).map((row) => row.list_key);
}

const insertWordStmt = db.prepare('INSERT OR IGNORE INTO banned_words (guild_id, word, added_at) VALUES (?, ?, ?)');

// Returns how many were new — a word already on the list is a harmless
// no-op, so the command can say "3 added, 1 already there".
const addWords = db.transaction((guildId, words) => {
	const now = new Date().toISOString();
	let added = 0;
	for (const word of words) added += insertWordStmt.run(guildId, word, now).changes;
	return added;
});

// The word comes from a free-typed string option, but guild_id is half the
// primary key, so it can only ever match this guild's own words.
const deleteWordStmt = db.prepare('DELETE FROM banned_words WHERE guild_id = ? AND word = ?');

function removeWord(guildId, word) {
	return deleteWordStmt.run(guildId, word).changes > 0;
}

const selectWordsStmt = db.prepare('SELECT word FROM banned_words WHERE guild_id = ? ORDER BY word');

function listWords(guildId) {
	return selectWordsStmt.all(guildId).map((row) => row.word);
}

const countWordsStmt = db.prepare('SELECT COUNT(*) AS count FROM banned_words WHERE guild_id = ?');

function countWords(guildId) {
	return countWordsStmt.get(guildId).count;
}

module.exports = {
	addList,
	removeList,
	listLists,
	addWords,
	removeWord,
	listWords,
	countWords,
};
