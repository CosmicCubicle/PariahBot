const { SlashCommandBuilder, ChannelType, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const patreonStore = require('../state/patreon');
const guildSettings = require('../state/guildSettings');
const patreon = require('../lib/patreon');
const { isMod, requireMod } = require('../lib/permissions');
const { MESSAGE_PLACEHOLDERS } = require('../lib/patreonAlerts');
const { MAX_TEMPLATE_LENGTH, renderAlertContent, unknownPlaceholders, unmentionableWarning } = require('../lib/alertContent');

const EMBED_COLOR = 0x5865f2;
const MAX_LISTED = 50;
const MAX_AUTOCOMPLETE_CHOICES = 25;
// Discord caps autocomplete choice names and values at 100 characters.
const MAX_CHOICE_LENGTH = 100;

function channelNote(guildId) {
	const { patreonChannelId } = guildSettings.getGuildSettings(guildId);
	return patreonChannelId
		? `New posts go to <#${patreonChannelId}>.`
		: "Posts won't go anywhere until a mod picks a channel with `/patreon channel`.";
}

function creatorLink(creator) {
	return creator.vanity ? `https://www.patreon.com/${creator.vanity}` : 'https://www.patreon.com/';
}

async function handleAdd(interaction) {
	requireMod(interaction);

	// The lookup is a network round trip that can outlast Discord's 3-second
	// window. It also catches a typo now, instead of the creator silently
	// never posting.
	await interaction.deferReply({ ephemeral: true });
	const campaign = await patreon.resolveCreator(interaction.options.getString('creator'));
	const existing = patreonStore.getCreator(interaction.guildId, campaign.id);
	patreonStore.addCreator(interaction.guildId, campaign.id, campaign.vanity, campaign.name);

	const notes = [
		existing
			? `${campaign.name} was already on the list. ${channelNote(interaction.guildId)}`
			: `Added ${campaign.name} — their new posts will be shared from now on (nothing from before now), as the public preview with a link. ${channelNote(interaction.guildId)}`,
	];
	if (campaign.isNsfw) {
		notes.push('⚠️ Patreon marks this creator as 18+, so their posts are only shared if the Patreon channel is age-restricted (channel settings → Age-Restricted Channel).');
	}
	await interaction.editReply({ content: notes.join('\n') });
}

async function handleChannel(interaction) {
	requireMod(interaction);

	const channel = interaction.options.getChannel('channel');
	const pingRole = interaction.options.getRole('ping_role');

	// Checked up front so a missing permission surfaces now, rather than as a
	// silent failure on the first post.
	const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
	if (!channel.permissionsFor(interaction.guild.members.me).has(needed)) {
		throw new Error(`I can't post embeds in ${channel} — give me View Channel, Send Messages and Embed Links there, then run this again.`);
	}

	guildSettings.setPatreonAlerts(interaction.guildId, channel.id, pingRole?.id);

	const notes = [`New Patreon posts will go to ${channel}${pingRole ? `, pinging ${pingRole}` : ''}.`];
	const warning = pingRole && unmentionableWarning(pingRole, channel);
	if (warning) notes.push(`⚠️ ${warning}`);
	await interaction.reply({ content: notes.join('\n'), ephemeral: true });
}

// Sample values for the preview that `message` replies with.
const PREVIEW_VALUES = { name: 'Some Creator', title: 'Behind the scenes: chapter 12', url: 'https://www.patreon.com/posts/example-123', platform: 'Patreon' };

async function handleMessage(interaction) {
	requireMod(interaction);

	const text = interaction.options.getString('text').trim();
	const unknown = unknownPlaceholders(text, MESSAGE_PLACEHOLDERS);
	if (unknown.length) {
		throw new Error(`I don't know ${unknown.join(', ')}. You can use {name}, {title}, {url}, {platform} and {role}.`);
	}

	guildSettings.setPatreonMessage(interaction.guildId, text);
	const { patreonRoleId } = guildSettings.getGuildSettings(interaction.guildId);
	const preview = renderAlertContent(text, PREVIEW_VALUES, patreonRoleId) ?? '';
	const notes = [
		'Patreon posts will now say:',
		`> ${preview.replace(/\n/g, '\n> ')}`,
		patreonRoleId
			? `The ping for <@&${patreonRoleId}> goes ${text.includes('{role}') ? 'where {role} is' : 'at the start'}.`
			: 'No ping role is set, so nobody is pinged. Add one with `/patreon channel`.',
		'Only the ping role ever notifies anyone. @everyone or other mentions in the message show as text only.',
	];
	// No mentions allowed: the preview must not ping the role for real.
	await interaction.reply({ content: notes.join('\n'), ephemeral: true, allowedMentions: { parse: [] } });
}

async function handleClearMessage(interaction) {
	requireMod(interaction);
	guildSettings.setPatreonMessage(interaction.guildId, null);
	await interaction.reply({ content: 'Custom message cleared — posts go back to just the ping.', ephemeral: true });
}

async function handleDisable(interaction) {
	requireMod(interaction);
	guildSettings.clearPatreonAlerts(interaction.guildId);
	await interaction.reply({
		content: 'Patreon alerts are off. The creator list is kept — `/patreon channel` turns them back on.',
		ephemeral: true,
	});
}

async function handleRemove(interaction) {
	requireMod(interaction);

	// Autocomplete submits the campaign ID; a typed value is a name or a link.
	// removeCreator matches either, within this guild.
	const raw = interaction.options.getString('creator').trim();
	const value = patreon.parseVanity(raw) ?? raw;

	const removed = patreonStore.removeCreator(interaction.guildId, value);
	await interaction.reply({
		content: removed
			? "Removed that creator — their posts won't be shared here any more."
			: `"${raw}" isn't on this server's Patreon list — pick one from the suggestions.`,
		ephemeral: true,
	});
}

async function handleList(interaction) {
	requireMod(interaction);

	const { patreonChannelId, patreonRoleId, patreonMessage } = guildSettings.getGuildSettings(interaction.guildId);
	const creators = patreonStore.listCreatorsForGuild(interaction.guildId);

	const lines = creators.slice(0, MAX_LISTED)
		.map((creator) => `[${creator.name}](${creatorLink(creator)}) · since <t:${Math.floor(Date.parse(creator.addedAt) / 1000)}:d>`);
	if (creators.length > MAX_LISTED) lines.push(`…and ${creators.length - MAX_LISTED} more.`);

	const embed = new EmbedBuilder()
		.setTitle('Patreon alerts')
		.setColor(EMBED_COLOR)
		.addFields(
			{ name: 'Channel', value: patreonChannelId ? `<#${patreonChannelId}>` : 'Not set — alerts are off', inline: true },
			{ name: 'Ping role', value: patreonRoleId ? `<@&${patreonRoleId}>` : 'None', inline: true },
			{ name: 'Custom message', value: patreonMessage ? patreonMessage.slice(0, 1024) : 'None — just the ping' },
		)
		.setDescription(lines.length ? lines.join('\n') : 'No creators yet. Add one with `/patreon add`.');

	await interaction.reply({ embeds: [embed], ephemeral: true });
}

const HANDLERS = {
	add: handleAdd,
	channel: handleChannel,
	message: handleMessage,
	'clear-message': handleClearMessage,
	disable: handleDisable,
	remove: handleRemove,
	list: handleList,
};

module.exports = {
	// Switchable feature set this command belongs to (lib/features.js).
	// events/interactionCreate.js refuses it when the guild has it off.
	feature: 'patreon',
	data: new SlashCommandBuilder()
		.setName('patreon')
		.setDescription("Share new Patreon posts' public previews from followed creators in a dedicated channel.")
		.addSubcommand((sub) => sub
			.setName('add')
			.setDescription('(Mod) Follow a Patreon creator. Only the public preview of each post is shared.')
			.addStringOption((option) => option
				.setName('creator')
				.setDescription('patreon.com/<name> link, or the name from it')
				.setMinLength(1)
				.setMaxLength(MAX_CHOICE_LENGTH)
				.setRequired(true)))
		.addSubcommand((sub) => sub
			.setName('channel')
			.setDescription('(Mod) Choose the channel new posts go to, and optionally a role to ping.')
			.addChannelOption((option) => option
				.setName('channel')
				.setDescription('Channel for Patreon posts')
				.addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
				.setRequired(true))
			.addRoleOption((option) => option
				.setName('ping_role')
				.setDescription('Role to ping with each post (optional)')
				.setRequired(false)))
		.addSubcommand((sub) => sub
			.setName('message')
			.setDescription('(Mod) Set custom text for posts. The ping role is still pinged.')
			.addStringOption((option) => option
				.setName('text')
				.setDescription('Your text. Placeholders: {name} {title} {url} {platform} {role}')
				.setMaxLength(MAX_TEMPLATE_LENGTH)
				.setRequired(true)))
		.addSubcommand((sub) => sub
			.setName('clear-message')
			.setDescription('(Mod) Remove the custom text, so posts are just the ping again.'))
		.addSubcommand((sub) => sub
			.setName('disable')
			.setDescription('(Mod) Stop sharing Patreon posts. The creator list is kept.'))
		.addSubcommand((sub) => sub
			.setName('remove')
			.setDescription('(Mod) Stop following a Patreon creator.')
			.addStringOption((option) => option
				.setName('creator')
				.setDescription('Creator to remove (pick from the suggestions)')
				.setAutocomplete(true)
				.setRequired(true)))
		.addSubcommand((sub) => sub
			.setName('list')
			.setDescription('(Mod) Show the Patreon settings and every followed creator.')),
	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();
		const handler = HANDLERS[subcommand];
		if (!handler) throw new Error(`Unknown /patreon subcommand: ${subcommand}`);
		await handler(interaction);
	},
	// Suggestions for /patreon remove — this guild's list only, and only for
	// staff. Not a security boundary on its own (a typed value needn't come
	// from here), which is why removeCreator also scopes by guild_id.
	async autocomplete(interaction) {
		if (!isMod(interaction.member, interaction.guildId)) {
			await interaction.respond([]);
			return;
		}
		const typed = interaction.options.getFocused().toLowerCase();
		const choices = patreonStore.listCreatorsForGuild(interaction.guildId)
			.filter((creator) => creator.name.toLowerCase().includes(typed) || (creator.vanity ?? '').toLowerCase().includes(typed))
			.slice(0, MAX_AUTOCOMPLETE_CHOICES)
			.map((creator) => ({ name: creator.name.slice(0, MAX_CHOICE_LENGTH), value: creator.campaignId }));
		await interaction.respond(choices);
	},
};
