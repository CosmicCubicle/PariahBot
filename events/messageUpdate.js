const { Events } = require('discord.js');
const { handleMessageUpdate } = require('../lib/serverLog');

module.exports = {
	name: Events.MessageUpdate,
	// The server log's message edits (#81).
	async execute(oldMessage, newMessage) {
		await handleMessageUpdate(oldMessage, newMessage).catch((error) => {
			console.error(`ServerLog: failed to log an edit in channel ${newMessage.channelId}:`, error.message);
		});
	},
};
