const db = require('./db');

function mapChannel(row) {
	if (!row) return null;
	return {
		channelId: row.channel_id,
		guildId: row.guild_id,
		maxMessages: row.max_messages,
		liveSeconds: row.live_seconds,
	};
}

const upsertChannelStmt = db.prepare(`
	INSERT INTO autodelete_channels (channel_id, guild_id, max_messages, live_seconds)
	VALUES (@channelId, @guildId, @maxMessages, @liveSeconds)
	ON CONFLICT(channel_id) DO UPDATE SET
		max_messages = excluded.max_messages,
		live_seconds = excluded.live_seconds
`);

function setChannel(channelId, guildId, maxMessages, liveSeconds) {
	upsertChannelStmt.run({ channelId, guildId, maxMessages, liveSeconds });
}

const deleteChannelStmt = db.prepare('DELETE FROM autodelete_channels WHERE channel_id = ?');

function removeChannel(channelId) {
	return deleteChannelStmt.run(channelId).changes > 0;
}

const selectChannelStmt = db.prepare('SELECT * FROM autodelete_channels WHERE channel_id = ?');

function getChannel(channelId) {
	return mapChannel(selectChannelStmt.get(channelId));
}

const selectAllChannelsStmt = db.prepare('SELECT * FROM autodelete_channels ORDER BY channel_id');

// Used at startup to seed tracking for every configured channel across every
// guild — see lib/autoDelete.js.
function listAllChannels() {
	return selectAllChannelsStmt.all().map(mapChannel);
}

module.exports = {
	setChannel,
	removeChannel,
	getChannel,
	listAllChannels,
};
