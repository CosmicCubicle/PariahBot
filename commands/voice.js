const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const voiceStore = require('../state/voiceChannels');
const { createDefaultAlertInfra } = require('../lib/defaultAlertInfra');
const { sendAlert } = require('../lib/alertDelivery');
const { findDeadHubs, buildDeadHubMessage } = require('../lib/hubDesync');

function requireManageChannels(interaction) {
	if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageChannels)) {
		throw new Error('You need the Manage Channels permission to manage voice hubs.');
	}
}

// Category names aren't unique in Discord, so if more than one existing category
// shares this name, the first match in the cache wins rather than erroring — good
// enough for this feature, since categories are just a placement hint, not an
// identity anything else depends on.
async function resolveOrCreateCategory(interaction, name) {
	if (!name) return null;

	const existing = interaction.guild.channels.cache.find(
		(channel) => channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === name.toLowerCase(),
	);
	if (existing) return existing;

	return interaction.guild.channels.create({ name, type: ChannelType.GuildCategory });
}

async function registerHub(interaction, hub, category) {
	try {
		voiceStore.addHub(interaction.guildId, hub.id, category?.id ?? null);
	} catch (error) {
		if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
			throw new Error(`${hub} is already a voice hub.`);
		}
		throw error;
	}
}

async function handleAdd(interaction) {
	requireManageChannels(interaction);

	const hub = interaction.options.getChannel('hub');
	const category = await resolveOrCreateCategory(interaction, interaction.options.getString('category'));

	await registerHub(interaction, hub, category);

	await interaction.reply({
		content: `Registered ${hub} as a voice hub — joining it will create a temporary channel${category ? ` in ${category}` : ''}.`,
		ephemeral: true,
	});
}

async function handleCreate(interaction) {
	requireManageChannels(interaction);

	const name = interaction.options.getString('name');
	const category = await resolveOrCreateCategory(interaction, interaction.options.getString('category'));

	const hub = await interaction.guild.channels.create({
		name: name ?? '➕ Join to Create',
		type: ChannelType.GuildVoice,
		parent: category?.id ?? undefined,
	});

	await registerHub(interaction, hub, category);

	await interaction.reply({
		content: `Created ${hub} as a voice hub — joining it will create a temporary channel${category ? ` in ${category}` : ''}.`,
		ephemeral: true,
	});
}

async function handleRemove(interaction) {
	requireManageChannels(interaction);

	// hub is a string (channel ID), not a resolved channel — the autocomplete
	// handler below only ever suggests real hubs, but Discord doesn't enforce
	// that a string+autocomplete option's submitted value came from a suggestion,
	// so this can still legitimately be "wasn't a hub" (someone typed their own).
	const hubId = interaction.options.getString('hub');
	const removed = voiceStore.removeHub(hubId);

	if (!removed) {
		await interaction.reply({ content: `<#${hubId}> wasn't a voice hub.`, ephemeral: true });
		return;
	}

	const hub = interaction.guild.channels.cache.get(hubId);

	if (!hub) {
		// Tracked in our database, but the channel itself is already gone from
		// Discord (e.g. someone deleted it manually) — nothing left to delete.
		await interaction.reply({ content: `Unregistered that voice hub (its channel was already gone).`, ephemeral: true });
		return;
	}

	// Unregister first: the database write is local and effectively can't fail,
	// while the Discord API call below can (missing permission, already deleted,
	// rate limit) — so the hub is reliably gone from our tracking either way, and
	// only the reply's wording depends on whether the channel deletion succeeded.
	const hubName = hub.name;
	try {
		await hub.delete('Voice hub removed via /voice remove');
		await interaction.reply({ content: `Removed the **${hubName}** voice hub and deleted its channel.`, ephemeral: true });
	} catch (error) {
		await interaction.reply({
			content: `Unregistered **${hubName}** as a voice hub, but couldn't delete the channel itself: ${error.message}`,
			ephemeral: true,
		});
	}
}

async function handleAudit(interaction) {
	requireManageChannels(interaction);

	// Same detection lib/hubDesync.js's startup sweep uses, rendered as a direct
	// reply instead of pushed to the configured alert destinations — for checking
	// on demand rather than waiting for a restart.
	const deadHubs = findDeadHubs(interaction.guild);

	if (deadHubs.length === 0) {
		await interaction.reply({ content: 'All configured hubs are healthy — nothing to prune or restore.', ephemeral: true });
		return;
	}

	const [first, ...rest] = deadHubs;
	await interaction.reply({ ...buildDeadHubMessage(first), ephemeral: true });
	for (const hub of rest) {
		await interaction.followUp({ ...buildDeadHubMessage(hub), ephemeral: true });
	}
}

