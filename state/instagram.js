const db = require('./db');

// How long an announced post is remembered. The poller only looks at posts
// from the last 7 days (see lib/instagramAlerts.js), so a post can't come
// round again once it's pruned.
const ANNOUNCEMENT_RETENTION_DAYS = 30;

function mapAccount(row) {
	if (!row) return null;
	return {
		guildId: row.guild_id,
		accountId: row.account_id,
		username: row.username,
		addedAt: row.added_at,
	};
}

// Re-adding an account that's already on the list keeps its added_at, so it
// never starts announcing posts from before it was first added.
const upsertAccountStmt = db.prepare(`
	INSERT INTO instagram_accounts (guild_id, account_id, username, added_at)
	VALUES (@guildId, @accountId, @username, @addedAt)
	ON CONFLICT(guild_id, account_id) DO UPDATE SET username = excluded.username
`);

function addAccount(guildId, accountId, username) {
	upsertAccountStmt.run({ guildId, accountId, username, addedAt: new Date().toISOString() });
}

// guild_id is in the WHERE because the account comes from a free-typed string
// option — see WorkingAgreements.md § 2. It matches either the account ID
// (what autocomplete submits) or the username, ignoring case.
const deleteAccountStmt = db.prepare(`
	DELETE FROM instagram_accounts
	WHERE guild_id = @guildId AND (account_id = @account OR username = @account COLLATE NOCASE)
`);

function removeAccount(guildId, account) {
	return deleteAccountStmt.run({ guildId, account }).changes > 0;
}

const selectAccountStmt = db.prepare('SELECT * FROM instagram_accounts WHERE guild_id = ? AND account_id = ?');

function getAccount(guildId, accountId) {
	return mapAccount(selectAccountStmt.get(guildId, accountId));
}

const selectAccountsForGuildStmt = db.prepare('SELECT * FROM instagram_accounts WHERE guild_id = ? ORDER BY username');

function listAccountsForGuild(guildId) {
	return selectAccountsForGuildStmt.all(guildId).map(mapAccount);
}

const selectAllAccountsStmt = db.prepare('SELECT * FROM instagram_accounts ORDER BY account_id, guild_id');

// Every guild at once: the poller asks Instagram once per account, however
// many guilds follow it — see lib/instagramAlerts.js.
function listAllAccounts() {
	return selectAllAccountsStmt.all().map(mapAccount);
}

const selectAnnouncedStmt = db.prepare('SELECT 1 FROM instagram_announcements WHERE guild_id = ? AND media_id = ?');

function isAnnounced(guildId, mediaId) {
	return selectAnnouncedStmt.get(guildId, mediaId) !== undefined;
}

const insertAnnouncementStmt = db.prepare('INSERT OR IGNORE INTO instagram_announcements (guild_id, media_id, announced_at) VALUES (?, ?, ?)');

function markAnnounced(guildId, mediaId) {
	insertAnnouncementStmt.run(guildId, mediaId, new Date().toISOString());
}

const pruneAnnouncementsStmt = db.prepare('DELETE FROM instagram_announcements WHERE announced_at < ?');

function pruneAnnouncements() {
	const cutoff = new Date(Date.now() - (ANNOUNCEMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000)).toISOString();
	return pruneAnnouncementsStmt.run(cutoff).changes;
}

module.exports = {
	addAccount,
	removeAccount,
	getAccount,
	listAccountsForGuild,
	listAllAccounts,
	isAnnounced,
	markAnnounced,
	pruneAnnouncements,
};
