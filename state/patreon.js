const db = require('./db');

// How long an announced post is remembered. The poller only looks at posts
// from the last 7 days (see lib/patreonAlerts.js), so a post can't come round
// again once it's pruned.
const ANNOUNCEMENT_RETENTION_DAYS = 30;

function mapCreator(row) {
	if (!row) return null;
	return {
		guildId: row.guild_id,
		campaignId: row.campaign_id,
		vanity: row.vanity,
		name: row.name,
		addedAt: row.added_at,
	};
}

// Re-adding a creator who's already on the list keeps its added_at, so it
// never starts announcing posts from before it was first added.
const upsertCreatorStmt = db.prepare(`
	INSERT INTO patreon_creators (guild_id, campaign_id, vanity, name, added_at)
	VALUES (@guildId, @campaignId, @vanity, @name, @addedAt)
	ON CONFLICT(guild_id, campaign_id) DO UPDATE SET vanity = excluded.vanity, name = excluded.name
`);

function addCreator(guildId, campaignId, vanity, name) {
	upsertCreatorStmt.run({ guildId, campaignId, vanity, name, addedAt: new Date().toISOString() });
}

// guild_id is in the WHERE because the creator comes from a free-typed string
// option — see WorkingAgreements.md § 2. It matches either the campaign ID
// (what autocomplete submits) or the patreon.com name, ignoring case.
const deleteCreatorStmt = db.prepare(`
	DELETE FROM patreon_creators
	WHERE guild_id = @guildId AND (campaign_id = @creator OR vanity = @creator COLLATE NOCASE)
`);

function removeCreator(guildId, creator) {
	return deleteCreatorStmt.run({ guildId, creator }).changes > 0;
}

const selectCreatorStmt = db.prepare('SELECT * FROM patreon_creators WHERE guild_id = ? AND campaign_id = ?');

function getCreator(guildId, campaignId) {
	return mapCreator(selectCreatorStmt.get(guildId, campaignId));
}

const selectCreatorsForGuildStmt = db.prepare('SELECT * FROM patreon_creators WHERE guild_id = ? ORDER BY name COLLATE NOCASE');

function listCreatorsForGuild(guildId) {
	return selectCreatorsForGuildStmt.all(guildId).map(mapCreator);
}

const selectAllCreatorsStmt = db.prepare('SELECT * FROM patreon_creators ORDER BY campaign_id, guild_id');

// Every guild at once: the poller asks Patreon once per creator, however many
// guilds follow it — see lib/patreonAlerts.js.
function listAllCreators() {
	return selectAllCreatorsStmt.all().map(mapCreator);
}

const selectAnnouncedStmt = db.prepare('SELECT 1 FROM patreon_announcements WHERE guild_id = ? AND post_id = ?');

function isAnnounced(guildId, postId) {
	return selectAnnouncedStmt.get(guildId, postId) !== undefined;
}

const insertAnnouncementStmt = db.prepare('INSERT OR IGNORE INTO patreon_announcements (guild_id, post_id, announced_at) VALUES (?, ?, ?)');

function markAnnounced(guildId, postId) {
	insertAnnouncementStmt.run(guildId, postId, new Date().toISOString());
}

const pruneAnnouncementsStmt = db.prepare('DELETE FROM patreon_announcements WHERE announced_at < ?');

function pruneAnnouncements() {
	const cutoff = new Date(Date.now() - (ANNOUNCEMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000)).toISOString();
	return pruneAnnouncementsStmt.run(cutoff).changes;
}

module.exports = {
	addCreator,
	removeCreator,
	getCreator,
	listCreatorsForGuild,
	listAllCreators,
	isAnnounced,
	markAnnounced,
	pruneAnnouncements,
};
