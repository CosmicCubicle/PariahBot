const { Events } = require('discord.js');
const { handleMessageBulkDelete } = require('../lib/serverLog');

module.exports = {
	name: Events.MessageBulkDelete,
	// The server log's bulk deletes (#81): a purge, or a ban that removed
	// someone's recent messages. Logged as one entry per channel.
	async execute(messages, channel) {
		await handleMessageBulkDelete(messages, channel).catch((error) => {
			console.error(`ServerLog: failed to log a bulk delete in channel ${channel.id}:`, error.message);
		});
	},
};
