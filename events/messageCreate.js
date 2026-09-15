const { Events } = require('discord.js');
const { isTracked, trackMessage, reapChannel } = require('../lib/autoDelete');

module.exports = {
	name: Events.MessageCreate,
	async execute(message) {
		if (!isTracked(message.channelId)) return;

		trackMessage(message);
		await reapChannel(message.channelId).catch((error) => {
			console.error(`AutoDelete: reap failed for channel ${message.channelId}:`, error.message);
		});
	},
};
