const { SlashCommandBuilder, ChannelType, EmbedBuilder } = require('discord.js');
const guildSettings = require('../state/guildSettings');
const { createDefaultAlertInfra } = require('../lib/defaultAlertInfra');
const { sendAlert } = require('../lib/alertDelivery');
const { requireMod } = require('../lib/permissions');

// General-purpose: not specific to any one feature. Anything in the bot that wants
// to notify a server's admins (right now, only hub-desync detection) can call
// lib/alertDelivery.js's sendAlert() directly — this command is just the admin
// UI for configuring where those notices go, one shared destination per guild.

async function handleChannel(interaction) {
	requireMod(interaction);
	const channel = interaction.options.getChannel('channel');
	guildSettings.setAlertChannel(interaction.guildId, channel.id);
	await interaction.reply({ content: `Alert channel set to ${channel}.`, ephemeral: true });
}

async function handleAddRecipient(interaction) {
	requireMod(interaction);
	const user = interaction.options.getUser('user');
	guildSettings.addAlertRecipient(interaction.guildId, user.id);
	await interaction.reply({ content: `${user} will now be DMed alerts.`, ephemeral: true });
}

async function handleRemoveRecipient(interaction) {
	requireMod(interaction);
	const user = interaction.options.getUser('user');
	const removed = guildSettings.removeAlertRecipient(interaction.guildId, user.id);
	await interaction.reply({
		content: removed ? `${user} removed from the DM alert list.` : `${user} wasn't on the DM alert list.`,
		ephemeral: true,
	});
}

async function handleRemoveDefault(interaction) {
	requireMod(interaction);
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

// Say which channel, either way: `channel:` adopts one that already exists, or
// `name:` has one made. Neither is refused rather than guessed — the bot used
// to pick the name #bot-alerts itself, and a channel appearing under a name
// nobody chose is exactly what #92 was about.
async function handleRestoreDefault(interaction) {
	requireMod(interaction);

	const existing = interaction.options.getChannel('channel');
	const name = interaction.options.getString('name');
	const category = interaction.options.getChannel('category');

	if (existing && name) {
		throw new Error('Pass either `channel:` to use a channel that already exists, or `name:` to have me make one — not both.');
	}
	if (!existing && !name) {
		throw new Error(
			'Tell me which channel to use: `channel:#somewhere` for one that already exists, '
			+ 'or `name:bot-alerts` (with an optional `category:`) to have me make it.',
		);
	}

	if (existing) {
		// Recorded against the channel's own category, so /alerts status and the
		// dashboard describe where it actually is.
		guildSettings.setDefaultAlertInfra(interaction.guildId, existing.parentId ?? null, existing.id);
		await interaction.reply({ content: `Alerts will go to ${existing}.`, ephemeral: true });
		return;
	}

	// Guarded rather than creating a second one: the recorded channel still
	// being there means this was probably a mistake.
	const settings = guildSettings.getGuildSettings(interaction.guildId);
	if (settings.defaultChannelId && interaction.guild.channels.cache.has(settings.defaultChannelId)) {
		throw new Error(`I already made <#${settings.defaultChannelId}> for alerts. Use \`/alerts channel\` to point somewhere else, or \`/alerts remove-default\` to forget it first.`);
	}

	// The category is only ever one that already exists: since #92 the bot
	// creates no channel nobody asked for, and that includes the category it
	// used to make to hold this one. Without it the channel lands at the top
	// level, which is visible and movable rather than surprising.
	const channel = await createDefaultAlertInfra(interaction.guild, category, name);

	await interaction.reply({
		content: category
			? `**I created ${channel}** in **${category.name}**, and alerts will go there.`
			: `**I created ${channel}**, and alerts will go there. Pass \`category:\` next time to put it in a category.`,
		ephemeral: true,
	});
}

async function handleTest(interaction) {
	requireMod(interaction);

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
	requireMod(interaction);

	const settings = guildSettings.getGuildSettings(interaction.guildId);
	const recipients = guildSettings.listAlertRecipients(interaction.guildId);

	const lines = [
		settings.alertChannelId
			? `Channel: <#${settings.alertChannelId}> (explicitly set)`
			: settings.defaultChannelId
				? `Channel: <#${settings.defaultChannelId}> (default)`
				// No channel at all is now an ordinary state rather than something
				// that only happens if an admin removed one: since #92 the bot never
				// creates one by itself. Say what to do about it.
				: '⚠️ Channel: none — alerts are being dropped. Set one with `/alerts channel`, or `/alerts restore-default` to have me make one.',
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
		.setDescription('(Mod) Configure where PariahBot sends admin alerts.')
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
			.setDescription("(Mod) Forget the bot's #bot-alerts channel. The channel itself is left in place."))
		.addSubcommand((sub) => sub
			.setName('restore-default')
			.setDescription('(Mod) Set the alert channel: an existing one, or a name for me to create.')
			.addChannelOption((option) => option
				.setName('channel')
				.setDescription('An existing channel to use')
				.addChannelTypes(ChannelType.GuildText)
				.setRequired(false))
			.addStringOption((option) => option
				.setName('name')
				.setDescription('Name for a channel to create instead, e.g. bot-alerts')
				.setMaxLength(100)
				.setRequired(false))
			.addChannelOption((option) => option
				.setName('category')
				.setDescription('Existing category to create it in (default: no category)')
				.addChannelTypes(ChannelType.GuildCategory)
				.setRequired(false)))
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
