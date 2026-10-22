const {
	SlashCommandBuilder,
	ChannelType,
	EmbedBuilder,
	GuildMember,
	OverwriteType,
	PermissionFlagsBits,
	Role,
} = require('discord.js');
const { requireAdmin, requireMod } = require('../lib/permissions');
const tools = require('../lib/permissionTools');

// Channel and category permissions from Discord (#100). The rules — who may
// restrict whom, what a copy changes, how the report groups roles — are in
// lib/permissionTools.js; this file is the Discord side.
//
// Access: report, hide, show and speak are Mod; copy is Admin, since it
// changes a role server-wide. Hide and muting with speak refuse a mod whose
// target is staff.

const CHANNEL_TYPES = [
	ChannelType.GuildText,
	ChannelType.GuildAnnouncement,
	ChannelType.GuildForum,
	ChannelType.GuildVoice,
	ChannelType.GuildStageVoice,
	ChannelType.GuildCategory,
];

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

// The category alone, or the category and every channel in it.
function channelsToChange(interaction, channel) {
	if (channel.type !== ChannelType.GuildCategory || !interaction.options.getBoolean('include_channels')) return [channel];
	const children = interaction.guild.channels.cache
		.filter((child) => child.parentId === channel.id)
		.sort((a, b) => a.rawPosition - b.rawPosition);
	return [channel, ...children.values()];
}

// Whether restricting this target would also restrict the bot: @everyone, or
// a role the bot has.
function targetIncludesBot(guild, target) {
	return target.type === OverwriteType.Role && (target.id === guild.id || guild.members.me.roles.cache.has(target.id));
}

// Same idea as ensureBotRetainsConnect in commands/vc.js: before denying a
// role the bot holds, give the bot its own allow for those permissions while
// it still has them. Otherwise it would lose them too, and Discord only lets
// it change permissions it holds, so it could never undo the change.
async function keepBotAccess(channel, bits, reason) {
	const me = channel.guild.members.me;
	if (channel.permissionsFor(me).has(PermissionFlagsBits.Administrator)) return;
	const own = channel.permissionOverwrites.cache.get(me.id);
	if (own && (own.allow.bitfield & bits) === bits) return;
	await channel.permissionOverwrites.edit(me.id, tools.flagsSetTo(bits, true), { reason, type: OverwriteType.Member });
}

// Shared by hide, show and speak: set `bits` to `value` for the target on the
// channel (and, if asked, every channel in the category), then report it.
async function changeAccess(interaction, { channel, target, bitsFor, value, verb, undo }) {
	const channels = channelsToChange(interaction, channel);
	const reason = `${verb} via /perms by ${interaction.user.tag}`;
	const protectBot = value === false && targetIncludesBot(interaction.guild, target);

	// The channel that was named has to work, or nothing is changed. Channels
	// inside a category are skipped one by one instead, and listed.
	const firstMissing = tools.missingForOverwrite(channel, bitsFor(channel));
	if (firstMissing) {
		throw new Error(`I need ${tools.permissionNames(firstMissing).join(', ')} in ${channel} to change it. Give my role those there, then run this again.`);
	}

	await interaction.deferReply({ ephemeral: true });
	const changed = [];
	const skipped = [];
	for (const each of channels) {
		const bits = bitsFor(each);
		const missing = tools.missingForOverwrite(each, bits);
		if (missing) {
			skipped.push(`${each} — I'm missing ${tools.permissionNames(missing).join(', ')} there`);
			continue;
		}
		try {
			if (protectBot) await keepBotAccess(each, bits, reason);
			await each.permissionOverwrites.edit(target.id, tools.flagsSetTo(bits, value), { reason, type: target.type });
			changed.push(`${each}`);
		} catch (error) {
			skipped.push(`${each} — ${error.message}`);
		}
	}

	const lines = [
		`${verb} for ${target.label} in ${changed.length === 1 ? changed[0] : `${changed.length} channels`}.`,
		changed.length > 1 ? tools.fitLines(changed, ', ', 1000) : null,
		channel.type === ChannelType.GuildCategory && channels.length === 1
			? 'Only the category changed. Channels synced to it follow; others keep their own settings (add `include_channels:True` to change them too).'
			: null,
		skipped.length ? `Skipped ${skipped.length}:\n${tools.fitLines(skipped, '\n', 800)}` : null,
		protectBot ? 'I kept my own access with an override for myself, so I can still undo this.' : null,
		`To undo: ${undo}`,
	].filter(Boolean);

	await interaction.editReply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
	if (changed.length) await tools.alertPermsChange(interaction.guild, interaction.user, `Channel permissions: ${verb.toLowerCase()}`, lines.slice(0, -1));
}

