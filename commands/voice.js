const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const voiceStore = require('../state/voiceChannels');

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

async function handleSetupAdd(interaction) {
	requireManageChannels(interaction);

	const hub = interaction.options.getChannel('hub');
	const category = await resolveOrCreateCategory(interaction, interaction.options.getString('category'));

	await registerHub(interaction, hub, category);

	await interaction.reply({
		content: `Registered ${hub} as a voice hub — joining it will create a temporary channel${category ? ` in ${category}` : ''}.`,
		ephemeral: true,
	});
}

async function handleSetupCreate(interaction) {
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

async function handleSetupRemove(interaction) {
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
		await hub.delete('Voice hub removed via /voice setup remove');
		await interaction.reply({ content: `Removed the **${hubName}** voice hub and deleted its channel.`, ephemeral: true });
	} catch (error) {
		await interaction.reply({
			content: `Unregistered **${hubName}** as a voice hub, but couldn't delete the channel itself: ${error.message}`,
			ephemeral: true,
		});
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

async function handleSetupList(interaction) {
	requireManageChannels(interaction);

	const hubs = voiceStore.listHubs(interaction.guildId);

	const embed = new EmbedBuilder()
		.setTitle('Voice hubs')
		.setColor(0x5865f2);

	if (hubs.length === 0) {
		embed.setDescription('No voice hubs are configured for this server yet. Use `/voice setup add` to create one.');
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

	await interaction.reply({ embeds: [embed], ephemeral: true });
}

const SETUP_HANDLERS = {
	add: handleSetupAdd,
	create: handleSetupCreate,
	remove: handleSetupRemove,
	list: handleSetupList,
};

module.exports = {
	data: new SlashCommandBuilder()
		.setName('voice')
		.setDescription('Create and manage temporary voice channels.')
		.addSubcommandGroup((group) => group
			.setName('setup')
			.setDescription('(Manage Channels) Configure voice hubs for this server.')
			.addSubcommand((sub) => sub
				.setName('add')
				.setDescription('Register an existing voice channel as a hub.')
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
				.setDescription('Create a brand-new voice channel and register it as a hub.')
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
				.setDescription('Unregister a voice hub.')
				.addStringOption((option) => option
					.setName('hub')
					.setDescription('The hub to remove')
					.setAutocomplete(true)
					.setRequired(true)))
			.addSubcommand((sub) => sub
				.setName('list')
				.setDescription("List this server's configured voice hubs."))),
	async execute(interaction) {
		const group = interaction.options.getSubcommandGroup(false);
		const subcommand = interaction.options.getSubcommand();

		if (group === 'setup') {
			const handler = SETUP_HANDLERS[subcommand];
			if (!handler) throw new Error(`Unknown /voice setup subcommand: ${subcommand}`);
			await handler(interaction);
			return;
		}

		throw new Error(`Unknown /voice subcommand: ${subcommand}`);
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
