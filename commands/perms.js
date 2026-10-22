const { SlashCommandBuilder, ChannelType, EmbedBuilder, GuildMember, OverwriteType, PermissionFlagsBits, Role } = require('discord.js');
const { requireAdmin, requireMod } = require('../lib/permissions');
const tools = require('../lib/permissionTools');

// Channel and category permissions from Discord (#100). The rules — who may
// restrict whom, what a copy changes, how the report groups roles — and the
// Discord work shared with the dashboard are in lib/permissionTools.js.
//
// Access: report, hide, show and speak are Mod; copy is Admin, since it
// changes a role server-wide. Hide and muting with speak refuse a mod whose
// target is staff.

// A role or a member, from the mentionable option. Both are resolved against
// this server by Discord, so nothing typed can reach another one.
function resolveTarget(interaction) {
	const value = interaction.options.getMentionable('target');
	if (value instanceof Role) {
		return { id: value.id, type: OverwriteType.Role, role: value, label: value.id === interaction.guildId ? '@everyone' : `${value}` };
	}
	if (value instanceof GuildMember) {
		return { id: value.id, type: OverwriteType.Member, member: value, label: `${value}` };
	}
	throw new Error("That person isn't in this server.");
}

// Nobody uses /perms to look into, or change, a channel they can't see
// themselves.
function requireInvokerSees(interaction, channel) {
	if (!channel.permissionsFor(interaction.member).has(PermissionFlagsBits.ViewChannel)) {
		throw new Error(`You can't see ${channel} yourself, so /perms won't act on it for you.`);
	}
}

// Shared by hide, show and speak: apply the change, then reply and alert.
async function changeAccess(interaction, channel, target, changeKey) {
	const change = tools.ACCESS_CHANGES[changeKey];
	if (change.value === false) tools.requireMayRestrict(interaction.member, target, interaction.guildId);

	await interaction.deferReply({ ephemeral: true });
	const { channels, changed, skipped, protectBot } = await tools.applyAccessChange(channel, {
		change,
		target,
		includeChannels: interaction.options.getBoolean('include_channels'),
		reason: `${change.verb} via /perms by ${interaction.user.tag}`,
	});

	const undo = changeKey.startsWith('speak')
		? `run \`/perms speak\` again with the same channel and ${target.label}.`
		: `\`/perms ${change.undoWith}\` with the same channel and ${target.label}.`;
	const lines = [
		`${change.verb} for ${target.label} in ${changed.length === 1 ? `${changed[0]}` : `${changed.length} channels`}.`,
		changed.length > 1 ? tools.fitLines(changed.map(String), ', ', 1000) : null,
		channel.type === ChannelType.GuildCategory && channels.length === 1
			? 'Only the category changed. Channels synced to it follow; others keep their own settings (add `include_channels:True` to change them too).'
			: null,
		skipped.length ? `Skipped ${skipped.length}:\n${tools.fitLines(skipped.map(({ channel: each, why }) => `${each} — ${why}`), '\n', 800)}` : null,
		protectBot ? 'I kept my own access with an override for myself, so I can still undo this.' : null,
		`To undo: ${undo}`,
	].filter(Boolean);

	await interaction.editReply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
	if (changed.length) {
		await tools.alertPermsChange(interaction.guild, interaction.user.tag, `Channel permissions: ${change.verb.toLowerCase()}`, lines.slice(0, -1));
	}
}

function options(interaction) {
	const channel = interaction.options.getChannel('channel');
	requireInvokerSees(interaction, channel);
	return { channel, target: resolveTarget(interaction) };
}

async function handleHide(interaction) {
	requireMod(interaction);
	const { channel, target } = options(interaction);
	await changeAccess(interaction, channel, target, 'hide');
}

async function handleShow(interaction) {
	requireMod(interaction);
	const { channel, target } = options(interaction);
	await changeAccess(interaction, channel, target, 'show');
}

// A toggle unless `allowed` says which way: muted if the target's override
// on the named channel lets it speak or says nothing, unmuted if it denies.
// Unmuting sets an explicit allow, so the target can speak there whatever its
// roles say elsewhere.
async function handleSpeak(interaction) {
	requireMod(interaction);
	const { channel, target } = options(interaction);
	const chosen = interaction.options.getBoolean('allowed');
	const overwrite = channel.permissionOverwrites.cache.get(target.id);
	const allowed = chosen ?? Boolean(overwrite?.deny.any(tools.speakBits(channel.type)));
	await changeAccess(interaction, channel, target, allowed ? 'speak-on' : 'speak-off');
}

