const { SlashCommandBuilder, ChannelType, EmbedBuilder } = require('discord.js');
const guildSettings = require('../state/guildSettings');
const { requireAdmin, staffRoleIds } = require('../lib/permissions');
const { setupScreeningChannel, applyVisibilityLockdown } = require('../lib/captcha');
const { setupHoneypotChannel } = require('../lib/honeypot');
const features = require('../lib/features');

const EMBED_COLOR = 0x5865f2;
const DEFAULT_SCREENING_CHANNEL_NAME = 'verify';
const DEFAULT_HONEYPOT_CHANNEL_NAME = 'do-not-post';

// Adopts an existing channel, or makes one. Running a setup command is the
// consent (#92 calls these features "considered consent") — what the bot may
// not do is make a channel and say nothing, so every caller reports what was
// created. Returns { channel, created } for exactly that reason.
//
// `suggestedName` is the default used when no channel and no name are given.
async function resolveChannel(interaction, suggestedName) {
	const supplied = interaction.options.getChannel('channel');
	const name = interaction.options.getString('name');
	const category = interaction.options.getChannel('category');

	if (supplied && name) {
		throw new Error('Pass either `channel:` to use a channel that already exists, or `name:` to have me make one — not both.');
	}
	if (supplied) return { channel: supplied, created: false };

	// Required alongside an explicit name, per #92: naming a channel to be
	// created also means saying where it goes. Not required for the default
	// name below, which has nothing to place deliberately. Discord can't
	// express "required only when another option is set", so it's checked here.
	if (name && !category) {
		throw new Error(`Also pass \`category:\` so I know where to put **#${name}**. Pick an existing category.`);
	}

	const channel = await interaction.guild.channels.create({
		name: name ?? suggestedName,
		type: ChannelType.GuildText,
		parent: category?.id,
		reason: `Created via /security by ${interaction.user.tag}`,
	});

	return { channel, created: true };
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
	features.requireEnabled(interaction, 'captcha');

	const memberRole = requireMemberRole(interaction);
	const adjustVisibility = interaction.options.getBoolean('adjust_visibility') ?? false;

	// Channel creation plus a message edit plus (optionally) two role edits is
	// more than Discord's 3-second window comfortably allows.
	await interaction.deferReply({ ephemeral: true });

	const { channel, created } = await resolveChannel(interaction, DEFAULT_SCREENING_CHANNEL_NAME);
	const { screeningMessageId } = guildSettings.getGuildSettings(interaction.guildId);

	// Staff — admin and mod roles — keep sight of the screening channel.
	const modRoleIds = staffRoleIds(interaction.guildId);

	const message = await setupScreeningChannel(channel, screeningMessageId, {
		restrict: adjustVisibility,
		memberRoleId: memberRole.id,
		modRoleIds,
	});
	guildSettings.setScreening(interaction.guildId, channel.id, message.id);

	// Say it outright when a channel was made. The bot is allowed to create
	// one here because running setup is the request, but it is never allowed
	// to do it quietly (WorkingAgreements.md § 7).
	const lines = [
		created ? `**I created ${channel}** for this.` : null,
		`Captcha enabled in ${channel}.`,
		`Members who pass are given ${memberRole}.`,
	].filter(Boolean);

	if (adjustVisibility) {
		await applyVisibilityLockdown(interaction.guild, memberRole.id);

		const modMentions = modRoleIds.length
			? modRoleIds.map((id) => `<@&${id}>`).join(', ')
			: 'no mod roles are configured, so only Administrators';

		lines.push(
			'',
			'**Server visibility adjusted:**',
			`• ${channel} is now visible only to unverified members and ${modMentions}. Once someone verifies and receives ${memberRole}, the channel disappears for them.`,
			`• \`View Channels\` was removed from @everyone and granted to ${memberRole}, so unverified members see only ${channel}. This also covers channels created later.`,
			'',
			`To undo: give @everyone \`View Channels\` back, and clear the \`View Channels\` deny for ${memberRole} on ${channel} — both in Server Settings.`,
		);
	} else {
		lines.push(
			'',
			`Visibility was left alone — ${channel} stays visible to everyone, and verified and unverified members see the same channels. `
			+ 'Re-run with `adjust_visibility: true` to hide the rest of the server from unverified members, and hide the screening channel from verified ones.',
		);
	}

	await interaction.editReply({ content: lines.join('\n') });
}

