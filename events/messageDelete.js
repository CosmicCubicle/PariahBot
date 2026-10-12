const { Events } = require('discord.js');
const { handleMessageDelete } = require('../lib/serverLog');

module.exports = {
	name: Events.MessageDelete,
	// The server log's message deletes (#81).
	async execute(message) {
		await handleMessageDelete(message).catch((error) => {
			console.error(`ServerLog: failed to log a deletion in channel ${message.channelId}:`, error.message);
		});
	},
};
