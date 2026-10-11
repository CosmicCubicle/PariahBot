const { SlashCommandBuilder, ChannelType, EmbedBuilder } = require('discord.js');
const voiceStore = require('../state/voiceChannels');
const guildSettings = require('../state/guildSettings');
const { findDeadHubs, buildDeadHubMessage } = require('../lib/hubDesync');
const voiceHubs = require('../lib/voiceHubs');
const { OWNER_CONTROLS } = require('../lib/tempVoice');
const { requireMod } = require('../lib/permissions');

// Hub management for admins. The rules for adding, creating, removing and
// editing hubs are in lib/voiceHubs.js, shared with the admin dashboard.

async function handleAdd(interaction) {
	requireMod(interaction);
	const hub = interaction.options.getChannel('hub');
	const category = await voiceHubs.resolveOrCreateCategory(interaction.guild, interaction.options.getString('category'));
	voiceHubs.addExistingHub(interaction.guild, hub, category);
	await interaction.reply({
		content: `Registered ${hub} as a voice hub — joining it will create a temporary channel${category ? ` in ${category}` : ''}. Change its name template and limits with \`/voice edit\`.`,
		ephemeral: true,
	});
}

async function handleCreate(interaction) {
	requireMod(interaction);
	const category = await voiceHubs.resolveOrCreateCategory(interaction.guild, interaction.options.getString('category'));
	const hub = await voiceHubs.createHub(interaction.guild, interaction.options.getString('name'), category);
	await interaction.reply({
		content: `Created ${hub} as a voice hub — joining it will create a temporary channel${category ? ` in ${category}` : ''}. Change its name template and limits with \`/voice edit\`.`,
		ephemeral: true,
	});
}

// The hub is a string (channel ID) from autocomplete, but Discord doesn't
// make a typed value come from the suggestions, so lib/voiceHubs.js scopes
// every lookup to this guild.
async function handleRemove(interaction) {
	requireMod(interaction);
	const hubId = interaction.options.getString('hub');
	const result = await voiceHubs.removeHub(interaction.guild, hubId);
	let content;
	if (!result) content = `<#${hubId}> wasn't a voice hub.`;
	else if (!result.name) content = 'Unregistered that voice hub (its channel was already gone).';
	else if (result.channelDeleted) content = `Removed the **${result.name}** voice hub and deleted its channel.`;
	else content = `Unregistered **${result.name}** as a voice hub, but couldn't delete the channel itself: ${result.error}`;
	await interaction.reply({ content, ephemeral: true });
}

async function handleEdit(interaction) {
	requireMod(interaction);
	const options = interaction.options;
	const changes = {};
	if (options.getString('name_template') !== null) changes.nameTemplate = options.getString('name_template');
	if (options.getInteger('default_limit') !== null) changes.defaultLimit = options.getInteger('default_limit');
	if (options.getInteger('min_limit') !== null) changes.minLimit = options.getInteger('min_limit');
	if (options.getInteger('max_limit') !== null) changes.maxLimit = options.getInteger('max_limit');
	if (options.getChannel('category')) changes.category = options.getChannel('category');
	if (options.getBoolean('use_hub_category')) changes.category = null;
	if (Object.keys(changes).length === 0) {
		throw new Error('Give at least one setting to change: name_template, default_limit, min_limit, max_limit, or a category.');
	}

	const hubId = options.getString('hub');
	const hub = voiceHubs.editHub(interaction.guild, hubId, changes);
	const category = hub.categoryId ? interaction.guild.channels.cache.get(hub.categoryId) : null;
	await interaction.reply({
		content: [
			`Updated <#${hubId}>. New temp channels from it:`,
			`• are named **${hub.nameTemplate}** (with {owner} as the owner's name)`,
			`• limits: ${voiceHubs.describeLimits(hub)}`,
			`• go in ${category ? category.name : "the hub's own category"}`,
			'Channels already open keep the settings they were made with.',
		].join('\n'),
		ephemeral: true,
	});
}