async function handleReport(interaction) {
	requireMod(interaction);
	const channel = interaction.options.getChannel('channel');
	requireInvokerSees(interaction, channel);

	const report = tools.buildReport(channel);
	const mention = (id) => (id === interaction.guildId ? '@everyone' : `<@&${id}>`);
	const embed = new EmbedBuilder()
		.setColor(tools.INFO_COLOR)
		.setTitle(`Who can use ${channel.name}`)
		.setDescription(report.notes.join('\n'))
		.addFields(report.groups.map(({ label, roles }) => ({ name: label, value: tools.fitLines(roles.map(({ id }) => mention(id)), ' ') })));
	if (report.memberOverrides.length) {
		const lines = report.memberOverrides.map(({ userId, can, cannot }) => {
			const parts = [can.length ? `can ${can.join(', ')}` : null, cannot.length ? `can't ${cannot.join(', ')}` : null].filter(Boolean);
			return `<@${userId}> — ${parts.length ? parts.join('; ') : 'other permissions only'}`;
		});
		embed.addFields({ name: 'Member overrides', value: tools.fitLines(lines) });
	}

	await interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
}

async function handleCopy(interaction) {
	requireAdmin(interaction);
	const source = interaction.options.getRole('from');
	const target = interaction.options.getRole('to');
	const mode = interaction.options.getString('mode') ?? 'add';

	const prepared = tools.prepareCopy(interaction.guild, interaction.member, source.id, target.id, mode);
	if (!tools.copyHasChanges(prepared)) {
		const skipped = prepared.skipped.length ? ` ${prepared.skipped.length} channels need permissions I don't have there.` : '';
		await interaction.reply({ content: `${target} already has everything that copy would give it.${skipped}`, ephemeral: true, allowedMentions: { parse: [] } });
		return;
	}
	await interaction.reply({
		embeds: [tools.copyPreview(prepared)],
		components: [tools.copyButtons(prepared)],
		ephemeral: true,
		allowedMentions: { parse: [] },
	});
}

const HANDLERS = {
	report: handleReport,
	hide: handleHide,
	show: handleShow,
	speak: handleSpeak,
	copy: handleCopy,
};

function channelOption(option, description) {
	return option
		.setName('channel')
		.setDescription(description)
		.addChannelTypes(...tools.PERMS_CHANNEL_TYPES)
		.setRequired(true);
}

function targetOption(option, description) {
	return option.setName('target').setDescription(description).setRequired(true);
}

function includeChannelsOption(option) {
	return option
		.setName('include_channels')
		.setDescription('For a category: also change every channel in it, including ones with their own settings')
		.setRequired(false);
}

module.exports = {
	// Switchable feature set this command belongs to (lib/features.js).
	// events/interactionCreate.js refuses it when the guild has it off.
	feature: 'permissionTools',
	data: new SlashCommandBuilder()
		.setName('perms')
		.setDescription('See and change who can use channels and categories.')
		.addSubcommand((sub) => sub
			.setName('report')
			.setDescription('(Mod) Who can see, and send messages in, a channel or category.')
			.addChannelOption((option) => channelOption(option, 'Channel or category to report on')))
		.addSubcommand((sub) => sub
			.setName('hide')
			.setDescription('(Mod) Hide a channel or category from a role or member.')
			.addChannelOption((option) => channelOption(option, 'Channel or category to hide'))
			.addMentionableOption((option) => targetOption(option, 'Role or member to hide it from'))
			.addBooleanOption(includeChannelsOption))
		.addSubcommand((sub) => sub
			.setName('show')
			.setDescription('(Mod) Show a channel or category to a role or member, with message history.')
			.addChannelOption((option) => channelOption(option, 'Channel or category to show'))
			.addMentionableOption((option) => targetOption(option, 'Role or member to show it to'))
			.addBooleanOption(includeChannelsOption))
		.addSubcommand((sub) => sub
			.setName('speak')
			.setDescription('(Mod) Toggle whether a role or member can send messages (and talk, in voice) there.')
			.addChannelOption((option) => channelOption(option, 'Channel or category'))
			.addMentionableOption((option) => targetOption(option, 'Role or member'))
			.addBooleanOption((option) => option
				.setName('allowed')
				.setDescription('Set it rather than toggle: True lets them speak, False stops them')
				.setRequired(false))
			.addBooleanOption(includeChannelsOption))
		.addSubcommand((sub) => sub
			.setName('copy')
			.setDescription("(Admin) Copy one role's permissions and channel access to another. Shows a preview first.")
			.addRoleOption((option) => option.setName('from').setDescription('Role to copy from').setRequired(true))
			.addRoleOption((option) => option.setName('to').setDescription('Role to copy onto').setRequired(true))
			.addStringOption((option) => option
				.setName('mode')
				.setDescription('add (default): keep what it has. replace: make it the same as the source')
				.addChoices(...tools.COPY_MODES.map((mode) => ({ name: mode, value: mode })))
				.setRequired(false))),
	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();
		const handler = HANDLERS[subcommand];
		if (!handler) throw new Error(`Unknown /perms subcommand: ${subcommand}`);
		await handler(interaction);
	},
};
