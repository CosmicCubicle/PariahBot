const db = require('./db');

// How long an announcement is remembered after it was last seen. Uploads are
// only seen once, and the feed check only looks at videos from the last 7
// days, so they can't come round again. Live items are re-seen every poll
// while they're still live (see touchAnnouncement), so even a stream that
// runs for months stays remembered until 30 days after it ends.
const ANNOUNCEMENT_RETENTION_DAYS = 30;

function mapLink(row) {
	if (!row) return null;
	return {
		guildId: row.guild_id,
		platform: row.platform,
		accountId: row.account_id,
		accountName: row.account_name,
		userId: row.user_id,
		manual: !!row.manual,
		addedAt: row.added_at,
	};
}

// A member's own link (/streamers link). If an admin already added this
// account, the member is attached to that row and its manual flag and
// added_at are kept — self-linking never downgrades an admin-added streamer
// into one that needs the streamer role, and never resets which uploads
// count as new.
const upsertSelfLinkStmt = db.prepare(`
	INSERT INTO streamer_links (guild_id, platform, account_id, account_name, user_id, manual, added_at)
	VALUES (@guildId, @platform, @accountId, @accountName, @userId, 0, @addedAt)
	ON CONFLICT(guild_id, platform, account_id) DO UPDATE SET
		account_name = excluded.account_name,
		user_id = excluded.user_id
`);

// A member has at most one self-link per platform per guild, so linking a
// new account drops their previous one on that platform. Admin-added rows
// are left alone: only an admin removes those.
const deleteOtherSelfLinksStmt = db.prepare(`
	DELETE FROM streamer_links
	WHERE guild_id = ? AND platform = ? AND user_id = ? AND manual = 0 AND account_id != ?
`);

const setSelfLink = db.transaction((guildId, platform, userId, accountId, accountName) => {
	deleteOtherSelfLinksStmt.run(guildId, platform, userId, accountId);
	upsertSelfLinkStmt.run({ guildId, platform, userId, accountId, accountName, addedAt: new Date().toISOString() });
});

// An admin's add (/streamers add). Always marks the row manual. A member is
// optional: when given it replaces whoever the row was attached to, when
// omitted any existing attachment is kept.
const upsertManualStmt = db.prepare(`
	INSERT INTO streamer_links (guild_id, platform, account_id, account_name, user_id, manual, added_at)
	VALUES (@guildId, @platform, @accountId, @accountName, @userId, 1, @addedAt)
	ON CONFLICT(guild_id, platform, account_id) DO UPDATE SET
		account_name = excluded.account_name,
		user_id = COALESCE(excluded.user_id, streamer_links.user_id),
		manual = 1
`);

function addManual(guildId, platform, accountId, accountName, userId) {
	upsertManualStmt.run({ guildId, platform, accountId, accountName, userId: userId ?? null, addedAt: new Date().toISOString() });
}

// /streamers unlink: the member's own links only, never an admin-added row.
// platform is optional — omitted, it unlinks every platform.
const deleteSelfLinksStmt = db.prepare(`
	DELETE FROM streamer_links
	WHERE guild_id = @guildId AND user_id = @userId AND manual = 0
		AND (@platform IS NULL OR platform = @platform)
`);

function removeSelfLinks(guildId, userId, platform) {
	return deleteSelfLinksStmt.run({ guildId, userId, platform: platform ?? null }).changes;
}

const deleteByMemberStmt = db.prepare('DELETE FROM streamer_links WHERE guild_id = ? AND user_id = ?');

// /streamers remove member: every row attached to that member, on every
// platform, self-linked or admin-added.
function removeByMember(guildId, userId) {
	return deleteByMemberStmt.run(guildId, userId).changes;
}

// guild_id is in the WHERE because the account comes from a free-typed
// string option — see WorkingAgreements.md § 2. It matches either the
// permanent ID (what autocomplete submits) or the display name, ignoring
// case, since people type names however they like.
const deleteByAccountStmt = db.prepare(`
	DELETE FROM streamer_links
	WHERE guild_id = @guildId AND platform = @platform
		AND (account_id = @account OR account_name = @account COLLATE NOCASE)
`);

