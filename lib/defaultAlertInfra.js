const { ChannelType } = require('discord.js');
const guildSettings = require('../state/guildSettings');

const DEFAULT_CHANNEL_NAME = 'bot-alerts';

// Creates the bot's alert channel, on an admin's explicit request only.
//
// There used to be an ensureDefaultAlertInfra() here, called from
// events/ready.js and events/guildCreate.js, which created a "PariahBot"
// category and a #bot-alerts channel in every server the bot was in. Nobody
// asked for either: they appeared at startup, or the moment the bot joined.
// That is what #92 removed — the bot never creates a channel unless someone
// asks it to, and a server with no alert destination is now simply a server
// with no alert destination (lib/alertDelivery.js says so out loud).
//
// It also no longer creates the category. The caller passes one that already
// exists, or none at all, in which case the channel is created at the top
// level — creating a category to put a channel in is the same thing #92
// forbids, one level up.
async function createDefaultAlertInfra(guild, category = null, name = DEFAULT_CHANNEL_NAME) {
	if (category && category.type !== ChannelType.GuildCategory) {
		throw new Error('That has to be a category, not a channel.');
	}

	const channel = await guild.channels.create({
		name,
		type: ChannelType.GuildText,
		parent: category?.id ?? undefined,
		reason: 'PariahBot alert channel, requested with /alerts restore-default',
	});

	guildSettings.setDefaultAlertInfra(guild.id, category?.id ?? null, channel.id);
	return channel;
}

module.exports = { createDefaultAlertInfra };
