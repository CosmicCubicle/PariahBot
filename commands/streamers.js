const { SlashCommandBuilder, ChannelType, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const streamerStore = require('../state/streamers');
const guildSettings = require('../state/guildSettings');
const { PLATFORMS, requireConfigured } = require('../lib/streamPlatforms');
const { isAdmin, requireAdmin } = require('../lib/permissions');
const { MESSAGE_PLACEHOLDERS } = require('../lib/streamAlerts');
const { MAX_TEMPLATE_LENGTH, renderAlertContent, unknownPlaceholders } = require('../lib/alertContent');

const EMBED_COLOR = 0x5865f2;
const MAX_LISTED = 50;
const MAX_AUTOCOMPLETE_CHOICES = 25;
// Discord caps autocomplete choice names and values at 100 characters.
const MAX_CHOICE_LENGTH = 100;

const PLATFORM_CHOICES = Object.entries(PLATFORMS).map(([value, { label }]) => ({ name: label, value }));

// Self-linking is only for members the admins have marked as streamers —
// otherwise anyone could make the bot announce any channel. Admins who want
// someone on the list without the role use /streamers add instead.
function requireStreamerRole(interaction) {
	const { streamerRoleId } = guildSettings.getGuildSettings(interaction.guildId);
	if (!streamerRoleId) {
		throw new Error('This server has no streamer role yet — an admin needs to set one with `/setup streamer-role`, or add you directly with `/streamers add`.');
	}
	if (!interaction.member.roles.cache.has(streamerRoleId)) {
		throw new Error(`You need the <@&${streamerRoleId}> role to link a channel. Ask an admin if you stream — they can also add you with \`/streamers add\`.`);
	}
}

// Shared by link and add: defers first (the lookup is a network round trip
// that can outlast Discord's 3-second window), then resolves the typed value
// to a real account so a typo fails now instead of silently never alerting.
async function resolveAccount(interaction, platform) {
	await interaction.deferReply({ ephemeral: true });
	return PLATFORMS[platform].resolve(interaction.options.getString('account'));
}

function describeAccount(platform, name) {
	return PLATFORMS[platform].describe(name);
}

function alertChannelNote(guildId) {
	const { streamAlertChannelId } = guildSettings.getGuildSettings(guildId);
	return streamAlertChannelId
		? `Alerts post in <#${streamAlertChannelId}>.`
		: "Alerts won't post until an admin picks a channel with `/streamers channel`.";
}

function whatAlerts(platform) {
	return platform === 'youtube' ? 'live streams and new uploads' : 'live streams';
}

async function handleLink(interaction) {
	const platform = interaction.options.getString('platform');
	requireConfigured(platform);
	requireStreamerRole(interaction);

	const account = await resolveAccount(interaction, platform);

	// The string option names a streaming account, not a Discord entity; the
	// conflict that matters is another member of this guild already owning it.
	const existing = streamerStore.getLink(interaction.guildId, platform, account.id);
	if (existing?.userId && existing.userId !== interaction.user.id) {
		throw new Error(`${describeAccount(platform, account.name)} is already linked to <@${existing.userId}> in this server. Ask an admin to \`/streamers remove\` it if that's wrong.`);
	}

	streamerStore.setSelfLink(interaction.guildId, platform, interaction.user.id, account.id, account.name);

	const lines = [`Linked ${describeAccount(platform, account.name)} to your account — the server will hear about your ${whatAlerts(platform)}. ${alertChannelNote(interaction.guildId)}`];
	if (existing?.manual) {
		lines.push('An admin had already added this channel, so it keeps alerting even without the streamer role.');
	}
	await interaction.editReply({ content: lines.join('\n') });
}

async function handleUnlink(interaction) {
	const platform = interaction.options.getString('platform');
	const removed = streamerStore.removeSelfLinks(interaction.guildId, interaction.user.id, platform);
	const adminAdded = streamerStore.listLinksForMember(interaction.guildId, interaction.user.id)
		.filter((link) => !platform || link.platform === platform);

	const scope = platform ? `${PLATFORMS[platform].label} channel` : 'channels';
	const lines = [removed
		? `Unlinked your ${scope} — no more alerts for ${removed === 1 ? 'it' : 'them'} here.`
		: `You haven't linked any ${scope} yourself in this server.`];
	if (adminAdded.length) {
		const names = adminAdded.map((link) => describeAccount(link.platform, link.accountName)).join(', ');
		lines.push(`Still on the list because an admin added ${adminAdded.length === 1 ? 'it' : 'them'}: ${names}. Ask an admin to \`/streamers remove\` ${adminAdded.length === 1 ? 'it' : 'them'}.`);
	}
	await interaction.reply({ content: lines.join('\n'), ephemeral: true });
}

async function handleAdd(interaction) {
	requireAdmin(interaction);
	const platform = interaction.options.getString('platform');
	requireConfigured(platform);

	const member = interaction.options.getUser('member');
	const account = await resolveAccount(interaction, platform);
	const existing = streamerStore.getLink(interaction.guildId, platform, account.id);

	streamerStore.addManual(interaction.guildId, platform, account.id, account.name, member?.id);

	const owner = member ?? (existing?.userId ? `<@${existing.userId}>` : null);
	const lines = [
		`Added ${describeAccount(platform, account.name)}${owner ? ` (${owner})` : ''} — the server will hear about its ${whatAlerts(platform)}, whether or not anyone holds the streamer role. ${alertChannelNote(interaction.guildId)}`,
	];
	if (member && existing?.userId && existing.userId !== member.id) {
		lines.push(`It was previously linked to <@${existing.userId}>; it's now attached to ${member}.`);
	}
	await interaction.editReply({ content: lines.join('\n') });
}

async function handleChannel(interaction) {
	requireAdmin(interaction);

	const channel = interaction.options.getChannel('channel');
	const pingRole = interaction.options.getRole('ping_role');

	// Checked up front so a missing permission surfaces now, to the admin,
	// rather than as a silent failure the first time someone goes live.
	const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
	if (!channel.permissionsFor(interaction.guild.members.me).has(needed)) {
		throw new Error(`I can't post embeds in ${channel} — give me View Channel, Send Messages and Embed Links there, then run this again.`);
	}

	guildSettings.setStreamAlerts(interaction.guildId, channel.id, pingRole?.id);

	const notes = [`Stream and upload alerts will post in ${channel}${pingRole ? `, pinging ${pingRole}` : ''}.`];
	if (pingRole && !pingRole.mentionable && !interaction.guild.members.me.permissions.has(PermissionFlagsBits.MentionEveryone)) {
		notes.push(`⚠️ ${pingRole} isn't mentionable, so the ping won't notify anyone. Turn on "Allow anyone to @mention this role" in its settings, or give me Mention Everyone.`);
	}
	const missing = Object.values(PLATFORMS).filter(({ client }) => !client.isConfigured());
	for (const { label, envVars } of missing) {
		notes.push(`⚠️ ${label} isn't set up on this bot's host yet (${envVars}), so ${label} channels won't alert until it is.`);
	}
	await interaction.reply({ content: notes.join('\n'), ephemeral: true });
}

// Sample values for the preview that `message` replies with.
const PREVIEW_VALUES = { name: 'SomeStreamer', title: 'Ranked grind tonight!', url: 'https://www.twitch.tv/somestreamer', platform: 'Twitch' };

async function handleMessage(interaction) {
	requireAdmin(interaction);

	const text = interaction.options.getString('text').trim();
	const unknown = unknownPlaceholders(text, MESSAGE_PLACEHOLDERS);
	if (unknown.length) {
		throw new Error(`I don't know ${unknown.join(', ')}. You can use {name}, {title}, {url}, {platform} and {role}.`);
	}

	guildSettings.setStreamAlertMessage(interaction.guildId, text);
	const { streamAlertRoleId } = guildSettings.getGuildSettings(interaction.guildId);
	const preview = renderAlertContent(text, PREVIEW_VALUES, streamAlertRoleId) ?? '';
	const notes = [
		'Stream and upload alerts will now say:',
		`> ${preview.replace(/\n/g, '\n> ')}`,
		streamAlertRoleId
			? `The ping for <@&${streamAlertRoleId}> goes ${text.includes('{role}') ? 'where {role} is' : 'at the start'}.`
			: 'No ping role is set, so nobody is pinged. Add one with `/streamers channel`.',
		'Only the ping role ever notifies anyone. @everyone or other mentions in the message show as text only.',
	];
	// No mentions allowed: the preview must not ping the role for real.
	await interaction.reply({ content: notes.join('\n'), ephemeral: true, allowedMentions: { parse: [] } });
}

async function handleClearMessage(interaction) {
	requireAdmin(interaction);
	guildSettings.setStreamAlertMessage(interaction.guildId, null);
	await interaction.reply({ content: 'Custom message cleared — alerts go back to just the ping.', ephemeral: true });
}

async function handleDisable(interaction) {
	requireAdmin(interaction);
	guildSettings.clearStreamAlerts(interaction.guildId);
	await interaction.reply({
		content: 'Stream and upload alerts are off. The streamer list is kept — `/streamers channel` turns alerts back on.',
		ephemeral: true,
	});
}

// Autocomplete submits "platform:accountId"; a typed value is a name and
// needs the platform option alongside it.
const PICKED_ACCOUNT_PATTERN = new RegExp(`^(${Object.keys(PLATFORMS).join('|')}):(.+)$`);

// Removes by member (everything attached to them, on every platform) or by
// account (the one channel, which may have no member at all).
async function handleRemove(interaction) {
	requireAdmin(interaction);

	const user = interaction.options.getUser('member');
	const account = interaction.options.getString('account')?.trim();
	if (!user === !account) {
		throw new Error('Give either a member or an account to remove — not both.');
	}

	if (user) {
		const removed = streamerStore.removeByMember(interaction.guildId, user.id);
		await interaction.reply({
			content: removed ? `Removed ${user} from the streamer list (${removed} channel${removed === 1 ? '' : 's'}).` : `${user} isn't on the streamer list.`,
			ephemeral: true,
		});
		return;
	}

	const picked = PICKED_ACCOUNT_PATTERN.exec(account);
	const platform = picked?.[1] ?? interaction.options.getString('platform');
	if (!platform) {
		throw new Error('Pick the account from the suggestions, or also set `platform` so I know which one you mean.');
	}
	const value = picked?.[2] ?? account.replace(/^@/, '');

	const removed = streamerStore.removeByAccount(interaction.guildId, platform, value);
	await interaction.reply({
		content: removed
			? `Removed that ${PLATFORMS[platform].label} channel from the streamer list.`
			: `"${value}" isn't on this server's ${PLATFORMS[platform].label} list — pick one from the suggestions.`,
		ephemeral: true,
	});
}

function describeLink(link) {
	const { link: url } = PLATFORMS[link.platform];
	const channel = `[${describeAccount(link.platform, link.accountName)}](${url(link.accountName, link.accountId)})`;
	const owner = link.userId ? ` → <@${link.userId}>` : '';
	const source = link.manual ? 'added by admin' : 'streamer role';
	return `${channel}${owner} · ${source}`;
}

async function handleList(interaction) {
	requireAdmin(interaction);

	const { streamAlertChannelId, streamAlertRoleId, streamAlertMessage, streamerRoleId } = guildSettings.getGuildSettings(interaction.guildId);
	const links = streamerStore.listLinksForGuild(interaction.guildId);

	const lines = links.slice(0, MAX_LISTED).map(describeLink);
	if (links.length > MAX_LISTED) lines.push(`…and ${links.length - MAX_LISTED} more.`);

	const platformStatus = Object.values(PLATFORMS)
		.map(({ label, client }) => `${label}: ${client.isConfigured() ? 'on' : 'not set up on host'}`)
		.join('\n');

	const embed = new EmbedBuilder()
		.setTitle('Stream and upload alerts')
		.setColor(EMBED_COLOR)
		.addFields(
			{ name: 'Alert channel', value: streamAlertChannelId ? `<#${streamAlertChannelId}>` : 'Not set — alerts are off', inline: true },
			{ name: 'Ping role', value: streamAlertRoleId ? `<@&${streamAlertRoleId}>` : 'None', inline: true },
			{ name: 'Streamer role', value: streamerRoleId ? `<@&${streamerRoleId}>` : 'Not set — only admin-added channels alert', inline: true },
			{ name: 'Platforms', value: platformStatus },
			{ name: 'Custom message', value: streamAlertMessage ? streamAlertMessage.slice(0, 1024) : 'None — just the ping' },
		)
		.setDescription(lines.length ? lines.join('\n') : 'No streamers yet. Members with the streamer role can `/streamers link`, or an admin can `/streamers add`.');

	await interaction.reply({ embeds: [embed], ephemeral: true });
}

const HANDLERS = {
	link: handleLink,
	unlink: handleUnlink,
	add: handleAdd,
	channel: handleChannel,
	message: handleMessage,
	'clear-message': handleClearMessage,
	disable: handleDisable,
	remove: handleRemove,
	list: handleList,
};

function platformOption(option, required, description) {
	return option
		.setName('platform')
		.setDescription(description)
		.addChoices(...PLATFORM_CHOICES)
		.setRequired(required);
}

function accountOption(option, description) {
	return option
		.setName('account')
		.setDescription(description)
		.setMinLength(3)
		.setMaxLength(MAX_CHOICE_LENGTH)
		.setRequired(true);
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName('streamers')
		.setDescription('Twitch and YouTube alerts: streamer-role members link themselves, admins can add anyone.')
		.addSubcommand((sub) => sub
			.setName('link')
			.setDescription('Link your channel so the server hears when you go live or upload (needs the streamer role).')
			.addStringOption((option) => platformOption(option, true, 'Where you stream'))
			.addStringOption((option) => accountOption(option, 'Twitch username, or YouTube @handle / channel link')))
		.addSubcommand((sub) => sub
			.setName('unlink')
			.setDescription('Stop alerts for a channel you linked.')
			.addStringOption((option) => platformOption(option, false, 'Only this platform (default: all of yours)')))
		.addSubcommand((sub) => sub
			.setName('add')
			.setDescription('(Admin) Add a channel to the alert list — no streamer role needed.')
			.addStringOption((option) => platformOption(option, true, 'Where they stream'))
			.addStringOption((option) => accountOption(option, 'Twitch username, or YouTube @handle / channel link'))
			.addUserOption((option) => option
				.setName('member')
				.setDescription('Member who owns the channel (optional — leave empty for a channel outside the server)')
				.setRequired(false)))
		.addSubcommand((sub) => sub
			.setName('channel')
			.setDescription('(Admin) Choose where alerts post, and optionally a role to ping.')
			.addChannelOption((option) => option
				.setName('channel')
				.setDescription('Channel for stream and upload alerts')
				.addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
				.setRequired(true))
			.addRoleOption((option) => option
				.setName('ping_role')
				.setDescription('Role to ping with each alert (optional)')
				.setRequired(false)))
		.addSubcommand((sub) => sub
			.setName('message')
			.setDescription('(Admin) Set custom text for alerts. The ping role is still pinged.')
			.addStringOption((option) => option
				.setName('text')
				.setDescription('Your text. Placeholders: {name} {title} {url} {platform} {role}')
				.setMaxLength(MAX_TEMPLATE_LENGTH)
				.setRequired(true)))
		.addSubcommand((sub) => sub
			.setName('clear-message')
			.setDescription('(Admin) Remove the custom text, so alerts are just the ping again.'))
		.addSubcommand((sub) => sub
			.setName('disable')
			.setDescription('(Admin) Turn off stream and upload alerts. The streamer list is kept.'))
		.addSubcommand((sub) => sub
			.setName('remove')
			.setDescription('(Admin) Remove a streamer by member or by channel.')
			.addUserOption((option) => option
				.setName('member')
				.setDescription('Remove every channel attached to this member')
				.setRequired(false))
			.addStringOption((option) => option
				.setName('account')
				.setDescription('Remove this channel (pick from the suggestions)')
				.setAutocomplete(true)
				.setRequired(false))
			.addStringOption((option) => platformOption(option, false, 'Only needed if you typed a name instead of picking a suggestion')))
		.addSubcommand((sub) => sub
			.setName('list')
			.setDescription('(Admin) Show the alert settings and every streamer on the list.')),
	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();
		const handler = HANDLERS[subcommand];
		if (!handler) throw new Error(`Unknown /streamers subcommand: ${subcommand}`);
		await handler(interaction);
	},
	// Suggestions for /streamers remove account — this guild's list only, and
	// only for admins (non-admins get none rather than seeing the list). Not a
	// security boundary on its own (a typed value needn't come from here),
	// which is why removeByAccount also scopes by guild_id.
	async autocomplete(interaction) {
		if (!isAdmin(interaction.member, interaction.guildId)) {
			await interaction.respond([]);
			return;
		}
		const typed = interaction.options.getFocused().toLowerCase();
		const choices = streamerStore.listLinksForGuild(interaction.guildId)
			.filter((link) => link.accountName.toLowerCase().includes(typed))
			.slice(0, MAX_AUTOCOMPLETE_CHOICES)
			.map((link) => ({
				name: `${describeAccount(link.platform, link.accountName)}${link.manual ? ' · added by admin' : ''}`.slice(0, MAX_CHOICE_LENGTH),
				value: `${link.platform}:${link.accountId}`.slice(0, MAX_CHOICE_LENGTH),
			}));
		await interaction.respond(choices);
	},
};
