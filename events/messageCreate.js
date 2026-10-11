const { Events } = require('discord.js');
const { isTracked, trackMessage, reapChannel } = require('../lib/autoDelete');
const { grantMessageXp } = require('../lib/leveling');
const { handleHoneypotMessage } = require('../lib/honeypot');
const features = require('../lib/features');

module.exports = {
	name: Events.MessageCreate,
	async execute(message) {
		// Each feature below is switched independently (#69), so they're checked
		// one at a time rather than behind a single gate — a guild with one off
		// must keep the others running. Null in a DM, where there's no guild to
		// hold a setting at all.
		const guildId = message.inGuild() ? message.guildId : null;

		// Honeypot first: if this channel is a trap, the author is on their way
		// out and there's no point tracking their message for auto-deletion.
		const trapped = guildId && features.isEnabled(guildId, 'honeypot')
			? await handleHoneypotMessage(message).catch((error) => {
				console.error(`Honeypot: failed handling message in ${message.channelId}:`, error.message);
				return false;
			})
			: false;
		if (trapped) return;

		if (guildId && !message.author.bot && features.isEnabled(guildId, 'leveling')) {
			const result = grantMessageXp(message.guildId, message.author.id);
			if (result?.leveledUp) {
				await message.channel.send(`🎉 ${message.author} just reached level **${result.level}**!`).catch(() => null);
			}
		}

		// Tracking is seeded per channel, so an off guild simply stops being
		// tracked from the next restart — this check is what makes it take
		// effect immediately, without discarding the channel's configuration.
		if (!isTracked(message.channelId)) return;
		if (guildId && !features.isEnabled(guildId, 'autoDelete')) return;

		trackMessage(message);
		await reapChannel(message.channelId).catch((error) => {
			console.error(`AutoDelete: reap failed for channel ${message.channelId}:`, error.message);
		});
	},
};
