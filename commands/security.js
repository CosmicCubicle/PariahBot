const { SlashCommandBuilder, ChannelType, EmbedBuilder } = require('discord.js');
const guildSettings = require('../state/guildSettings');
const { requireAdmin } = require('../lib/permissions');
const { setupScreeningChannel, applyVisibilityLockdown } = require('../lib/captcha');
const { setupHoneypotChannel } = require('../lib/honeypot');

const EMBED_COLOR = 0x5865f2;
const DEFAULT_SCREENING_CHANNEL_NAME = 'verify';
const DEFAULT_HONEYPOT_CHANNEL_NAME = 'do-not-post';

async function resolveOrCreateChannel(interaction, defaultName) {
	const supplied = interaction.options.getChannel('channel');
	if (supplied) return supplied;

	return interaction.guild.channels.create({
		name: defaultName,
		type: ChannelType.GuildText,
		reason: `Created via /security by ${interaction.user.tag}`,
	});
}

function requireMemberRole(interaction) {
	const { memberRoleId } = guildSettings.getGuildSettings(interaction.guildId);
	if (!memberRoleId) {
		throw new Error(
			'No member role is set, so the captcha would have no role to grant. '
			+ 'Set one first with `/setup member-role role:@YourRole` (or create one on the spot with '
			+ '`/setup member-role name:Members`), then run this again.',
		);
	}

	const role = interaction.guild.roles.cache.get(memberRoleId);
	if (!role) {
		throw new Error('The configured member role no longer exists — set it again with `/setup member-role`.');
	}

	// Checking now rather than letting every single verification fail later
	// with a confusing permissions error.
	if (interaction.guild.members.me.roles.highest.position <= role.position) {
		throw new Error(`My highest role isn't above ${role}, so I couldn't grant it. Move my role above it in Server Settings → Roles, then run this again.`);
	}

	return role;
}

async function handleCaptchaSetup(interaction) {
	requireAdmin(interaction);

	const memberRole = requireMemberRole(interaction);
	const adjustVisibility = interaction.options.getBoolean('adjust_visibility') ?? false;

	// Channel creation plus a message edit plus (optionally) two role edits is
	// more than Discord's 3-second window comfortably allows.
	await interaction.deferReply({ ephemeral: true });

	const channel = await resolveOrCreateChannel(interaction, DEFAULT_SCREENING_CHANNEL_NAME);
	const { screeningMessageId } = guildSettings.getGuildSettings(interaction.guildId);

	const message = await setupScreeningChannel(channel, screeningMessageId);
	guildSettings.setScreening(interaction.guildId, channel.id, message.id);

	const lines = [
		`Captcha enabled in ${channel}.`,
		`Members who pass are given ${memberRole}.`,
	];

	if (adjustVisibility) {
		await applyVisibilityLockdown(interaction.guild, memberRole.id);
		lines.push(
			'',
			'**Server visibility adjusted:** `View Channels` was removed from @everyone and granted to '
			+ `${memberRole}, so unverified members now see only ${channel}. This also covers channels created later. `
			+ 'To undo it, give @everyone `View Channels` back in Server Settings → Roles.',
		);
	} else {
		lines.push(
			'',
			'Visibility was left alone — verified and unverified members currently see the same channels. '
			+ 'Re-run with `adjust_visibility: true` if you want the bot to gate the rest of the server behind verification.',
		);
	}

	await interaction.editReply({ content: lines.join('\n') });
}

async function handleCaptchaDisable(interaction) {
	requireAdmin(interaction);

	const { screeningChannelId } = guildSettings.getGuildSettings(interaction.guildId);
	if (!screeningChannelId) {
		await interaction.reply({ content: "Captcha wasn't enabled.", ephemeral: true });
		return;
	}

	guildSettings.clearScreening(interaction.guildId);

	await interaction.reply({
		content: `Captcha disabled — <#${screeningChannelId}> is no longer a screening channel. `
			+ 'The channel and its message were left in place, and any visibility changes stay as they are.',
		ephemeral: true,
	});
}

async function handleHoneypotSetup(interaction) {
	requireAdmin(interaction);

	const action = interaction.options.getString('action') ?? 'kick';

	await interaction.deferReply({ ephemeral: true });

	const channel = await resolveOrCreateChannel(interaction, DEFAULT_HONEYPOT_CHANNEL_NAME);
	await setupHoneypotChannel(channel);
	guildSettings.setHoneypot(interaction.guildId, channel.id, action);

	await interaction.editReply({
		content: [
			`Honeypot enabled in ${channel}.`,
			action === 'ban'
				? 'Anyone who posts there will be **banned**, and their recent messages deleted.'
				: 'Anyone who posts there will be **removed** (softban — banned then immediately unbanned, so Discord deletes their recent messages but they can rejoin).',
			'',
			'Admins and mod-role members are ignored, so you can safely check on it yourself. '
			+ 'Actions are reported through `/alerts`.',
		].join('\n'),
	});
}