async function handleOwnerControl(interaction) {
	requireMod(interaction);
	const control = interaction.options.getString('control');
	const allowed = interaction.options.getBoolean('allowed');
	guildSettings.setOwnerControlAllowed(interaction.guildId, control, allowed);
	await interaction.reply({
		content: `Channel owners ${allowed ? 'can' : 'can no longer'} use ${OWNER_CONTROLS[control].command}.`,
		ephemeral: true,
	});
}

// Kept for anyone used to them; the same switch as /voice owner-control kick.
async function handleDisableOwnerKick(interaction) {
	requireMod(interaction);
	guildSettings.setOwnerControlAllowed(interaction.guildId, 'kick', false);
	await interaction.reply({ content: 'Channel owners can no longer use `/vc kick`.', ephemeral: true });
}

async function handleEnableOwnerKick(interaction) {
	requireMod(interaction);
	guildSettings.setOwnerControlAllowed(interaction.guildId, 'kick', true);
	await interaction.reply({ content: 'Channel owners can use `/vc kick` again.', ephemeral: true });
}

async function handleAudit(interaction) {
	requireMod(interaction);

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

async function handleList(interaction) {
	requireMod(interaction);

	const hubs = voiceStore.listHubs(interaction.guildId);
	const { ownerControls } = guildSettings.getGuildSettings(interaction.guildId);

	const embed = new EmbedBuilder()
		.setTitle('Voice hubs')
		.setColor(0x5865f2);

	if (hubs.length === 0) {
		embed.setDescription('No voice hubs are configured for this server yet. Use `/voice add` or `/voice create` to make one.');
	} else {
		for (const hub of hubs.slice(0, 24)) {
			// Category channels don't reliably resolve as <#id> mentions in Discord's
			// client, so show the name directly rather than a broken-looking mention.
			let categoryLabel = 'same as the hub';
			if (hub.categoryId) {
				const category = interaction.guild.channels.cache.get(hub.categoryId);
				categoryLabel = category ? category.name : 'configured category no longer exists';
			}
			embed.addFields({
				name: interaction.guild.channels.cache.get(hub.channelId)?.name ?? `Deleted channel (${hub.channelId})`,
				value: `Names: ${hub.nameTemplate}\nLimits: ${voiceHubs.describeLimits(hub)}\nCategory: ${categoryLabel}`,
			});
		}
	}

	const disabled = Object.entries(ownerControls).filter(([, allowed]) => !allowed).map(([control]) => OWNER_CONTROLS[control].command);
	embed.addFields({ name: 'Owner controls', value: disabled.length ? `Turned off: ${disabled.join(', ')}` : 'All on' });

	// Alert configuration isn't voice-specific (see /alerts) and no longer shown
	// here — check /alerts status instead.
	await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleHubAutocomplete(interaction) {
	const focusedValue = interaction.options.getFocused().toLowerCase();
	const choices = voiceStore.listHubs(interaction.guildId)
		.map((hub) => {
			const channel = interaction.guild.channels.cache.get(hub.channelId);
			return { name: channel ? channel.name : `Unknown channel (${hub.channelId})`, value: hub.channelId };
		})
		.filter((choice) => choice.name.toLowerCase().includes(focusedValue))
		.slice(0, 25);
	await interaction.respond(choices);
}

const HANDLERS = {
	add: handleAdd,
	create: handleCreate,
	remove: handleRemove,
	edit: handleEdit,
	list: handleList,
	audit: handleAudit,
	'owner-control': handleOwnerControl,
	'disable-owner-kick': handleDisableOwnerKick,
	'enable-owner-kick': handleEnableOwnerKick,
};

function hubOption(option, description) {
	return option
		.setName('hub')
		.setDescription(description)
		.setAutocomplete(true)
		.setRequired(true);
}

function limitOption(option, name, description) {
	return option
		.setName(name)
		.setDescription(description)
		.setMinValue(0)
		.setMaxValue(voiceHubs.MAX_LIMIT)
		.setRequired(false);
}

module.exports = {
	// Switchable feature set this command belongs to (lib/features.js).
	// events/interactionCreate.js refuses it when the guild has it off.
	feature: 'tempVoice',
	data: new SlashCommandBuilder()
		.setName('voice')
		.setDescription('Create and manage temporary voice channels.')
		.addSubcommand((sub) => sub
			.setName('add')
			.setDescription('(Mod) Register an existing voice channel as a hub.')
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
			.setDescription('(Mod) Create a brand-new voice channel and register it as a hub.')
			.addStringOption((option) => option
				.setName('name')
				.setDescription(`Name for the new hub channel (defaults to "${voiceHubs.DEFAULT_HUB_NAME}")`)
				.setMaxLength(100)
				.setRequired(false))
			.addStringOption((option) => option
				.setName('category')
				.setDescription("Category name for the new hub (created if it doesn't exist)")
				.setMaxLength(100)
				.setRequired(false)))
		.addSubcommand((sub) => sub
			.setName('remove')
			.setDescription('(Mod) Unregister a voice hub and delete its channel.')
			.addStringOption((option) => hubOption(option, 'The hub to remove')))
		.addSubcommand((sub) => sub
			.setName('edit')
			.setDescription("(Mod) Change a hub's temp channel name, limits or category.")
			.addStringOption((option) => hubOption(option, 'The hub to change'))
			.addStringOption((option) => option
				.setName('name_template')
				.setDescription("Temp channel name; {owner} is the owner's name. e.g. 🎮 {owner}'s squad")
				.setMaxLength(voiceHubs.MAX_TEMPLATE_LENGTH)
				.setRequired(false))
			.addIntegerOption((option) => limitOption(option, 'default_limit', 'User limit new channels start with (0 = no limit)'))
			.addIntegerOption((option) => limitOption(option, 'min_limit', 'Lowest limit owners can set with /vc limit'))
			.addIntegerOption((option) => limitOption(option, 'max_limit', 'Highest limit owners can set with /vc limit'))
			.addChannelOption((option) => option
				.setName('category')
				.setDescription('Category to put temp channels in')
				.addChannelTypes(ChannelType.GuildCategory)
				.setRequired(false))
			.addBooleanOption((option) => option
				.setName('use_hub_category')
				.setDescription("Put temp channels in the hub's own category instead")
				.setRequired(false)))
		.addSubcommand((sub) => sub
			.setName('owner-control')
			.setDescription('(Mod) Allow or stop a /vc control for channel owners.')
			.addStringOption((option) => option
				.setName('control')
				.setDescription('Which owner control')
				.addChoices(...Object.entries(OWNER_CONTROLS).map(([value, { label, command }]) => ({ name: `${label} (${command})`, value })))
				.setRequired(true))
			.addBooleanOption((option) => option
				.setName('allowed')
				.setDescription('Whether owners may use it')
				.setRequired(true)))
		.addSubcommand((sub) => sub
			.setName('list')
			.setDescription("(Mod) List this server's voice hubs, their settings, and owner controls."))
		.addSubcommand((sub) => sub
			.setName('audit')
			.setDescription('(Mod) Check for hubs whose channel no longer exists, with options to prune or restore.'))
		.addSubcommand((sub) => sub
			.setName('disable-owner-kick')
			.setDescription('(Mod) Stop channel owners from using /vc kick.'))
		.addSubcommand((sub) => sub
			.setName('enable-owner-kick')
			.setDescription('(Mod) Let channel owners use /vc kick again.')),
	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();
		const handler = HANDLERS[subcommand];
		if (!handler) throw new Error(`Unknown /voice subcommand: ${subcommand}`);
		await handler(interaction);
	},
	async autocomplete(interaction) {
		if (interaction.options.getFocused(true).name === 'hub') {
			await handleHubAutocomplete(interaction);
			return;
		}
		await interaction.respond([]);
	},
};