async function handleCaptchaDisable(interaction) {
	requireAdmin(interaction);
	features.requireEnabled(interaction, 'captcha');

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
	features.requireEnabled(interaction, 'honeypot');

	const action = interaction.options.getString('action') ?? 'kick';

	await interaction.deferReply({ ephemeral: true });

	const { channel, created } = await resolveChannel(interaction, DEFAULT_HONEYPOT_CHANNEL_NAME);
	await setupHoneypotChannel(channel);
	guildSettings.setHoneypot(interaction.guildId, channel.id, action);

	await interaction.editReply({
		content: [
			// Same as the captcha above: created channels are always called out.
			created ? `**I created ${channel}** for this.` : null,
			`Honeypot enabled in ${channel}.`,
			action === 'ban'
				? 'Anyone who posts there will be **banned**, and their recent messages deleted.'
				: 'Anyone who posts there will be **removed** (softban — banned then immediately unbanned, so Discord deletes their recent messages but they can rejoin).',
			'',
			'Admins and mod-role members are ignored, so you can safely check on it yourself. '
			+ 'Actions are reported through `/alerts`.',
		].filter((line) => line !== null).join('\n'),
	});
}

async function handleHoneypotDisable(interaction) {
	requireAdmin(interaction);
	features.requireEnabled(interaction, 'honeypot');

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

	// A feature switched off (#69) is reported before its configuration: the
	// configuration is still there and still correct, it just isn't running, and
	// saying "screening channel: #verify" alone would imply it was.
	const switchedOff = (feature) => `⛔ Switched off for this server — \`/setup feature enable feature:${feature}\`.`;

	const captchaLines = settings.screeningChannelId
		? [
			...(features.isEnabled(interaction.guildId, 'captcha') ? [] : [switchedOff('captcha')]),
			`Screening channel: <#${settings.screeningChannelId}>`,
			settings.memberRoleId ? `Grants: <@&${settings.memberRoleId}>` : '⚠️ No member role set — verification will fail.',
		]
		: ['Not enabled — use `/security captcha setup`.'];

	const honeypotLines = settings.honeypotChannelId
		? [
			...(features.isEnabled(interaction.guildId, 'honeypot') ? [] : [switchedOff('honeypot')]),
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

// The create-it-for-me pair (#92). Both optional at the Discord level and
// checked together in resolveChannel: a name without a category is refused,
// because naming a channel to be made also means saying where it goes.
// Omitting everything is fine and makes a channel called `suggestedName` —
// running setup is the request. The reply always says what was created.
function addCreateOptions(sub, suggestedName) {
	return sub
		.addStringOption((option) => option
			.setName('name')
			.setDescription(`Name for a channel to create — needs category: too (default: #${suggestedName})`)
			.setRequired(false))
		.addChannelOption((option) => option
			.setName('category')
			.setDescription('Existing category to create it in — required with name:')
			.addChannelTypes(ChannelType.GuildCategory)
			.setRequired(false));
}

module.exports = {
	// No module-level `feature` (#69), unlike single-feature commands: /security
	// spans two independent switches. The captcha and honeypot groups are gated
	// in their own handlers, and `status` stays available either way — it reports
	// on both, and an admin needs to be able to read the state of something they
	// have switched off.
	data: new SlashCommandBuilder()
		.setName('security')
		.setDescription("Anti-spam protections for this server.")
		.addSubcommandGroup((group) => group
			.setName('captcha')
			.setDescription('Require new members to verify before they get the member role.')
			.addSubcommand((sub) => addCreateOptions(sub, 'verify')
				.setName('setup')
				.setDescription('(Admin) Enable the captcha and post the verification message.')
				.addChannelOption((option) => channelOption(option, 'Existing channel to use (default: I make #verify)'))
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
			.addSubcommand((sub) => addCreateOptions(sub, 'do-not-post')
				.setName('setup')
				.setDescription('(Admin) Enable the honeypot and post its warning message.')
				.addChannelOption((option) => channelOption(option, 'Existing channel to use (default: I make #do-not-post)'))
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
