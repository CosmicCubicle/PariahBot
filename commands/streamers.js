const { SlashCommandBuilder, ChannelType, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const streamerStore = require('../state/streamers');
const guildSettings = require('../state/guildSettings');
const twitch = require('../lib/twitch');
const { isAdmin, requireAdmin } = require('../lib/permissions');

const EMBED_COLOR = 0x5865f2;
const MAX_LISTED = 50;
const MAX_AUTOCOMPLETE_CHOICES = 25;

function requireTwitchConfigured() {
	if (!twitch.isConfigured()) {
		throw new Error("Twitch isn't set up on this bot's host yet — the bot owner needs to add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET to hom.env and restart it.");
	}
}

// Self-linking is only for members the admins have marked as streamers —
// otherwise anyone could make the bot announce any channel. Admins who want
// someone on the list without the role use /streamers add instead.
function requireStreamerRole(interaction) {
	const { streamerRoleId } = guildSettings.getGuildSettings(interaction.guildId);
	if (!streamerRoleId) {
		throw new Error('This server has no streamer role yet — an admin needs to set one with `/setup streamer-role`, or add you directly with `/streamers add`.');
	}
	if (!interaction.member.roles.cache.has(streamerRoleId)) {
		throw new Error(`You need the <@&${streamerRoleId}> role to link a Twitch account. Ask an admin if you stream — they can also add you with \`/streamers add\`.`);
	}
}

// Shared by link and add: validates the typed username, defers (the Twitch
// lookup is a network round trip that can outlast Discord's 3-second window),
// and resolves it to a real account so a typo fails now instead of silently
// never alerting.
async function resolveTwitchAccount(interaction) {
	const username = interaction.options.getString('twitch_username').trim().replace(/^@/, '');
	if (!twitch.isValidLogin(username)) {
		throw new Error(`"${username}" isn't a valid Twitch username — it should be 4–25 letters, numbers or underscores, as it appears in twitch.tv/<username>.`);
	}

	await interaction.deferReply({ ephemeral: true });

	const account = await twitch.getUserByLogin(username);
	if (!account) {
		throw new Error(`Couldn't find a Twitch account called "${username}". Check the spelling against the twitch.tv/<username> link.`);
	}
	return account;
}

function alertChannelNote(guildId) {
	const { streamAlertChannelId } = guildSettings.getGuildSettings(guildId);
	return streamAlertChannelId
		? `Go-live alerts post in <#${streamAlertChannelId}>.`
		: "Alerts won't post until an admin picks a channel with `/streamers channel`.";
}

async function handleLink(interaction) {
	requireTwitchConfigured();
	requireStreamerRole(interaction);

	const account = await resolveTwitchAccount(interaction);

	// The string option names a Twitch account, not a Discord entity; the
	// conflict that matters is another member of this guild already owning it.
	const existing = streamerStore.getLinkByTwitch(interaction.guildId, account.id);
	if (existing?.userId && existing.userId !== interaction.user.id) {
		throw new Error(`twitch.tv/${account.login} is already linked to <@${existing.userId}> in this server. Ask an admin to \`/streamers remove\` it if that's wrong.`);
	}

	streamerStore.setSelfLink(interaction.guildId, interaction.user.id, account.id, account.login);

	const lines = [`Linked twitch.tv/${account.login} to your account. ${alertChannelNote(interaction.guildId)}`];
	if (existing?.manual) {
		lines.push('An admin had already added this channel, so it keeps alerting even without the streamer role.');
	}
	await interaction.editReply({ content: lines.join('\n') });
}

async function handleUnlink(interaction) {
	const removed = streamerStore.removeSelfLinks(interaction.guildId, interaction.user.id);
	const adminAdded = streamerStore.listLinksForMember(interaction.guildId, interaction.user.id);

	const lines = [removed
		? 'Unlinked your Twitch account — no more go-live alerts for it here.'
		: "You haven't linked a Twitch account yourself in this server."];
	if (adminAdded.length) {
		const names = adminAdded.map((link) => `twitch.tv/${link.twitchLogin}`).join(', ');
		lines.push(`${names} was added by an admin, so it's still on the list — ask an admin to \`/streamers remove\` it.`);
	}
	await interaction.reply({ content: lines.join('\n'), ephemeral: true });
}

async function handleAdd(interaction) {
	requireAdmin(interaction);
	requireTwitchConfigured();

	const member = interaction.options.getUser('member');
	const account = await resolveTwitchAccount(interaction);
	const existing = streamerStore.getLinkByTwitch(interaction.guildId, account.id);

	streamerStore.addManual(interaction.guildId, account.id, account.login, member?.id);

	const owner = member ?? (existing?.userId ? `<@${existing.userId}>` : null);
	const lines = [
		`Added twitch.tv/${account.login}${owner ? ` (${owner})` : ''}. It alerts whether or not anyone holds the streamer role. ${alertChannelNote(interaction.guildId)}`,
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

	const notes = [`Go-live alerts will post in ${channel}${pingRole ? `, pinging ${pingRole}` : ''}.`];
	if (pingRole && !pingRole.mentionable && !interaction.guild.members.me.permissions.has(PermissionFlagsBits.MentionEveryone)) {
		notes.push(`⚠️ ${pingRole} isn't mentionable, so the ping won't notify anyone. Turn on "Allow anyone to @mention this role" in its settings, or give me Mention Everyone.`);
	}
	if (!twitch.isConfigured()) {
		notes.push("⚠️ Twitch isn't set up on this bot's host yet (TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET), so nothing will post until it is.");
	}
	await interaction.reply({ content: notes.join('\n'), ephemeral: true });
}

async function handleDisable(interaction) {
	requireAdmin(interaction);
	guildSettings.clearStreamAlerts(interaction.guildId);
	await interaction.reply({
		content: 'Go-live alerts are off. The streamer list is kept — `/streamers channel` turns alerts back on.',
		ephemeral: true,
	});
}

// Removes by member (everything attached to them, self-linked or admin-added)
// or by Twitch username (the one channel, which may have no member at all).
async function handleRemove(interaction) {
	requireAdmin(interaction);

	const user = interaction.options.getUser('member');
	const login = interaction.options.getString('twitch_username')?.trim().replace(/^@/, '');
	if (!user === !login) {
		throw new Error('Give either a member or a Twitch username to remove — not both.');
	}

	if (user) {
		const removed = streamerStore.removeByMember(interaction.guildId, user.id);
		await interaction.reply({
			content: removed ? `Removed ${user} from the streamer list.` : `${user} isn't on the streamer list.`,
			ephemeral: true,
		});
		return;
	}

	const removed = streamerStore.removeByLogin(interaction.guildId, login);
	await interaction.reply({
		content: removed ? `Removed twitch.tv/${login} from the streamer list.` : `twitch.tv/${login} isn't on this server's streamer list — pick one from the suggestions.`,
		ephemeral: true,
	});
}

function describeLink(link) {
	const channel = `[twitch.tv/${link.twitchLogin}](https://www.twitch.tv/${link.twitchLogin})`;
	const owner = link.userId ? ` → <@${link.userId}>` : '';
	const source = link.manual ? 'added by admin' : 'streamer role';
	return `${channel}${owner} · ${source}`;
}

async function handleList(interaction) {
	requireAdmin(interaction);

	const { streamAlertChannelId, streamAlertRoleId, streamerRoleId } = guildSettings.getGuildSettings(interaction.guildId);
	const links = streamerStore.listLinksForGuild(interaction.guildId);

	const lines = links.slice(0, MAX_LISTED).map(describeLink);
	if (links.length > MAX_LISTED) lines.push(`…and ${links.length - MAX_LISTED} more.`);

	const embed = new EmbedBuilder()
		.setTitle('Twitch go-live alerts')
		.setColor(EMBED_COLOR)
		.addFields(
			{ name: 'Alert channel', value: streamAlertChannelId ? `<#${streamAlertChannelId}>` : 'Not set — alerts are off', inline: true },
			{ name: 'Ping role', value: streamAlertRoleId ? `<@&${streamAlertRoleId}>` : 'None', inline: true },
			{ name: 'Streamer role', value: streamerRoleId ? `<@&${streamerRoleId}>` : 'Not set — only admin-added channels alert', inline: true },
		)
		.setDescription(lines.length ? lines.join('\n') : 'No streamers yet. Members with the streamer role can `/streamers link`, or an admin can `/streamers add`.');

	await interaction.reply({ embeds: [embed], ephemeral: true });
}

const HANDLERS = {
	link: handleLink,
	unlink: handleUnlink,
	add: handleAdd,
	channel: handleChannel,
	disable: handleDisable,
	remove: handleRemove,
	list: handleList,
};

module.exports = {
	data: new SlashCommandBuilder()
		.setName('streamers')
		.setDescription('Twitch go-live alerts: streamer-role members link themselves, admins can add anyone.')
		.addSubcommand((sub) => sub
			.setName('link')
			.setDescription('Link your Twitch account so the server is alerted when you go live (needs the streamer role).')
			.addStringOption((option) => option
				.setName('twitch_username')
				.setDescription('Your Twitch username, as in twitch.tv/<username>')
				.setMinLength(4)
				.setMaxLength(26)
				.setRequired(true)))
		.addSubcommand((sub) => sub
			.setName('unlink')
			.setDescription('Stop go-live alerts for the Twitch account you linked.'))
		.addSubcommand((sub) => sub
			.setName('add')
			.setDescription('(Admin) Add a Twitch channel to the alert list — no streamer role needed.')
			.addStringOption((option) => option
				.setName('twitch_username')
				.setDescription('Twitch username, as in twitch.tv/<username>')
				.setMinLength(4)
				.setMaxLength(26)
				.setRequired(true))
			.addUserOption((option) => option
				.setName('member')
				.setDescription('Member who owns the channel (optional — leave empty for a channel outside the server)')
				.setRequired(false)))
		.addSubcommand((sub) => sub
			.setName('channel')
			.setDescription('(Admin) Choose where go-live alerts post, and optionally a role to ping.')
			.addChannelOption((option) => option
				.setName('channel')
				.setDescription('Channel for go-live alerts')
				.addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
				.setRequired(true))
			.addRoleOption((option) => option
				.setName('ping_role')
				.setDescription('Role to ping with each alert (optional)')
				.setRequired(false)))
		.addSubcommand((sub) => sub
			.setName('disable')
			.setDescription('(Admin) Turn off go-live alerts. The streamer list is kept.'))
		.addSubcommand((sub) => sub
			.setName('remove')
			.setDescription('(Admin) Remove a streamer by member or by Twitch username.')
			.addUserOption((option) => option
				.setName('member')
				.setDescription('Remove everything attached to this member')
				.setRequired(false))
			.addStringOption((option) => option
				.setName('twitch_username')
				.setDescription('Remove this Twitch channel')
				.setAutocomplete(true)
				.setRequired(false)))
		.addSubcommand((sub) => sub
			.setName('list')
			.setDescription('(Admin) Show the alert settings and every streamer on the list.')),
	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();
		const handler = HANDLERS[subcommand];
		if (!handler) throw new Error(`Unknown /streamers subcommand: ${subcommand}`);
		await handler(interaction);
	},
	// Suggestions for /streamers remove twitch_username — this guild's list
	// only, and only for admins (non-admins get none rather than seeing the
	// list). Not a security boundary on its own (a typed value needn't come
	// from here), which is why removeByLogin also scopes by guild_id.
	async autocomplete(interaction) {
		if (!isAdmin(interaction.member, interaction.guildId)) {
			await interaction.respond([]);
			return;
		}
		const typed = interaction.options.getFocused().toLowerCase();
		const choices = streamerStore.listLinksForGuild(interaction.guildId)
			.filter((link) => link.twitchLogin.toLowerCase().includes(typed))
			.slice(0, MAX_AUTOCOMPLETE_CHOICES)
			.map((link) => ({
				name: `twitch.tv/${link.twitchLogin}${link.manual ? ' (added by admin)' : ''}`,
				value: link.twitchLogin,
			}));
		await interaction.respond(choices);
	},
};
