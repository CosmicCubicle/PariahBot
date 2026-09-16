const { SlashCommandBuilder, ChannelType, EmbedBuilder } = require('discord.js');
const autoDeleteStore = require('../state/autoDeleteChannels');
const autoDelete = require('../lib/autoDelete');
const { requireAdmin } = require('../lib/permissions');

function resolveTargetChannel(interaction) {
	return interaction.options.getChannel('channel') ?? interaction.channel;
}

function formatDuration(totalSeconds) {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	const parts = [];
	if (hours) parts.push(`${hours}h`);
	if (minutes) parts.push(`${minutes}m`);
	if (seconds) parts.push(`${seconds}s`);
	return parts.join('') || '0s';
}

function describeConfig(config) {
	const { maxMessages, liveSeconds } = config;
	if (maxMessages > 0 && liveSeconds > 0) {
		return `messages are deleted after ${formatDuration(liveSeconds)} or ${maxMessages} newer messages, whichever comes first.`;
	}
	if (liveSeconds > 0) {
		return `messages are deleted after ${formatDuration(liveSeconds)}.`;
	}
	if (maxMessages > 0) {
		return `messages are deleted after ${maxMessages} newer messages.`;
	}
	return 'not configured.';
}

async function handleSet(interaction) {
	requireAdmin(interaction);

	const channel = resolveTargetChannel(interaction);
	const count = interaction.options.getInteger('count');
	const durationRaw = interaction.options.getString('duration');

	if (count === null && !durationRaw) {
		throw new Error('Specify count, duration, or both.');
	}

	const maxMessages = count ?? 0;
	const liveSeconds = durationRaw ? autoDelete.parseDuration(durationRaw) : 0;
	const config = { maxMessages, liveSeconds };

	// Turning on tracking for a channel with backlog (fetching history, then
	// possibly reaping a lot of it immediately) can take longer than Discord's
	// 3-second reply window — defer right away so the interaction token is
	// still alive by the time that finishes, no matter how long it takes.
	await interaction.deferReply({ ephemeral: true });

	autoDeleteStore.setChannel(channel.id, interaction.guildId, maxMessages, liveSeconds);

	if (autoDelete.isTracked(channel.id)) {
		autoDelete.updateConfig(channel.id, config);
		await autoDelete.reapChannel(channel.id);
	} else {
		await autoDelete.startTracking(channel, config);
	}

	await interaction.editReply({ content: `Auto-delete enabled in ${channel}: ${describeConfig(config)}` });
}

async function handleDisable(interaction) {
	requireAdmin(interaction);

	const channel = resolveTargetChannel(interaction);
	const removed = autoDeleteStore.removeChannel(channel.id);
	autoDelete.stopTracking(channel.id);

	await interaction.reply({
		content: removed ? `Auto-delete disabled in ${channel}.` : `Auto-delete wasn't enabled in ${channel}.`,
		ephemeral: true,
	});
}

async function handleStatus(interaction) {
	requireAdmin(interaction);

	const channel = resolveTargetChannel(interaction);
	const config = autoDeleteStore.getChannel(channel.id);

	const embed = new EmbedBuilder()
		.setTitle('Auto-delete settings')
		.setColor(0x5865f2)
		.setDescription(`${channel}: ${config ? describeConfig(config) : 'not configured.'}`);

	await interaction.reply({ embeds: [embed], ephemeral: true });
}

const HANDLERS = {
	set: handleSet,
	disable: handleDisable,
	status: handleStatus,
};

function channelOption(option, description) {
	return option
		.setName('channel')
		.setDescription(description)
		.addChannelTypes(ChannelType.GuildText)
		.setRequired(false);
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName('autodelete')
		.setDescription('(Admin) Automatically delete messages in a channel on a rolling basis.')
		.addSubcommand((sub) => sub
			.setName('set')
			.setDescription('(Admin) Enable or update auto-delete for a channel.')
			.addChannelOption((option) => channelOption(option, 'Channel to configure (defaults to this channel)'))
			.addIntegerOption((option) => option
				.setName('count')
				.setDescription('Max live messages before the oldest is deleted')
				.setMinValue(1)
				.setRequired(false))
			.addStringOption((option) => option
				.setName('duration')
				.setDescription('Delete messages after this long — e.g. 24h, 30m, 1h30m')
				.setRequired(false)))
		.addSubcommand((sub) => sub
			.setName('disable')
			.setDescription('(Admin) Turn off auto-delete for a channel.')
			.addChannelOption((option) => channelOption(option, 'Channel to disable (defaults to this channel)')))
		.addSubcommand((sub) => sub
			.setName('status')
			.setDescription('(Admin) Show the auto-delete settings for a channel.')
			.addChannelOption((option) => channelOption(option, 'Channel to check (defaults to this channel)'))),
	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();
		const handler = HANDLERS[subcommand];
		if (!handler) throw new Error(`Unknown /autodelete subcommand: ${subcommand}`);
		await handler(interaction);
	},
};
