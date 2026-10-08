const db = require('./db');

function mapLink(row) {
	if (!row) return null;
	return {
		guildId: row.guild_id,
		twitchUserId: row.twitch_user_id,
		twitchLogin: row.twitch_login,
		userId: row.user_id,
		manual: !!row.manual,
		lastStreamId: row.last_stream_id,
	};
}

// A member's own link (/streamers link). If an admin already added this
// account, the member is attached to that row and its manual flag is kept —
// self-linking never downgrades an admin-added streamer into one that needs
// the streamer role. last_stream_id is kept too: it's the same account, so
// it still correctly says which broadcast was already announced.
const upsertSelfLinkStmt = db.prepare(`
	INSERT INTO streamer_links (guild_id, twitch_user_id, twitch_login, user_id, manual)
	VALUES (@guildId, @twitchUserId, @twitchLogin, @userId, 0)
	ON CONFLICT(guild_id, twitch_user_id) DO UPDATE SET
		twitch_login = excluded.twitch_login,
		user_id = excluded.user_id
`);

// A member has at most one self-link per guild, so linking a new account
// drops their previous one. Admin-added rows are left alone: only an admin
// removes those.
const deleteOtherSelfLinksStmt = db.prepare(`
	DELETE FROM streamer_links
	WHERE guild_id = ? AND user_id = ? AND manual = 0 AND twitch_user_id != ?
`);

const setSelfLink = db.transaction((guildId, userId, twitchUserId, twitchLogin) => {
	deleteOtherSelfLinksStmt.run(guildId, userId, twitchUserId);
	upsertSelfLinkStmt.run({ guildId, userId, twitchUserId, twitchLogin });
});

// An admin's add (/streamers add). Always marks the row manual. A member is
// optional: when given it replaces whoever the row was attached to, when
// omitted any existing attachment is kept.
const upsertManualStmt = db.prepare(`
	INSERT INTO streamer_links (guild_id, twitch_user_id, twitch_login, user_id, manual)
	VALUES (@guildId, @twitchUserId, @twitchLogin, @userId, 1)
	ON CONFLICT(guild_id, twitch_user_id) DO UPDATE SET
		twitch_login = excluded.twitch_login,
		user_id = COALESCE(excluded.user_id, streamer_links.user_id),
		manual = 1
`);

function addManual(guildId, twitchUserId, twitchLogin, userId) {
	upsertManualStmt.run({ guildId, twitchUserId, twitchLogin, userId: userId ?? null });
}

const deleteSelfLinksStmt = db.prepare('DELETE FROM streamer_links WHERE guild_id = ? AND user_id = ? AND manual = 0');

// /streamers unlink: the member's own link only, never an admin-added row.
function removeSelfLinks(guildId, userId) {
	return deleteSelfLinksStmt.run(guildId, userId).changes > 0;
}

const deleteByMemberStmt = db.prepare('DELETE FROM streamer_links WHERE guild_id = ? AND user_id = ?');

// /streamers remove member: every row attached to that member, self-linked
// or admin-added.
function removeByMember(guildId, userId) {
	return deleteByMemberStmt.run(guildId, userId).changes;
}

// guild_id is in the WHERE because the login comes from a free-typed string
// option — see WorkingAgreements.md § 2. Case-insensitive because Twitch
// logins are, and people type them however they like.
const deleteByLoginStmt = db.prepare('DELETE FROM streamer_links WHERE guild_id = ? AND twitch_login = ? COLLATE NOCASE');

function removeByLogin(guildId, twitchLogin) {
	return deleteByLoginStmt.run(guildId, twitchLogin).changes > 0;
}

const selectLinkByTwitchStmt = db.prepare('SELECT * FROM streamer_links WHERE guild_id = ? AND twitch_user_id = ?');

function getLinkByTwitch(guildId, twitchUserId) {
	return mapLink(selectLinkByTwitchStmt.get(guildId, twitchUserId));
}

const selectLinksForMemberStmt = db.prepare('SELECT * FROM streamer_links WHERE guild_id = ? AND user_id = ? ORDER BY twitch_login');

function listLinksForMember(guildId, userId) {
	return selectLinksForMemberStmt.all(guildId, userId).map(mapLink);
}

const selectLinksForGuildStmt = db.prepare('SELECT * FROM streamer_links WHERE guild_id = ? ORDER BY twitch_login');

function listLinksForGuild(guildId) {
	return selectLinksForGuildStmt.all(guildId).map(mapLink);
}

const selectAllLinksStmt = db.prepare('SELECT * FROM streamer_links ORDER BY guild_id, twitch_user_id');

// Every guild at once: the poller batches one Twitch request across all of
// them rather than one per guild — see lib/streamAlerts.js.
function listAllLinks() {
	return selectAllLinksStmt.all().map(mapLink);
}

const setLastStreamStmt = db.prepare('UPDATE streamer_links SET last_stream_id = ? WHERE guild_id = ? AND twitch_user_id = ?');

function setLastStreamId(guildId, twitchUserId, streamId) {
	setLastStreamStmt.run(streamId, guildId, twitchUserId);
}

// Keeps the stored login current when a streamer renames their Twitch account,
// so /streamers list, removal by name and the alert link don't use a dead name.
const setLoginStmt = db.prepare('UPDATE streamer_links SET twitch_login = ? WHERE guild_id = ? AND twitch_user_id = ?');

function setTwitchLogin(guildId, twitchUserId, twitchLogin) {
	setLoginStmt.run(twitchLogin, guildId, twitchUserId);
}

module.exports = {
	setSelfLink,
	addManual,
	removeSelfLinks,
	removeByMember,
	removeByLogin,
	getLinkByTwitch,
	listLinksForMember,
	listLinksForGuild,
	listAllLinks,
	setLastStreamId,
	setTwitchLogin,
};
