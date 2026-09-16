const { Events } = require('discord.js');
const { isTracked, trackMessage, reapChannel } = require('../lib/autoDelete');
const { grantMessageXp } = require('../lib/leveling');

module.exports = {
	name: Events.MessageCreate,
	async execute(message) {
		if (message.inGuild() && !message.author.bot) {
			const result = grantMessageXp(message.guildId, message.author.id);
			if (result?.leveledUp) {
				await message.channel.send(`🎉 ${message.author} just reached level **${result.level}**!`).catch(() => null);
			}
		}

		if (!isTracked(message.channelId)) return;

		trackMessage(message);
		await reapChannel(message.channelId).catch((error) => {
			console.error(`AutoDelete: reap failed for channel ${message.channelId}:`, error.message);
		});
	},
};
