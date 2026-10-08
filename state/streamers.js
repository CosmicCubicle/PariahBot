const db = require('./db');

function mapLink(row) {
	if (!row) return null;
	return {
		guildId: row.guild_id,
		userId: row.user_id,
		twitchUserId: row.twitch_user_id,
		twitchLogin: row.twitch_login,
		lastStreamId: row.last_stream_id,
	};
}

// Re-linking (a member switching to a different Twitch account) resets
// last_stream_id: it belonged to the old account's broadcasts, so keeping it
// could only ever suppress an alert that should fire.
const upsertLinkStmt = db.prepare(`
	INSERT INTO streamer_links (guild_id, user_id, twitch_user_id, twitch_login, last_stream_id)
	VALUES (@guildId, @userId, @twitchUserId, @twitchLogin, NULL)
	ON CONFLICT(guild_id, user_id) DO UPDATE SET
		twitch_user_id = excluded.twitch_user_id,
		twitch_login = excluded.twitch_login,
		last_stream_id = NULL
`);

// Throws (SqliteError, unique constraint) if another member of this guild has
// already linked the same Twitch account — the command layer checks for that
// first with getLinkByTwitch so it can name who.
function setLink(guildId, userId, twitchUserId, twitchLogin) {
	upsertLinkStmt.run({ guildId, userId, twitchUserId, twitchLogin });
}

const deleteLinkStmt = db.prepare('DELETE FROM streamer_links WHERE guild_id = ? AND user_id = ?');

function removeLink(guildId, userId) {
	return deleteLinkStmt.run(guildId, userId).changes > 0;
}

const selectLinkStmt = db.prepare('SELECT * FROM streamer_links WHERE guild_id = ? AND user_id = ?');

function getLink(guildId, userId) {
	return mapLink(selectLinkStmt.get(guildId, userId));
}

const selectLinkByTwitchStmt = db.prepare('SELECT * FROM streamer_links WHERE guild_id = ? AND twitch_user_id = ?');

function getLinkByTwitch(guildId, twitchUserId) {
	return mapLink(selectLinkByTwitchStmt.get(guildId, twitchUserId));
}

const selectLinksForGuildStmt = db.prepare('SELECT * FROM streamer_links WHERE guild_id = ? ORDER BY twitch_login');

function listLinksForGuild(guildId) {
	return selectLinksForGuildStmt.all(guildId).map(mapLink);
}

const selectAllLinksStmt = db.prepare('SELECT * FROM streamer_links ORDER BY guild_id, user_id');

// Every guild at once: the poller batches one Twitch request across all of
// them rather than one per guild — see lib/streamAlerts.js.
function listAllLinks() {
	return selectAllLinksStmt.all().map(mapLink);
}

const setLastStreamStmt = db.prepare('UPDATE streamer_links SET last_stream_id = ? WHERE guild_id = ? AND user_id = ?');

function setLastStreamId(guildId, userId, streamId) {
	setLastStreamStmt.run(streamId, guildId, userId);
}

// Keeps the stored login current when a streamer renames their Twitch account,
// so /streamers list and the alert link don't point at a dead name.
const setLoginStmt = db.prepare('UPDATE streamer_links SET twitch_login = ? WHERE guild_id = ? AND user_id = ?');

function setTwitchLogin(guildId, userId, twitchLogin) {
	setLoginStmt.run(twitchLogin, guildId, userId);
}

module.exports = {
	setLink,
	removeLink,
	getLink,
	getLinkByTwitch,
	listLinksForGuild,
	listAllLinks,
	setLastStreamId,
	setTwitchLogin,
};