async function handleHubAutocomplete(interaction) {
	const focusedValue = interaction.options.getFocused().toLowerCase();
	const hubs = voiceStore.listHubs(interaction.guildId);

	const choices = hubs
		.map((hub) => {
			const channel = interaction.guild.channels.cache.get(hub.channelId);
			return { name: channel ? channel.name : `Unknown channel (${hub.channelId})`, value: hub.channelId };
		})
		.filter((choice) => choice.name.toLowerCase().includes(focusedValue))
		.slice(0, 25);

	await interaction.respond(choices);
}

async function handleList(interaction) {
	requireManageChannels(interaction);

	const hubs = voiceStore.listHubs(interaction.guildId);

	const embed = new EmbedBuilder()
		.setTitle('Voice hubs')
		.setColor(0x5865f2);

	if (hubs.length === 0) {
		embed.setDescription('No voice hubs are configured for this server yet. Use `/voice add` or `/voice create` to make one.');
	} else {
		for (const hub of hubs) {
			// Category channels don't reliably resolve as <#id> mentions in Discord's
			// client, so show the name directly rather than a broken-looking mention.
			let categoryLabel = 'same as the hub';
			if (hub.categoryId) {
				const category = interaction.guild.channels.cache.get(hub.categoryId);
				categoryLabel = category ? category.name : 'configured category no longer exists';
			}
			embed.addFields({
				name: `<#${hub.channelId}>`,
				value: `Category: ${categoryLabel}`,
			});
		}
	}

	const alertChannelId = voiceStore.getAlertChannel(interaction.guildId);
	const alertRecipients = voiceStore.listAlertRecipients(interaction.guildId);
	const alertLines = [
		alertChannelId ? `Channel: <#${alertChannelId}>` : 'Channel: not set',
		alertRecipients.length > 0 ? `DMs: ${alertRecipients.map((id) => `<@${id}>`).join(', ')}` : 'DMs: none configured',
	];
	embed.addFields({ name: 'Hub-desync alerts', value: alertLines.join('\n') });

	await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleAlertChannel(interaction) {
	requireManageChannels(interaction);
	const channel = interaction.options.getChannel('channel');
	voiceStore.setAlertChannel(interaction.guildId, channel.id);
	await interaction.reply({ content: `Alert channel set to ${channel}.`, ephemeral: true });
}

async function handleAlertAddRecipient(interaction) {
	requireManageChannels(interaction);
	const user = interaction.options.getUser('user');
	voiceStore.addAlertRecipient(interaction.guildId, user.id);
	await interaction.reply({ content: `${user} will now be DMed hub-desync alerts.`, ephemeral: true });
}

async function handleAlertRemoveRecipient(interaction) {
	requireManageChannels(interaction);
	const user = interaction.options.getUser('user');
	const removed = voiceStore.removeAlertRecipient(interaction.guildId, user.id);
	await interaction.reply({
		content: removed ? `${user} removed from the DM alert list.` : `${user} wasn't on the DM alert list.`,
		ephemeral: true,
	});
}

async function handleAlertRemoveDefault(interaction) {
	requireManageChannels(interaction);
	const settings = voiceStore.getGuildSettings(interaction.guildId);

	if (!settings.defaultCategoryId && !settings.defaultChannelId) {
		voiceStore.clearDefaultAlertInfra(interaction.guildId);
		await interaction.reply({
			content: "There was no default alert channel to remove — it won't be auto-created either from now on.",
			ephemeral: true,
		});
		return;
	}

	const channel = interaction.guild.channels.cache.get(settings.defaultChannelId);
	const category = interaction.guild.channels.cache.get(settings.defaultCategoryId);
	if (channel) await channel.delete('Default alert channel removed via /voice alert remove-default').catch(() => null);
	if (category) await category.delete('Default alert category removed via /voice alert remove-default').catch(() => null);

	// Sticky: records the opt-out so a future restart doesn't quietly recreate it.
	voiceStore.clearDefaultAlertInfra(interaction.guildId);
	await interaction.reply({
		content: "Removed the default alert category and channel. It won't come back on its own — use `/voice alert restore-default` to bring it back.",
		ephemeral: true,
	});
}

async function handleAlertRestoreDefault(interaction) {
	requireManageChannels(interaction);
	const settings = voiceStore.getGuildSettings(interaction.guildId);
	const categoryStillExists = settings.defaultCategoryId && interaction.guild.channels.cache.has(settings.defaultCategoryId);
	const channelStillExists = settings.defaultChannelId && interaction.guild.channels.cache.has(settings.defaultChannelId);

	if (categoryStillExists && channelStillExists) {
		voiceStore.setDefaultAlertInfra(interaction.guildId, settings.defaultCategoryId, settings.defaultChannelId);
		await interaction.reply({ content: `The default alert channel already exists: <#${settings.defaultChannelId}>.`, ephemeral: true });
		return;
	}

	const channel = await createDefaultAlertInfra(interaction.guild);
	await interaction.reply({ content: `Restored the default alert channel: ${channel}.`, ephemeral: true });
}

async function handleAlertTest(interaction) {
	requireManageChannels(interaction);

	const embed = new EmbedBuilder()
		.setTitle('🔔 Test alert')
		.setColor(0x5865f2)
		.setDescription('This is a test alert from PariahBot — if you can see this, your hub-desync alert settings are working.')
		.setTimestamp();

	const result = await sendAlert(interaction.guild, { embeds: [embed] });

	if (!result.channel && result.dms.length === 0) {
		await interaction.reply({
			content: "Nothing is configured to receive alerts yet — use `/voice alert channel` or `/voice alert add-recipient` first (or check `/voice list` for a default channel).",
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

const HANDLERS = {
	add: handleAdd,
	create: handleCreate,
	remove: handleRemove,
	list: handleList,
	audit: handleAudit,
};

const ALERT_HANDLERS = {
	channel: handleAlertChannel,
	'add-recipient': handleAlertAddRecipient,
	'remove-recipient': handleAlertRemoveRecipient,
	'remove-default': handleAlertRemoveDefault,
	'restore-default': handleAlertRestoreDefault,
	test: handleAlertTest,
};

module.exports = {
	data: new SlashCommandBuilder()
		.setName('voice')
		.setDescription('Create and manage temporary voice channels.')
		.addSubcommand((sub) => sub
			.setName('add')
			.setDescription('(Manage Channels) Register an existing voice channel as a hub.')
			.addChannelOption((option) => option
				.setName('hub')
				.setDescription('Voice channel users join to spawn a temp channel')
				.addChannelTypes(ChannelType.GuildVoice)
				.setRequired(true))
			.addStringOption((option) => option
				.setName('category')
				.setDescription("Category name (created if missing); defaults to the hub's own category")
				.setMaxLength(100)
				.setRequired(false)))
		.addSubcommand((sub) => sub
			.setName('create')
			.setDescription('(Manage Channels) Create a brand-new voice channel and register it as a hub.')
			.addStringOption((option) => option
				.setName('name')
				.setDescription('Name for the new hub channel (defaults to "➕ Join to Create")')
				.setMaxLength(100)
				.setRequired(false))
			.addStringOption((option) => option
				.setName('category')
				.setDescription("Category name for the new hub (created if it doesn't exist)")
				.setMaxLength(100)
				.setRequired(false)))
		.addSubcommand((sub) => sub
			.setName('remove')
			.setDescription('(Manage Channels) Unregister a voice hub.')
			.addStringOption((option) => option
				.setName('hub')
				.setDescription('The hub to remove')
				.setAutocomplete(true)
				.setRequired(true)))
		.addSubcommand((sub) => sub
			.setName('list')
			.setDescription("(Manage Channels) List this server's configured voice hubs and alert settings."))
		.addSubcommand((sub) => sub
			.setName('audit')
			.setDescription('(Manage Channels) Check for hubs whose channel no longer exists, with options to prune or restore.'))
		.addSubcommandGroup((group) => group
			.setName('alert')
			.setDescription('(Manage Channels) Configure and test hub-desync alerts.')
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
				.setDescription('Also DM a user when a hub goes out of sync.')
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
				.setDescription('Send a generic test alert to whatever is currently configured.'))),
	async execute(interaction) {
		const group = interaction.options.getSubcommandGroup(false);
		const subcommand = interaction.options.getSubcommand();

		const handler = group === 'alert' ? ALERT_HANDLERS[subcommand] : HANDLERS[subcommand];
		if (!handler) throw new Error(`Unknown /voice subcommand: ${group ? `${group} ` : ''}${subcommand}`);
		await handler(interaction);
	},
	async autocomplete(interaction) {
		const focusedOption = interaction.options.getFocused(true);

		if (focusedOption.name === 'hub') {
			await handleHubAutocomplete(interaction);
			return;
		}

		await interaction.respond([]);
	},
};
