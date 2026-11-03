const { Events } = require('discord.js');
const { handleChannelDelete } = require('../lib/tickets');

module.exports = {
	name: Events.ChannelDelete,
	async execute(channel) {
		await handleChannelDelete(channel).catch((error) => {
			console.error(`Tickets: channel delete handling failed for ${channel.id}:`, error.message);
		});
	},
};