function removeByAccount(guildId, platform, account) {
	return deleteByAccountStmt.run({ guildId, platform, account }).changes > 0;
}

const selectLinkStmt = db.prepare('SELECT * FROM streamer_links WHERE guild_id = ? AND platform = ? AND account_id = ?');

function getLink(guildId, platform, accountId) {
	return mapLink(selectLinkStmt.get(guildId, platform, accountId));
}

const selectLinksForMemberStmt = db.prepare('SELECT * FROM streamer_links WHERE guild_id = ? AND user_id = ? ORDER BY platform, account_name');

function listLinksForMember(guildId, userId) {
	return selectLinksForMemberStmt.all(guildId, userId).map(mapLink);
}

const selectLinksForGuildStmt = db.prepare('SELECT * FROM streamer_links WHERE guild_id = ? ORDER BY platform, account_name');

function listLinksForGuild(guildId) {
	return selectLinksForGuildStmt.all(guildId).map(mapLink);
}

const selectLinksForPlatformStmt = db.prepare('SELECT * FROM streamer_links WHERE platform = ? ORDER BY guild_id, account_id');

// Every guild at once: the poller batches requests across all of them rather
// than one per guild — see lib/streamAlerts.js.
function listLinksForPlatform(platform) {
	return selectLinksForPlatformStmt.all(platform).map(mapLink);
}

// Keeps the stored name current when a streamer renames their channel, so
// /streamers list, removal by name and alert text don't use a dead name.
const setNameStmt = db.prepare('UPDATE streamer_links SET account_name = ? WHERE guild_id = ? AND platform = ? AND account_id = ?');

function setAccountName(guildId, platform, accountId, accountName) {
	setNameStmt.run(accountName, guildId, platform, accountId);
}

const selectAnnouncedStmt = db.prepare('SELECT 1 FROM stream_announcements WHERE guild_id = ? AND platform = ? AND content_id = ? AND kind = ?');

function isAnnounced(guildId, platform, contentId, kind) {
	return selectAnnouncedStmt.get(guildId, platform, contentId, kind) !== undefined;
}

const insertAnnouncementStmt = db.prepare(`
	INSERT OR IGNORE INTO stream_announcements (guild_id, platform, content_id, kind, announced_at, last_seen_at)
	VALUES (@guildId, @platform, @contentId, @kind, @now, @now)
`);

function markAnnounced(guildId, platform, contentId, kind) {
	insertAnnouncementStmt.run({ guildId, platform, contentId, kind, now: new Date().toISOString() });
}

const touchAnnouncementStmt = db.prepare(`
	UPDATE stream_announcements SET last_seen_at = ?
	WHERE guild_id = ? AND platform = ? AND content_id = ? AND kind = ?
`);

// Called whenever a poll sees something it has already announced — a stream
// that's still live. Keeps the record from being pruned mid-stream.
function touchAnnouncement(guildId, platform, contentId, kind) {
	touchAnnouncementStmt.run(new Date().toISOString(), guildId, platform, contentId, kind);
}

// COALESCE covers rows written before last_seen_at existed.
const pruneAnnouncementsStmt = db.prepare('DELETE FROM stream_announcements WHERE COALESCE(last_seen_at, announced_at) < ?');

function pruneAnnouncements() {
	const cutoff = new Date(Date.now() - (ANNOUNCEMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000)).toISOString();
	return pruneAnnouncementsStmt.run(cutoff).changes;
}

module.exports = {
	setSelfLink,
	addManual,
	removeSelfLinks,
	removeByMember,
	removeByAccount,
	getLink,
	listLinksForMember,
	listLinksForGuild,
	listLinksForPlatform,
	setAccountName,
	isAnnounced,
	markAnnounced,
	touchAnnouncement,
	pruneAnnouncements,
};
