const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const guildSettings = require('../state/guildSettings');
const { createDefaultAlertInfra } = require('../lib/defaultAlertInfra');
const { sendAlert } = require('../lib/alertDelivery');

// General-purpose: not specific to any one feature. Anything in the bot that wants
// to notify a server's admins (right now, only hub-desync detection) can call
// lib/alertDelivery.js's sendAlert() directly — this command is just the admin
// UI for configuring where those notices go, one shared destination per guild.

function requireManageChannels(interaction) {
	if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageChannels)) {
		throw new Error('You need the Manage Channels permission to manage alert settings.');
	}
}

async function handleChannel(interaction) {
	requireManageChannels(interaction);
	const channel = interaction.options.getChannel('channel');
	guildSettings.setAlertChannel(interaction.guildId, channel.id);
	await interaction.reply({ content: `Alert channel set to ${channel}.`, ephemeral: true });
}

async function handleAddRecipient(interaction) {
	requireManageChannels(interaction);
	const user = interaction.options.getUser('user');
	guildSettings.addAlertRecipient(interaction.guildId, user.id);
	await interaction.reply({ content: `${user} will now be DMed alerts.`, ephemeral: true });
}

async function handleRemoveRecipient(interaction) {
	requireManageChannels(interaction);
	const user = interaction.options.getUser('user');
	const removed = guildSettings.removeAlertRecipient(interaction.guildId, user.id);
	await interaction.reply({
		content: removed ? `${user} removed from the DM alert list.` : `${user} wasn't on the DM alert list.`,
		ephemeral: true,
	});
}

async function handleRemoveDefault(interaction) {
	requireManageChannels(interaction);
	const settings = guildSettings.getGuildSettings(interaction.guildId);

	if (!settings.defaultCategoryId && !settings.defaultChannelId) {
		guildSettings.clearDefaultAlertInfra(interaction.guildId);
		await interaction.reply({
			content: "There was no default alert channel to remove — it won't be auto-created either from now on.",
			ephemeral: true,
		});
		return;
	}

	const channel = interaction.guild.channels.cache.get(settings.defaultChannelId);
	const category = interaction.guild.channels.cache.get(settings.defaultCategoryId);
	if (channel) await channel.delete('Default alert channel removed via /alerts remove-default').catch(() => null);
	if (category) await category.delete('Default alert category removed via /alerts remove-default').catch(() => null);

	// Sticky: records the opt-out so a future restart doesn't quietly recreate it.
	guildSettings.clearDefaultAlertInfra(interaction.guildId);
	await interaction.reply({
		content: "Removed the default alert category and channel. It won't come back on its own — use `/alerts restore-default` to bring it back.",
		ephemeral: true,
	});
}

async function handleRestoreDefault(interaction) {
	requireManageChannels(interaction);
	const settings = guildSettings.getGuildSettings(interaction.guildId);
	const categoryStillExists = settings.defaultCategoryId && interaction.guild.channels.cache.has(settings.defaultCategoryId);
	const channelStillExists = settings.defaultChannelId && interaction.guild.channels.cache.has(settings.defaultChannelId);

	if (categoryStillExists && channelStillExists) {
		guildSettings.setDefaultAlertInfra(interaction.guildId, settings.defaultCategoryId, settings.defaultChannelId);
		await interaction.reply({ content: `The default alert channel already exists: <#${settings.defaultChannelId}>.`, ephemeral: true });
		return;
	}

	const channel = await createDefaultAlertInfra(interaction.guild);
	await interaction.reply({ content: `Restored the default alert channel: ${channel}.`, ephemeral: true });
}

async function handleTest(interaction) {
	requireManageChannels(interaction);

	const embed = new EmbedBuilder()
		.setTitle('🔔 Test alert')
		.setColor(0x5865f2)
		.setDescription('This is a test alert from PariahBot — if you can see this, your alert settings are working.')
		.setTimestamp();

	const result = await sendAlert(interaction.guild, { embeds: [embed] });

	if (!result.channel && result.dms.length === 0) {
		await interaction.reply({
			content: "Nothing is configured to receive alerts yet — use `/alerts channel` or `/alerts add-recipient` first (or check `/alerts status` for a default channel).",
			ephemeral: true,
		});
		return;
	}

	const lines = [];
	if (result.channel) {
		lines.push(result.channel.ok
			? `Channel <#${result.channel.id}>: sent ✅`
			: `Channel <#${result.channel.id}>: failed — ${result.channel.error}`);
	}
	for (const dm of result.dms) {
		lines.push(dm.ok ? `DM to <@${dm.id}>: sent ✅` : `DM to <@${dm.id}>: failed — ${dm.error}`);
	}
	await interaction.reply({ content: lines.join('\n'), ephemeral: true });
}

async function handleStatus(interaction) {
	requireManageChannels(interaction);

	const settings = guildSettings.getGuildSettings(interaction.guildId);
	const recipients = guildSettings.listAlertRecipients(interaction.guildId);

	const lines = [
		settings.alertChannelId
			? `Channel: <#${settings.alertChannelId}> (explicitly set)`
			: settings.defaultChannelId
				? `Channel: <#${settings.defaultChannelId}> (default)`
				: settings.defaultAlertsDisabled
					? 'Channel: none configured (default disabled)'
					: 'Channel: none configured yet',
		recipients.length > 0 ? `DMs: ${recipients.map((id) => `<@${id}>`).join(', ')}` : 'DMs: none configured',
	];

	const embed = new EmbedBuilder()
		.setTitle('Alert settings')
		.setColor(0x5865f2)
		.setDescription(lines.join('\n'));

	await interaction.reply({ embeds: [embed], ephemeral: true });
}

const HANDLERS = {
	channel: handleChannel,
	'add-recipient': handleAddRecipient,
	'remove-recipient': handleRemoveRecipient,
	'remove-default': handleRemoveDefault,
	'restore-default': handleRestoreDefault,
	test: handleTest,
	status: handleStatus,
};

module.exports = {
	data: new SlashCommandBuilder()
		.setName('alerts')
		.setDescription('(Manage Channels) Configure where PariahBot sends admin alerts.')
		.addSubcommand((sub) => sub
			.setName('channel')
			.setDescription('Set the text channel alerts are posted in.')
			.addChannelOption((option) => option
				.setName('channel')
				.setDescription('Text channel to post alerts in')
				.addChannelTypes(ChannelType.GuildText)
				.setRequired(true)))
		.addSubcommand((sub) => sub
			.setName('add-recipient')
			.setDescription('Also DM a user when an alert fires.')
			.addUserOption((option) => option
				.setName('user')
				.setDescription('User to DM')
				.setRequired(true)))
		.addSubcommand((sub) => sub
			.setName('remove-recipient')
			.setDescription('Stop DMing a user.')
			.addUserOption((option) => option
				.setName('user')
				.setDescription('User to stop DMing')
				.setRequired(true)))
		.addSubcommand((sub) => sub
			.setName('remove-default')
			.setDescription("Delete the bot's default alert category/channel and stop auto-recreating it."))
		.addSubcommand((sub) => sub
			.setName('restore-default')
			.setDescription("Recreate the bot's default alert category/channel if it's missing."))
		.addSubcommand((sub) => sub
			.setName('test')
			.setDescription('Send a generic test alert to whatever is currently configured.'))
		.addSubcommand((sub) => sub
			.setName('status')
			.setDescription('Show the current alert channel and DM recipients.')),
	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();
		const handler = HANDLERS[subcommand];
		if (!handler) throw new Error(`Unknown /alerts subcommand: ${subcommand}`);
		await handler(interaction);
	},
};
