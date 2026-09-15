const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const voiceStore = require('../state/voiceChannels');
const guildSettings = require('../state/guildSettings');
const { findDeadHubs, buildDeadHubMessage } = require('../lib/hubDesync');
const { buildHubModal } = require('../lib/hubCreateWizard');

function requireManageChannels(interaction) {
	if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageChannels)) {
		throw new Error('You need the Manage Channels permission to manage voice hubs.');
	}
}

// /voice create used to take name/category as slash-command options and build
// the hub in one shot, then briefly became a multi-step button/select-menu
// wizard. It's now a single modal, opened directly as the command's response
// (see lib/hubCreateWizard.js) — no intermediate message, no session state,
// just one form. /voice add (registering an existing channel) was removed
// entirely rather than given the same treatment: reconciling an arbitrary
// existing channel's current state against the new config options was judged
// more complexity than it was worth — every hub now goes through this modal.
async function handleCreate(interaction) {
	requireManageChannels(interaction);
	await interaction.showModal(buildHubModal({ mode: 'create' }));
}

// /voice edit opens the exact same modal, pre-filled with the hub's current
// settings, so changing a hub's config looks and works identically to
// creating one — just starting from real values instead of blank.
async function handleEdit(interaction) {
	requireManageChannels(interaction);

	const hubId = interaction.options.getString('hub');
	const hub = voiceStore.getHub(hubId);
	if (!hub) {
		await interaction.reply({ content: `<#${hubId}> wasn't a voice hub.`, ephemeral: true });
		return;
	}

	const channel = interaction.guild.channels.cache.get(hubId);
	if (!channel) {
		await interaction.reply({
			content: `<#${hubId}> is tracked as a hub, but its channel no longer exists on Discord — use \`/voice audit\` to prune or restore it before editing.`,
			ephemeral: true,
		});
		return;
	}

	const category = hub.categoryId ? interaction.guild.channels.cache.get(hub.categoryId) : null;
	const overflowCategory = hub.overflowCategoryId ? interaction.guild.channels.cache.get(hub.overflowCategoryId) : null;

	await interaction.showModal(buildHubModal({
		mode: 'edit',
		hubChannelId: hubId,
		current: {
			hubName: channel.name,
			nameTemplate: hub.nameTemplate,
			categoryName: category?.name ?? null,
			overflowCategoryName: overflowCategory?.name ?? null,
			minLimit: hub.minLimit,
			maxLimit: hub.maxLimit,
			defaultLimit: hub.defaultLimit,
		},
	}));
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

async function handleSetModRole(interaction) {
	requireManageChannels(interaction);
	const role = interaction.options.getRole('role');
	guildSettings.setModRole(interaction.guildId, role.id);
	await interaction.reply({ content: `${role} can now claim temp channels away from a present, non-mod owner (see \`/vc claim\`).`, ephemeral: true });
}

async function handleClearModRole(interaction) {
	requireManageChannels(interaction);
	guildSettings.clearModRole(interaction.guildId);
	await interaction.reply({ content: 'Cleared the mod role — only Manage Channels holders count as mods now.', ephemeral: true });
}

async function handleDisableOwnerKick(interaction) {
	requireManageChannels(interaction);
	guildSettings.disableOwnerKick(interaction.guildId);
	await interaction.reply({ content: 'Channel owners can no longer use `/vc kick`.', ephemeral: true });
}

async function handleEnableOwnerKick(interaction) {
	requireManageChannels(interaction);
	guildSettings.enableOwnerKick(interaction.guildId);
	await interaction.reply({ content: 'Channel owners can use `/vc kick` again.', ephemeral: true });
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
		embed.setDescription('No voice hubs are configured for this server yet. Use `/voice create` to make one.');
	} else {
		for (const hub of hubs) {
			// Category channels don't reliably resolve as <#id> mentions in Discord's
			// client, so show the name directly rather than a broken-looking mention.
			let categoryLabel = 'none';
			if (hub.categoryId) {
				const category = interaction.guild.channels.cache.get(hub.categoryId);
				categoryLabel = category ? category.name : 'configured category no longer exists';
			}
			let overflowLabel = 'none';
			if (hub.overflowCategoryId) {
				const overflow = interaction.guild.channels.cache.get(hub.overflowCategoryId);
				overflowLabel = overflow ? overflow.name : 'configured overflow category no longer exists';
			}
			embed.addFields({
				name: `<#${hub.channelId}>`,
				value: `Category: ${categoryLabel}\nOverflow category: ${overflowLabel}\nTemp channel names: ${hub.nameTemplate}\nUser limit range: ${hub.minLimit}-${hub.maxLimit}`,
			});
		}
	}

	// Alert configuration isn't voice-specific (see /alerts) and no longer shown
	// here — check /alerts status instead.

	await interaction.reply({ embeds: [embed], ephemeral: true });
}

const HANDLERS = {
	create: handleCreate,
	edit: handleEdit,
	remove: handleRemove,
	list: handleList,
	audit: handleAudit,
	'set-mod-role': handleSetModRole,
	'clear-mod-role': handleClearModRole,
	'disable-owner-kick': handleDisableOwnerKick,
	'enable-owner-kick': handleEnableOwnerKick,
};

module.exports = {
	data: new SlashCommandBuilder()
		.setName('voice')
		.setDescription('Create and manage temporary voice channels.')
		.addSubcommand((sub) => sub
			.setName('create')
			.setDescription('(Manage Channels) Create a new voice hub, configured through a short setup flow.'))
		.addSubcommand((sub) => sub
			.setName('edit')
			.setDescription("(Manage Channels) Edit an existing voice hub's settings.")
			.addStringOption((option) => option
				.setName('hub')
				.setDescription('The hub to edit')
				.setAutocomplete(true)
				.setRequired(true)))
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
			.setDescription("(Manage Channels) List this server's configured voice hubs."))
		.addSubcommand((sub) => sub
			.setName('audit')
			.setDescription('(Manage Channels) Check for hubs whose channel no longer exists, with options to prune or restore.'))
		.addSubcommand((sub) => sub
			.setName('set-mod-role')
			.setDescription('(Manage Channels) Set the role that can override temp channel ownership via /vc claim.')
			.addRoleOption((option) => option
				.setName('role')
				.setDescription('Role that counts as a mod for /vc claim')
				.setRequired(true)))
		.addSubcommand((sub) => sub
			.setName('clear-mod-role')
			.setDescription('(Manage Channels) Remove the configured mod role.'))
		.addSubcommand((sub) => sub
			.setName('disable-owner-kick')
			.setDescription("(Manage Channels) Stop channel owners from using /vc kick."))
		.addSubcommand((sub) => sub
			.setName('enable-owner-kick')
			.setDescription('(Manage Channels) Let channel owners use /vc kick again.')),
	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();

		const handler = HANDLERS[subcommand];
		if (!handler) throw new Error(`Unknown /voice subcommand: ${subcommand}`);
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
