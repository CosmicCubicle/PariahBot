const { Events } = require('discord.js');
const { isTracked, trackMessage, reapChannel } = require('../lib/autoDelete');
const { handleHoneypotMessage } = require('../lib/honeypot');

module.exports = {
	name: Events.MessageCreate,
	async execute(message) {
		// Honeypot first: if this channel is a trap, the author is on their way
		// out and there's no point tracking their message for auto-deletion.
		const trapped = await handleHoneypotMessage(message).catch((error) => {
			console.error(`Honeypot: failed handling message in ${message.channelId}:`, error.message);
			return false;
		});
		if (trapped) return;

		if (!isTracked(message.channelId)) return;

		trackMessage(message);
		await reapChannel(message.channelId).catch((error) => {
			console.error(`AutoDelete: reap failed for channel ${message.channelId}:`, error.message);
		});
	},
};