function restrictChecks(interaction, target) {
	if (target.id === interaction.client.user.id) throw new Error("I can't restrict myself — I'd lose the access needed to undo it.");
	tools.requireMayRestrict(interaction.member, target, interaction.guildId);
}

async function handleHide(interaction) {
	requireMod(interaction);
	const channel = interaction.options.getChannel('channel');
	const target = resolveTarget(interaction);
	requireInvokerSees(interaction, channel);
	restrictChecks(interaction, target);

	await changeAccess(interaction, {
		channel,
		target,
		bitsFor: () => tools.HIDE_BITS,
		value: false,
		verb: 'Hidden',
		undo: `\`/perms show\` with the same channel and ${target.label}.`,
	});
}

async function handleShow(interaction) {
	requireMod(interaction);
	const channel = interaction.options.getChannel('channel');
	const target = resolveTarget(interaction);
	requireInvokerSees(interaction, channel);

	await changeAccess(interaction, {
		channel,
		target,
		bitsFor: () => tools.SHOW_BITS,
		value: true,
		verb: 'Shown (with message history)',
		undo: `\`/perms hide\` with the same channel and ${target.label}.`,
	});
}

// A toggle unless `allowed` says which way: muted if the target's override
// on the named channel lets it speak or says nothing, unmuted if it denies.
// Unmuting sets an explicit allow, so the target can speak there whatever its
// roles say elsewhere.
async function handleSpeak(interaction) {
	requireMod(interaction);
	const channel = interaction.options.getChannel('channel');
	const target = resolveTarget(interaction);
	requireInvokerSees(interaction, channel);

	const chosen = interaction.options.getBoolean('allowed');
	const overwrite = channel.permissionOverwrites.cache.get(target.id);
	const allowed = chosen ?? Boolean(overwrite?.deny.any(tools.speakBits(channel.type)));
	if (!allowed) restrictChecks(interaction, target);

	await changeAccess(interaction, {
		channel,
		target,
		bitsFor: (each) => tools.speakBits(each.type),
		value: allowed,
		verb: allowed ? 'Allowed to speak' : 'Stopped from speaking',
		undo: `run \`/perms speak\` again with the same channel and ${target.label}.`,
	});
}

async function handleReport(interaction) {
	requireMod(interaction);
	const channel = interaction.options.getChannel('channel');
	requireInvokerSees(interaction, channel);

	const capabilities = tools.reportCapabilities(channel.type);
	const roles = [...interaction.guild.roles.cache.values()]
		.sort((a, b) => b.position - a.position)
		.map((role) => ({ id: role.id, permissions: channel.permissionsFor(role).bitfield }));
	const groups = tools.groupByAccess(roles, capabilities);
	const mention = (id) => (id === interaction.guildId ? '@everyone' : `<@&${id}>`);

	const memberOverrides = channel.permissionOverwrites.cache
		.filter((overwrite) => overwrite.type === OverwriteType.Member)
		.map((overwrite) => {
			const describe = (bits, word) => {
				const labels = capabilities.filter(([, bit]) => (bits & bit) === bit).map(([label]) => label);
				return labels.length ? `${word} ${labels.join(', ')}` : null;
			};
			const parts = [describe(overwrite.allow.bitfield, 'can'), describe(overwrite.deny.bitfield, "can't")].filter(Boolean);
			return `<@${overwrite.id}> — ${parts.length ? parts.join('; ') : 'other permissions only'}`;
		});

	const notes = ['A member can do whatever any of their roles allows here, unless a member override below says otherwise.'];
	if (channel.type === ChannelType.GuildCategory) {
		const children = interaction.guild.channels.cache.filter((child) => child.parentId === channel.id);
		const unsynced = children.filter((child) => !child.permissionsLocked).size;
		notes.push(`${children.size} channels inside; ${unsynced} have their own settings rather than following the category.`);
	} else if (channel.parent) {
		notes.push(channel.permissionsLocked ? `Follows its category, ${channel.parent}.` : `Has its own settings, not ${channel.parent}'s.`);
	}

	const embed = new EmbedBuilder()
		.setColor(tools.INFO_COLOR)
		.setTitle(`Who can use ${channel.name}`)
		.setDescription(notes.join('\n'))
		.addFields([...groups].map(([label, ids]) => ({ name: label, value: tools.fitLines(ids.map(mention), ' ') })));
	if (memberOverrides.length) {
		embed.addFields({ name: 'Member overrides', value: tools.fitLines(memberOverrides) });
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
		.addChannelTypes(...CHANNEL_TYPES)
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
