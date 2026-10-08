const { SlashCommandBuilder, ChannelType, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const streamerStore = require('../state/streamers');
const guildSettings = require('../state/guildSettings');
const twitch = require('../lib/twitch');
const { requireAdmin } = require('../lib/permissions');

const EMBED_COLOR = 0x5865f2;
const MAX_LISTED = 50;

function requireTwitchConfigured() {
	if (!twitch.isConfigured()) {
		throw new Error("Twitch isn't set up on this bot's host yet — the bot owner needs to add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET to hom.env and restart it.");
	}
}

// Linking is self-service, but only for members the admins have marked as
// streamers — otherwise anyone could make the bot announce any channel.
function requireStreamerRole(interaction) {
	const { streamerRoleId } = guildSettings.getGuildSettings(interaction.guildId);
	if (!streamerRoleId) {
		throw new Error('This server has no streamer role yet — an admin needs to set one with `/setup streamer-role`.');
	}
	if (!interaction.member.roles.cache.has(streamerRoleId)) {
		throw new Error(`You need the <@&${streamerRoleId}> role to link a Twitch account. Ask an admin if you stream.`);
	}
}

async function handleLink(interaction) {
	requireTwitchConfigured();
	requireStreamerRole(interaction);

	const username = interaction.options.getString('twitch_username').trim().replace(/^@/, '');
	if (!twitch.isValidLogin(username)) {
		throw new Error(`"${username}" isn't a valid Twitch username — it should be 4–25 letters, numbers or underscores, as it appears in twitch.tv/<username>.`);
	}

	await interaction.deferReply({ ephemeral: true });

	const account = await twitch.getUserByLogin(username);
	if (!account) {
		throw new Error(`Couldn't find a Twitch account called "${username}". Check the spelling against your twitch.tv/<username> link.`);
	}

	// The string option names a Twitch account, not a Discord entity, so the
	// guild isolation concern is this guild's own links — checked here so the
	// error can say who has it, instead of a bare unique-constraint failure.
	const existing = streamerStore.getLinkByTwitch(interaction.guildId, account.id);
	if (existing && existing.userId !== interaction.user.id) {
		throw new Error(`twitch.tv/${account.login} is already linked by <@${existing.userId}> in this server. Ask an admin to \`/streamers remove\` it if that's wrong.`);
	}

	streamerStore.setLink(interaction.guildId, interaction.user.id, account.id, account.login);

	const { streamAlertChannelId } = guildSettings.getGuildSettings(interaction.guildId);
	const where = streamAlertChannelId
		? `Go-live alerts will post in <#${streamAlertChannelId}>.`
		: "Alerts won't post until an admin picks a channel with `/streamers channel`.";
	await interaction.editReply({ content: `Linked twitch.tv/${account.login} to your account. ${where}` });
}

async function handleUnlink(interaction) {
	const removed = streamerStore.removeLink(interaction.guildId, interaction.user.id);
	await interaction.reply({
		content: removed ? 'Unlinked your Twitch account — no more go-live alerts for you here.' : "You don't have a Twitch account linked in this server.",
		ephemeral: true,
	});
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
		content: 'Go-live alerts are off. Linked accounts are kept — `/streamers channel` turns alerts back on.',
		ephemeral: true,
	});
}

async function handleRemove(interaction) {
	requireAdmin(interaction);
	const user = interaction.options.getUser('member');
	const removed = streamerStore.removeLink(interaction.guildId, user.id);
	await interaction.reply({
		content: removed ? `Removed ${user}'s linked Twitch account.` : `${user} doesn't have a Twitch account linked here.`,
		ephemeral: true,
	});
}

async function handleList(interaction) {
	requireAdmin(interaction);

	const { streamAlertChannelId, streamAlertRoleId, streamerRoleId } = guildSettings.getGuildSettings(interaction.guildId);
	const links = streamerStore.listLinksForGuild(interaction.guildId);

	const lines = links.slice(0, MAX_LISTED).map((link) => `<@${link.userId}> → [twitch.tv/${link.twitchLogin}](https://www.twitch.tv/${link.twitchLogin})`);
	if (links.length > MAX_LISTED) lines.push(`…and ${links.length - MAX_LISTED} more.`);

	const embed = new EmbedBuilder()
		.setTitle('Twitch go-live alerts')
		.setColor(EMBED_COLOR)
		.addFields(
			{ name: 'Alert channel', value: streamAlertChannelId ? `<#${streamAlertChannelId}>` : 'Not set — alerts are off', inline: true },
			{ name: 'Ping role', value: streamAlertRoleId ? `<@&${streamAlertRoleId}>` : 'None', inline: true },
			{ name: 'Streamer role', value: streamerRoleId ? `<@&${streamerRoleId}>` : 'Not set — use `/setup streamer-role`', inline: true },
		)
		.setDescription(lines.length ? lines.join('\n') : 'No one has linked a Twitch account yet.');

	await interaction.reply({ embeds: [embed], ephemeral: true });
}

const HANDLERS = {
	link: handleLink,
	unlink: handleUnlink,
	channel: handleChannel,
	disable: handleDisable,
	remove: handleRemove,
	list: handleList,
};

module.exports = {
	data: new SlashCommandBuilder()
		.setName('streamers')
		.setDescription('Twitch go-live alerts for members with the streamer role.')
		.addSubcommand((sub) => sub
			.setName('link')
			.setDescription('Link your Twitch account so the server is alerted when you go live.')
			.addStringOption((option) => option
				.setName('twitch_username')
				.setDescription('Your Twitch username, as in twitch.tv/<username>')
				.setMinLength(4)
				.setMaxLength(26)
				.setRequired(true)))
		.addSubcommand((sub) => sub
			.setName('unlink')
			.setDescription('Stop go-live alerts for your Twitch account.'))
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
			.setDescription('(Admin) Turn off go-live alerts. Linked accounts are kept.'))
		.addSubcommand((sub) => sub
			.setName('remove')
			.setDescription("(Admin) Remove a member's linked Twitch account.")
			.addUserOption((option) => option
				.setName('member')
				.setDescription('Member whose link to remove')
				.setRequired(true)))
		.addSubcommand((sub) => sub
			.setName('list')
			.setDescription('(Admin) Show the alert settings and every linked account.')),
	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();
		const handler = HANDLERS[subcommand];
		if (!handler) throw new Error(`Unknown /streamers subcommand: ${subcommand}`);
		await handler(interaction);
	},
};
