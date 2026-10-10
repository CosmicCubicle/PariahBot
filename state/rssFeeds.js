const db = require('./db');

// /rss feeds and the items each has already posted. The feeds are fetched and
// posted by lib/rssAlerts.js.

// How long an item is remembered after it drops out of its feed. Long enough
// that a feed briefly shuffling an old item back in doesn't repost it.
const ITEM_RETENTION_DAYS = 30;

function mapFeed(row) {
	if (!row) return null;
	return {
		id: row.id,
		guildId: row.guild_id,
		url: row.url,
		title: row.title,
		channelId: row.channel_id,
		roleId: row.role_id,
		message: row.message,
		addedAt: row.added_at,
		lastCheckedAt: row.last_checked_at,
		lastError: row.last_error,
	};
}

const insertFeedStmt = db.prepare(`
	INSERT INTO rss_feeds (guild_id, url, title, channel_id, role_id, message, added_at, last_checked_at)
	VALUES (@guildId, @url, @title, @channelId, @roleId, @message, @now, @now)
`);

const markSeenStmt = db.prepare(`
	INSERT INTO rss_items (feed_id, item_id, last_seen_at) VALUES (?, ?, ?)
	ON CONFLICT(feed_id, item_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
`);

// Adds the feed and records the items it already has in one go, so a crash
// in between can't leave a feed that would post its whole back catalogue.
const addFeed = db.transaction(({ guildId, url, title, channelId, roleId, message, itemIds }) => {
	const now = new Date().toISOString();
	const { lastInsertRowid } = insertFeedStmt.run({ guildId, url, title, channelId, roleId: roleId ?? null, message: message ?? null, now });
	for (const itemId of itemIds) markSeenStmt.run(lastInsertRowid, itemId, now);
	return Number(lastInsertRowid);
});

// guild_id is in every lookup below because the feed comes from a free-typed
// string option — see WorkingAgreements.md § 2.
const selectFeedStmt = db.prepare('SELECT * FROM rss_feeds WHERE id = ? AND guild_id = ?');

function getFeed(guildId, feedId) {
	return mapFeed(selectFeedStmt.get(feedId, guildId));
}

const selectFeedByUrlStmt = db.prepare('SELECT * FROM rss_feeds WHERE guild_id = ? AND url = ?');

function getFeedByUrl(guildId, url) {
	return mapFeed(selectFeedByUrlStmt.get(guildId, url));
}

// rss_items rows go with it (ON DELETE CASCADE).
const deleteFeedStmt = db.prepare('DELETE FROM rss_feeds WHERE id = ? AND guild_id = ?');

function removeFeed(guildId, feedId) {
	return deleteFeedStmt.run(feedId, guildId).changes > 0;
}

const selectFeedsForGuildStmt = db.prepare('SELECT * FROM rss_feeds WHERE guild_id = ? ORDER BY title COLLATE NOCASE');

function listFeedsForGuild(guildId) {
	return selectFeedsForGuildStmt.all(guildId).map(mapFeed);
}

const countFeedsStmt = db.prepare('SELECT COUNT(*) AS count FROM rss_feeds WHERE guild_id = ?');

function countFeeds(guildId) {
	return countFeedsStmt.get(guildId).count;
}

const selectAllFeedsStmt = db.prepare('SELECT * FROM rss_feeds ORDER BY url, guild_id');

// Every guild at once: the poller fetches each URL once, however many guilds
// follow it.
function listAllFeeds() {
	return selectAllFeedsStmt.all().map(mapFeed);
}

const updateStatusStmt = db.prepare(`
	UPDATE rss_feeds SET title = COALESCE(@title, title), last_checked_at = @now, last_error = @error
	WHERE id = @feedId
`);

// After each check: the feed's current title (feeds rename), when it was
// checked, and the error if it failed (null clears it).
function setFeedStatus(feedId, { title = null, error = null }) {
	updateStatusStmt.run({ feedId, title, error, now: new Date().toISOString() });
}

const selectSeenStmt = db.prepare('SELECT item_id FROM rss_items WHERE feed_id = ?');

function listSeenItemIds(feedId) {
	return new Set(selectSeenStmt.all(feedId).map((row) => row.item_id));
}

// Records the items a feed shows right now: new ones are added, and ones
// still present have last_seen_at refreshed so they're never pruned while
// the feed still lists them.
const markItemsSeen = db.transaction((feedId, itemIds) => {
	const now = new Date().toISOString();
	for (const itemId of itemIds) markSeenStmt.run(feedId, itemId, now);
});

const pruneItemsStmt = db.prepare('DELETE FROM rss_items WHERE last_seen_at < ?');

function pruneItems() {
	const cutoff = new Date(Date.now() - (ITEM_RETENTION_DAYS * 24 * 60 * 60 * 1000)).toISOString();
	return pruneItemsStmt.run(cutoff).changes;
}

module.exports = {
	addFeed,
	getFeed,
	getFeedByUrl,
	removeFeed,
	listFeedsForGuild,
	countFeeds,
	listAllFeeds,
	setFeedStatus,
	listSeenItemIds,
	markItemsSeen,
	pruneItems,
};
