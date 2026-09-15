const db = require('./db');

function mapHub(row) {
	if (!row) return null;
	return {
		channelId: row.channel_id,
		guildId: row.guild_id,
		categoryId: row.category_id,
		overflowCategoryId: row.overflow_category_id,
		nameTemplate: row.name_template,
		defaultLimit: row.default_limit,
		minLimit: row.min_limit,
		maxLimit: row.max_limit,
	};
}

function mapTempChannel(row) {
	if (!row) return null;
	return {
		channelId: row.channel_id,
		guildId: row.guild_id,
		hubChannelId: row.hub_channel_id,
		ownerId: row.owner_id,
		createdAt: row.created_at,
		minLimit: row.min_limit,
		maxLimit: row.max_limit,
	};
}

const insertHubStmt = db.prepare(`
	INSERT INTO hubs (channel_id, guild_id, category_id, overflow_category_id, name_template, default_limit, min_limit, max_limit)
	VALUES (@channelId, @guildId, @categoryId, @overflowCategoryId, @nameTemplate, @defaultLimit, @minLimit, @maxLimit)
`);

// Defaults here mirror the schema's own column defaults (state/db.js) — spelled
// out in JS rather than left to SQL so every caller (the hub-create wizard,
// tests) can see exactly what "unconfigured" means without reading the schema.
// Throws (SqliteError, unique constraint) if channelId is already a hub; the
// command layer decides how to surface that to the admin.
function addHub(guildId, channelId, {
	categoryId = null,
	overflowCategoryId = null,
	nameTemplate = "🔊 {owner}'s channel",
	defaultLimit = 0,
	minLimit = 0,
	maxLimit = 99,
} = {}) {
	insertHubStmt.run({ guildId, channelId, categoryId, overflowCategoryId, nameTemplate, defaultLimit, minLimit, maxLimit });
}

const deleteHubStmt = db.prepare('DELETE FROM hubs WHERE channel_id = ?');

function removeHub(channelId) {
	return deleteHubStmt.run(channelId).changes > 0;
}

const selectHubStmt = db.prepare('SELECT * FROM hubs WHERE channel_id = ?');

function getHub(channelId) {
	return mapHub(selectHubStmt.get(channelId));
}

const selectHubsForGuildStmt = db.prepare('SELECT * FROM hubs WHERE guild_id = ? ORDER BY channel_id');

function listHubs(guildId) {
	return selectHubsForGuildStmt.all(guildId).map(mapHub);
}

// SQLite allows updating a PRIMARY KEY column's value directly (as long as it
// doesn't collide with an existing row), so "restoring" a dead hub under a new
// channel ID is a single UPDATE rather than a delete-then-reinsert — every other
// column (category, name template, limits) carries over unchanged automatically.
const migrateHubStmt = db.prepare('UPDATE hubs SET channel_id = ? WHERE channel_id = ?');

function migrateHubChannel(oldChannelId, newChannelId) {
	return migrateHubStmt.run(newChannelId, oldChannelId).changes > 0;
}

const insertTempChannelStmt = db.prepare(`
	INSERT INTO temp_channels (channel_id, guild_id, hub_channel_id, owner_id, created_at, min_limit, max_limit)
	VALUES (@channelId, @guildId, @hubChannelId, @ownerId, @createdAt, @minLimit, @maxLimit)
`);

function createTempChannel({ channelId, guildId, hubChannelId, ownerId, minLimit, maxLimit }) {
	insertTempChannelStmt.run({
		channelId,
		guildId,
		hubChannelId,
		ownerId,
		createdAt: new Date().toISOString(),
		minLimit,
		maxLimit,
	});
}

const deleteTempChannelStmt = db.prepare('DELETE FROM temp_channels WHERE channel_id = ?');

function removeTempChannel(channelId) {
	return deleteTempChannelStmt.run(channelId).changes > 0;
}

const selectTempChannelStmt = db.prepare('SELECT * FROM temp_channels WHERE channel_id = ?');

function getTempChannel(channelId) {
	return mapTempChannel(selectTempChannelStmt.get(channelId));
}

function isTempChannel(channelId) {
	return getTempChannel(channelId) !== null;
}

const setTempChannelOwnerStmt = db.prepare('UPDATE temp_channels SET owner_id = ? WHERE channel_id = ?');

// Used by /vc claim and /vc transfer — the command layer also has to move the
// channel's actual permission overwrites (see commands/vc.js), this only
// updates who our own tracking says owns it.
function setTempChannelOwner(channelId, newOwnerId) {
	return setTempChannelOwnerStmt.run(newOwnerId, channelId).changes > 0;
}

const selectTempChannelsForGuildStmt = db.prepare('SELECT * FROM temp_channels WHERE guild_id = ? ORDER BY channel_id');

function listTempChannelsForGuild(guildId) {
	return selectTempChannelsForGuildStmt.all(guildId).map(mapTempChannel);
}

module.exports = {
	addHub,
	removeHub,
	getHub,
	listHubs,
	createTempChannel,
	removeTempChannel,
	getTempChannel,
	isTempChannel,
	listTempChannelsForGuild,
	migrateHubChannel,
	setTempChannelOwner,
};
