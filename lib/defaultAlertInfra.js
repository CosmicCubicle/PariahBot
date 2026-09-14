const { ChannelType } = require('discord.js');
const voiceStore = require('../state/voiceChannels');

const DEFAULT_CATEGORY_NAME = 'PariahBot';
const DEFAULT_CHANNEL_NAME = 'bot-alerts';

// The one place that actually creates the bot's default alert category/channel and
// records it — shared by ensureDefaultAlertInfra below and /voice setup alerts'
// restore-default option, so the two never drift apart.
async function createDefaultAlertInfra(guild) {
	const category = await guild.channels.create({ name: DEFAULT_CATEGORY_NAME, type: ChannelType.GuildCategory });
	const channel = await guild.channels.create({
		name: DEFAULT_CHANNEL_NAME,
		type: ChannelType.GuildText,
		parent: category.id,
	});
	voiceStore.setDefaultAlertInfra(guild.id, category.id, channel.id);
	return channel;
}

// Shared by events/ready.js (sweeps every guild already joined at startup) and
// events/guildCreate.js (a genuinely new join, or a guild recovering from an
// outage, while the bot keeps running) — Discord's gateway does not re-fire
// GuildCreate for guilds present during the initial READY hydration, so both call
// sites are needed to cover every guild the bot is actually in.
async function ensureDefaultAlertInfra(guild) {
	const settings = voiceStore.getGuildSettings(guild.id);
	if (settings.alertChannelId || settings.defaultChannelId || settings.defaultAlertsDisabled) return;

	try {
		await createDefaultAlertInfra(guild);
	} catch (error) {
		console.error(`Failed to create default alert channel for guild ${guild.id}:`, error.message);
	}
}

module.exports = { createDefaultAlertInfra, ensureDefaultAlertInfra };
