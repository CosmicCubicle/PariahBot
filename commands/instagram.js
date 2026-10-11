const { SlashCommandBuilder, ChannelType, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const instagramStore = require('../state/instagram');
const guildSettings = require('../state/guildSettings');
const instagram = require('../lib/instagram');
const { isMod, requireMod } = require('../lib/permissions');
const { MESSAGE_PLACEHOLDERS } = require('../lib/instagramAlerts');
const { MAX_TEMPLATE_LENGTH, renderAlertContent, unknownPlaceholders } = require('../lib/alertContent');

const EMBED_COLOR = 0x5865f2;
const MAX_LISTED = 50;
const MAX_AUTOCOMPLETE_CHOICES = 25;
// Discord caps autocomplete choice names and values at 100 characters.
const MAX_CHOICE_LENGTH = 100;

function requireConfigured() {
	if (!instagram.isConfigured()) {
		throw new Error("Instagram isn't set up on this bot's host yet — the bot owner needs to add INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_BUSINESS_ACCOUNT_ID to hom.env and restart it.");
	}
}

function channelNote(guildId) {
	const { instagramChannelId } = guildSettings.getGuildSettings(guildId);
	return instagramChannelId
		? `New posts go to <#${instagramChannelId}>.`
		: "Posts won't go anywhere until an admin picks a channel with `/instagram channel`.";
}

async function handleAdd(interaction) {
	requireMod(interaction);
	requireConfigured();

	// The lookup is a network round trip that can outlast Discord's 3-second
	// window. It also catches a typo now, instead of the account silently
	// never posting.
	await interaction.deferReply({ ephemeral: true });
	const account = await instagram.resolveAccount(interaction.options.getString('account'));
	const existing = instagramStore.getAccount(interaction.guildId, account.id);
	instagramStore.addAccount(interaction.guildId, account.id, account.username);

	await interaction.editReply({
		content: existing
			? `@${account.username} was already on the list. ${channelNote(interaction.guildId)}`
			: `Added @${account.username} — its new posts and reels will be shared here from now on (nothing from before now). ${channelNote(interaction.guildId)}`,
	});
}

async function handleChannel(interaction) {
	requireMod(interaction);

	const channel = interaction.options.getChannel('channel');
	const pingRole = interaction.options.getRole('ping_role');

	// Checked up front so a missing permission surfaces now, to the admin,
	// rather than as a silent failure on the first post.
	const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
	if (!channel.permissionsFor(interaction.guild.members.me).has(needed)) {
		throw new Error(`I can't post embeds in ${channel} — give me View Channel, Send Messages and Embed Links there, then run this again.`);
	}

	guildSettings.setInstagramAlerts(interaction.guildId, channel.id, pingRole?.id);

	const notes = [`New Instagram posts will go to ${channel}${pingRole ? `, pinging ${pingRole}` : ''}.`];
	if (pingRole && !pingRole.mentionable && !interaction.guild.members.me.permissions.has(PermissionFlagsBits.MentionEveryone)) {
		notes.push(`⚠️ ${pingRole} isn't mentionable, so the ping won't notify anyone. Turn on "Allow anyone to @mention this role" in its settings, or give me Mention Everyone.`);
	}
	if (!instagram.isConfigured()) {
		notes.push("⚠️ Instagram isn't set up on this bot's host yet (INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_BUSINESS_ACCOUNT_ID), so nothing will post until it is.");
	}
	await interaction.reply({ content: notes.join('\n'), ephemeral: true });
}

// Sample values for the preview that `message` replies with.
const PREVIEW_VALUES = { name: '@someaccount', title: 'Behind the scenes from today', url: 'https://www.instagram.com/p/example/', platform: 'Instagram' };

async function handleMessage(interaction) {
	requireMod(interaction);

	const text = interaction.options.getString('text').trim();
	const unknown = unknownPlaceholders(text, MESSAGE_PLACEHOLDERS);
	if (unknown.length) {
		throw new Error(`I don't know ${unknown.join(', ')}. You can use {name}, {title}, {url}, {platform} and {role}.`);
	}

	guildSettings.setInstagramMessage(interaction.guildId, text);
	const { instagramRoleId } = guildSettings.getGuildSettings(interaction.guildId);
	const preview = renderAlertContent(text, PREVIEW_VALUES, instagramRoleId) ?? '';
	const notes = [
		'Instagram posts will now say:',
		`> ${preview.replace(/\n/g, '\n> ')}`,
		instagramRoleId
			? `The ping for <@&${instagramRoleId}> goes ${text.includes('{role}') ? 'where {role} is' : 'at the start'}.`
			: 'No ping role is set, so nobody is pinged. Add one with `/instagram channel`.',
		'Only the ping role ever notifies anyone. @everyone or other mentions in the message show as text only.',
	];
	// No mentions allowed: the preview must not ping the role for real.
	await interaction.reply({ content: notes.join('\n'), ephemeral: true, allowedMentions: { parse: [] } });
}

async function handleClearMessage(interaction) {
	requireMod(interaction);
	guildSettings.setInstagramMessage(interaction.guildId, null);
	await interaction.reply({ content: 'Custom message cleared — posts go back to just the ping.', ephemeral: true });
}

async function handleDisable(interaction) {
	requireMod(interaction);
	guildSettings.clearInstagramAlerts(interaction.guildId);
	await interaction.reply({
		content: 'Instagram alerts are off. The account list is kept — `/instagram channel` turns them back on.',
		ephemeral: true,
	});
}

async function handleRemove(interaction) {
	requireMod(interaction);

	// Autocomplete submits the account ID; a typed value is a username, maybe
	// with an @ or as a link. removeAccount matches either, within this guild.
	const raw = interaction.options.getString('account').trim();
	const value = instagram.parseUsername(raw) ?? raw;

	const removed = instagramStore.removeAccount(interaction.guildId, value);
	await interaction.reply({
		content: removed
			? 'Removed that account — its posts won\'t be shared here any more.'
			: `"${raw}" isn't on this server's Instagram list — pick one from the suggestions.`,
		ephemeral: true,
	});
}

async function handleList(interaction) {
	requireMod(interaction);

	const { instagramChannelId, instagramRoleId, instagramMessage } = guildSettings.getGuildSettings(interaction.guildId);
	const accounts = instagramStore.listAccountsForGuild(interaction.guildId);

	const lines = accounts.slice(0, MAX_LISTED)
		.map((account) => `[@${account.username}](https://www.instagram.com/${account.username}/) · since <t:${Math.floor(Date.parse(account.addedAt) / 1000)}:d>`);
	if (accounts.length > MAX_LISTED) lines.push(`…and ${accounts.length - MAX_LISTED} more.`);

	const embed = new EmbedBuilder()
		.setTitle('Instagram alerts')
		.setColor(EMBED_COLOR)
		.addFields(
			{ name: 'Channel', value: instagramChannelId ? `<#${instagramChannelId}>` : 'Not set — alerts are off', inline: true },
			{ name: 'Ping role', value: instagramRoleId ? `<@&${instagramRoleId}>` : 'None', inline: true },
			{ name: 'Host', value: instagram.isConfigured() ? 'Set up' : 'Not set up — nothing will post', inline: true },
			{ name: 'Custom message', value: instagramMessage ? instagramMessage.slice(0, 1024) : 'None — just the ping' },
		)
		.setDescription(lines.length ? lines.join('\n') : 'No accounts yet. Add one with `/instagram add`.');

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
	feature: 'instagram',
	data: new SlashCommandBuilder()
		.setName('instagram')
		.setDescription('Share new Instagram posts from followed accounts in a dedicated channel.')
		.addSubcommand((sub) => sub
			.setName('add')
			.setDescription('(Mod) Follow an Instagram account — it must be a public Business or Creator account.')
			.addStringOption((option) => option
				.setName('account')
				.setDescription('Instagram username, @username or instagram.com link')
				.setMinLength(1)
				.setMaxLength(MAX_CHOICE_LENGTH)
				.setRequired(true)))
		.addSubcommand((sub) => sub
			.setName('channel')
			.setDescription('(Mod) Choose the channel new posts go to, and optionally a role to ping.')
			.addChannelOption((option) => option
				.setName('channel')
				.setDescription('Channel for Instagram posts')
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
			.setDescription('(Mod) Stop sharing Instagram posts. The account list is kept.'))
		.addSubcommand((sub) => sub
			.setName('remove')
			.setDescription('(Mod) Stop following an Instagram account.')
			.addStringOption((option) => option
				.setName('account')
				.setDescription('Account to remove (pick from the suggestions)')
				.setAutocomplete(true)
				.setRequired(true)))
		.addSubcommand((sub) => sub
			.setName('list')
			.setDescription('(Mod) Show the Instagram settings and every followed account.')),
	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();
		const handler = HANDLERS[subcommand];
		if (!handler) throw new Error(`Unknown /instagram subcommand: ${subcommand}`);
		await handler(interaction);
	},
	// Suggestions for /instagram remove — this guild's list only, and only for
	// admins. Not a security boundary on its own (a typed value needn't come
	// from here), which is why removeAccount also scopes by guild_id.
	async autocomplete(interaction) {
		if (!isMod(interaction.member, interaction.guildId)) {
			await interaction.respond([]);
			return;
		}
		const typed = interaction.options.getFocused().toLowerCase().replace(/^@/, '');
		const choices = instagramStore.listAccountsForGuild(interaction.guildId)
			.filter((account) => account.username.toLowerCase().includes(typed))
			.slice(0, MAX_AUTOCOMPLETE_CHOICES)
			.map((account) => ({ name: `@${account.username}`.slice(0, MAX_CHOICE_LENGTH), value: account.accountId }));
		await interaction.respond(choices);
	},
};