async function handleHoneypotDisable(interaction) {
	requireAdmin(interaction);

	const { honeypotChannelId } = guildSettings.getGuildSettings(interaction.guildId);
	if (!honeypotChannelId) {
		await interaction.reply({ content: "Honeypot wasn't enabled.", ephemeral: true });
		return;
	}

	guildSettings.clearHoneypot(interaction.guildId);

	await interaction.reply({
		content: `Honeypot disabled — posting in <#${honeypotChannelId}> no longer removes anyone. The channel was left in place.`,
		ephemeral: true,
	});
}

async function handleStatus(interaction) {
	requireAdmin(interaction);

	const settings = guildSettings.getGuildSettings(interaction.guildId);

	const captchaLines = settings.screeningChannelId
		? [
			`Screening channel: <#${settings.screeningChannelId}>`,
			settings.memberRoleId ? `Grants: <@&${settings.memberRoleId}>` : '⚠️ No member role set — verification will fail.',
		]
		: ['Not enabled — use `/security captcha setup`.'];

	const honeypotLines = settings.honeypotChannelId
		? [
			`Trap channel: <#${settings.honeypotChannelId}>`,
			`Action: ${settings.honeypotAction === 'ban' ? 'ban' : 'remove (softban)'}`,
		]
		: ['Not enabled — use `/security honeypot setup`.'];

	const embed = new EmbedBuilder()
		.setTitle('Security settings')
		.setColor(EMBED_COLOR)
		.addFields(
			{ name: 'Captcha', value: captchaLines.join('\n') },
			{ name: 'Honeypot', value: honeypotLines.join('\n') },
		);

	await interaction.reply({ embeds: [embed], ephemeral: true });
}

const HANDLERS = {
	'captcha.setup': handleCaptchaSetup,
	'captcha.disable': handleCaptchaDisable,
	'honeypot.setup': handleHoneypotSetup,
	'honeypot.disable': handleHoneypotDisable,
	status: handleStatus,
};

function channelOption(option, description) {
	return option
		.setName('channel')
		.setDescription(description)
		.addChannelTypes(ChannelType.GuildText)
		.setRequired(false);
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName('security')
		.setDescription("Anti-spam protections for this server.")
		.addSubcommandGroup((group) => group
			.setName('captcha')
			.setDescription('Require new members to verify before they get the member role.')
			.addSubcommand((sub) => sub
				.setName('setup')
				.setDescription('(Admin) Enable the captcha and post the verification message.')
				.addChannelOption((option) => channelOption(option, 'Screening channel to use (a new one is created if omitted)'))
				.addBooleanOption((option) => option
					.setName('adjust_visibility')
					.setDescription('Also hide the rest of the server from unverified members (default: no)')
					.setRequired(false)))
			.addSubcommand((sub) => sub
				.setName('disable')
				.setDescription('(Admin) Stop using the captcha.')))
		.addSubcommandGroup((group) => group
			.setName('honeypot')
			.setDescription('A trap channel that removes anyone who posts in it.')
			.addSubcommand((sub) => sub
				.setName('setup')
				.setDescription('(Admin) Enable the honeypot and post its warning message.')
				.addChannelOption((option) => channelOption(option, 'Trap channel to use (a new one is created if omitted)'))
				.addStringOption((option) => option
					.setName('action')
					.setDescription('What to do with anyone who posts there (default: remove)')
					.addChoices(
						{ name: 'Remove (softban — they can rejoin)', value: 'kick' },
						{ name: 'Ban', value: 'ban' },
					)
					.setRequired(false)))
			.addSubcommand((sub) => sub
				.setName('disable')
				.setDescription('(Admin) Stop using the honeypot.')))
		.addSubcommand((sub) => sub
			.setName('status')
			.setDescription('(Admin) Show the captcha and honeypot settings for this server.')),
	async execute(interaction) {
		const group = interaction.options.getSubcommandGroup(false);
		const sub = interaction.options.getSubcommand();
		const key = group ? `${group}.${sub}` : sub;

		const handler = HANDLERS[key];
		if (!handler) throw new Error(`Unknown /security subcommand: ${key}`);
		await handler(interaction);
	},
};
