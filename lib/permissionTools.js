const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	EmbedBuilder,
	OverwriteType,
	PermissionFlagsBits: F,
	PermissionsBitField,
} = require('discord.js');
const { isAdmin, isMod, staffRoleIds } = require('./permissions');
const { sendAlert } = require('./alertDelivery');
const features = require('./features');

// The rules behind /perms (#100): copying a role, the access report, and
// hiding, showing or muting a channel or category. Kept apart from
// commands/perms.js so the decisions can be tested without Discord.

// Copy's preview carries everything Confirm needs in its customId:
// perms:copy:<mode>:<sourceRoleId>:<targetRoleId>. Nothing is held in memory
// between the preview and the click (WorkingAgreements.md § 1), and Confirm
// recomputes the plan, so it acts on the server as it is by then.
const COPY_BUTTON_PREFIX = 'perms:copy:';
const CANCEL_BUTTON_ID = 'perms:cancel';

const COPY_MODES = ['add', 'replace'];

// Never copied: a role with it skips every channel override, so copying it
// would be a different and much bigger change than "the same access".
const NEVER_COPIED = F.Administrator;

function copyButtonId(mode, sourceId, targetId) {
	return `${COPY_BUTTON_PREFIX}${mode}:${sourceId}:${targetId}`;
}

function parseCopyButtonId(customId) {
	if (!customId.startsWith(COPY_BUTTON_PREFIX)) return null;
	const [mode, sourceId, targetId] = customId.slice(COPY_BUTTON_PREFIX.length).split(':');
	if (!COPY_MODES.includes(mode) || !sourceId || !targetId) return null;
	return { mode, sourceId, targetId };
}

// "ViewChannel" → "View Channel", for replies and alerts.
function permissionNames(bits) {
	return new PermissionsBitField(bits).toArray().map((name) => name.replace(/([a-z])([A-Z])/g, '$1 $2'));
}

const VOICE_TYPES = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

// What "speaking" means where: typing in a text channel, talking and typing
// in a voice channel's own chat. A category holds both kinds, so it gets both.
function speakBits(channelType) {
	if (VOICE_TYPES.has(channelType) || channelType === ChannelType.GuildCategory) return F.SendMessages | F.Speak;
	return F.SendMessages;
}

// /perms show also allows reading history: being able to see a channel but
// none of what was said before is rarely what's meant.
const HIDE_BITS = F.ViewChannel;
const SHOW_BITS = F.ViewChannel | F.ReadMessageHistory;

// The plan /perms copy previews and then applies. Bitfields are BigInts.
//
//   source/target: { permissions, overwrites: Map(channelId → { allow, deny }) }
//
// add:     the target keeps what it has and gains the source's server-wide
//          permissions and channel overrides. Where both have an override on
//          a channel, the source's choice wins for each permission it sets.
// replace: the target ends up the same as the source: same server-wide
//          permissions, same overrides, and its own overrides removed from
//          channels where the source has none.
//
// Administrator is never copied or removed (NEVER_COPIED).
function planCopy(source, target, mode) {
	const keep = target.permissions & NEVER_COPIED;
	const sourcePermissions = source.permissions & ~NEVER_COPIED;
	const nextPermissions = mode === 'replace'
		? sourcePermissions | keep
		: target.permissions | sourcePermissions;

	const overwrites = [];
	for (const [channelId, from] of source.overwrites) {
		const current = target.overwrites.get(channelId);
		const next = mode === 'replace' || !current
			? { allow: from.allow, deny: from.deny }
			: { allow: (current.allow & ~from.deny) | from.allow, deny: (current.deny & ~from.allow) | from.deny };
		if (current && current.allow === next.allow && current.deny === next.deny) continue;
		overwrites.push({ channelId, action: current ? 'update' : 'create', ...next });
	}
	if (mode === 'replace') {
		for (const channelId of target.overwrites.keys()) {
			if (!source.overwrites.has(channelId)) overwrites.push({ channelId, action: 'remove', allow: 0n, deny: 0n });
		}
	}

	return {
		permissions: {
			next: nextPermissions,
			added: nextPermissions & ~target.permissions,
			removed: target.permissions & ~nextPermissions,
		},
		overwrites,
	};
}

// The bits a change to an override touches: Discord refuses to set either
// way a permission the bot doesn't hold there. A removal touches what the
// existing override set.
function touchedBits(change, existing) {
	return change.allow | change.deny | (existing ? existing.allow | existing.deny : 0n);
}

// Whether a mod may restrict this target. Admins may restrict anyone; a mod
// may not restrict staff (WorkingAgreements.md § 3: the bot isn't a tool one
// moderator uses against another). @everyone is allowed: it's the usual way
// to make a channel private, and staff keep access through their own roles.
function isStaffTarget(target, guildId) {
	if (target.member) return isMod(target.member, guildId);
	if (target.role.id === guildId) return false;
	return staffRoleIds(guildId).includes(target.role.id) || target.role.permissions.has(F.Administrator);
}

function requireMayRestrict(invoker, target, guildId) {
	if (isAdmin(invoker, guildId) || !isStaffTarget(target, guildId)) return;
	throw new Error(`${target.label} is staff (an admin or mod role, or someone with one). Only admins can restrict staff with /perms.`);
}

// The access report: each role sorted into a group by what it can do in the
// channel. `roles` is [{ id, permissions }] with permissions already worked
// out for the channel (discord.js permissionsFor). Administrator counts as
// everything, as it does in Discord.
function groupByAccess(roles, capabilities) {
	const groups = new Map();
	for (const role of roles) {
		const admin = (role.permissions & F.Administrator) === F.Administrator;
		const has = (bit) => (role.permissions & bit) === bit;
		// Without View Channel nothing else applies, so it's not listed as such.
		const can = has(F.ViewChannel) ? capabilities.filter(([, bit]) => has(bit)).map(([label]) => label) : [];
		const key = admin ? 'Administrator (sees and does everything)' : (can.length ? `Can ${can.join(', ')}` : "Can't see it");
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(role.id);
	}
	return groups;
}

// What the report checks, by channel type. "see" is always first, since
// without it nothing else applies.
function reportCapabilities(channelType) {
	const capabilities = [['see', F.ViewChannel], ['send messages', F.SendMessages]];
	if (VOICE_TYPES.has(channelType) || channelType === ChannelType.GuildCategory) {
		capabilities.push(['connect', F.Connect], ['speak', F.Speak]);
	}
	return capabilities;
}

// --- Talking to Discord ---------------------------------------------------------

const INFO_COLOR = 0x5865f2;

// Discord caps an embed field's value at 1,024 characters.
const MAX_FIELD_LENGTH = 1024;

// Joins lines until the next would overflow a field, then says how many were
// left out.
function fitLines(lines, separator = '\n', max = MAX_FIELD_LENGTH) {
	const shown = [];
	let length = 0;
	for (const [index, line] of lines.entries()) {
		const remaining = lines.length - index;
		const more = remaining > 1 ? `${separator}…and ${remaining - 1} more` : '';
		if (length + line.length + separator.length + more.length > max) {
			shown.push(`…and ${remaining} more`);
			break;
		}
		shown.push(line);
		length += line.length + separator.length;
	}
	return shown.join(separator);
}

// The permission names Discord's overwrite API takes, set to one value.
function flagsSetTo(bits, value) {
	return Object.fromEntries(new PermissionsBitField(bits).toArray().map((name) => [name, value]));
}

// What the bot lacks to set these bits on an override in this channel. It
// needs Manage Roles (shown as Manage Permissions on a channel) and View
// Channel to edit overrides at all, and Discord refuses to allow or deny a
// permission the bot doesn't itself hold there.
function missingForOverwrite(channel, bits) {
	const have = channel.permissionsFor(channel.guild.members.me);
	if (have.has(F.Administrator)) return 0n;
	return (bits | F.ManageRoles | F.ViewChannel) & ~have.bitfield;
}

function overwritesOf(guild, roleId) {
	const found = new Map();
	for (const channel of guild.channels.cache.values()) {
		const overwrite = channel.permissionOverwrites?.cache.get(roleId);
		if (overwrite) found.set(channel.id, { allow: overwrite.allow.bitfield, deny: overwrite.deny.bitfield });
	}
	return found;
}

// Everything /perms copy checks before showing a preview, and again on
// Confirm. Throws the fix when the copy can't go ahead at all; channels the
// bot can't change are listed as skipped instead.
function prepareCopy(guild, invoker, sourceId, targetId, mode) {
	const source = guild.roles.cache.get(sourceId);
	const target = guild.roles.cache.get(targetId);
	if (!source || !target) throw new Error('One of those roles no longer exists.');
	if (source.id === target.id) throw new Error('Pick two different roles.');
	if (target.id === guild.id) throw new Error("@everyone can't be the role copied onto. Pick the role that should get the access.");
	if (target.managed) throw new Error(`${target} belongs to a bot or integration, so its permissions can't be edited.`);

	const me = guild.members.me;
	if (me.roles.highest.comparePositionTo(target) <= 0) {
		throw new Error(`My highest role isn't above ${target}, so I can't edit it. Move my role above it in Server Settings → Roles.`);
	}
	// Discord's own rule for editing roles, kept so the bot can't be used to
	// get around it.
	if (guild.ownerId !== invoker.id && invoker.roles.highest.comparePositionTo(target) <= 0) {
		throw new Error(`${target} isn't below your highest role, so Discord wouldn't let you edit it either.`);
	}

	const plan = planCopy(
		{ permissions: source.permissions.bitfield, overwrites: overwritesOf(guild, source.id) },
		{ permissions: target.permissions.bitfield, overwrites: overwritesOf(guild, target.id) },
		mode,
	);

	const changed = plan.permissions.added | plan.permissions.removed;
	const lacking = me.permissions.has(F.Administrator) ? 0n : changed & ~me.permissions.bitfield;
	if (lacking) {
		throw new Error(`I don't have ${permissionNames(lacking).join(', ')} myself, so I can't change it on ${target}. Give my role those permissions, or edit them by hand.`);
	}

	const targetOverwrites = overwritesOf(guild, target.id);
	const applicable = [];
	const skipped = [];
	for (const change of plan.overwrites) {
		const channel = guild.channels.cache.get(change.channelId);
		const missing = channel ? missingForOverwrite(channel, touchedBits(change, targetOverwrites.get(change.channelId))) : 0n;
		if (!channel) continue;
		if (missing) skipped.push({ channel, change, missing });
		else applicable.push({ channel, change });
	}

	return { source, target, mode, plan, applicable, skipped, administratorLeftOut: source.permissions.has(F.Administrator) };
}

const ACTION_LABELS = { create: 'add override', update: 'update override', remove: 'remove override' };

function copyPreview(prepared) {
	const { source, target, mode, plan, applicable, skipped } = prepared;
	const { added, removed } = plan.permissions;
	const serverLines = [
		added ? `**Adds:** ${permissionNames(added).join(', ')}` : null,
		removed ? `**Removes:** ${permissionNames(removed).join(', ')}` : null,
	].filter(Boolean);

	const embed = new EmbedBuilder()
		.setColor(INFO_COLOR)
		.setTitle(`Copy ${source.name} → ${target.name} (${mode})`)
		.setDescription([
			mode === 'replace'
				? `${target} will end up with the same permissions and channel access as ${source}. Its own overrides on other channels are removed.`
				: `${target} keeps what it has, and gains ${source}'s permissions and channel access.`,
			prepared.administratorLeftOut ? `${source} has Administrator. That's never copied.` : null,
			'Nothing changes until you press **Confirm**.',
		].filter(Boolean).join('\n'))
		.addFields(
			{ name: 'Server-wide permissions', value: serverLines.length ? serverLines.join('\n').slice(0, MAX_FIELD_LENGTH) : 'No change' },
			{ name: `Channels (${applicable.length})`, value: applicable.length ? fitLines(applicable.map(({ channel, change }) => `${channel} — ${ACTION_LABELS[change.action]}`)) : 'No change' },
		);
	if (skipped.length) {
		embed.addFields({
			name: `Skipped (${skipped.length})`,
			value: fitLines(skipped.map(({ channel, missing }) => `${channel} — I'm missing ${permissionNames(missing).join(', ')} there`)),
		});
	}
	return embed;
}

function copyButtons(prepared) {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId(copyButtonId(prepared.mode, prepared.source.id, prepared.target.id))
			.setLabel('Confirm')
			.setStyle(prepared.mode === 'replace' ? ButtonStyle.Danger : ButtonStyle.Primary),
		new ButtonBuilder().setCustomId(CANCEL_BUTTON_ID).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
	);
}

function copyHasChanges(prepared) {
	return Boolean(prepared.plan.permissions.added || prepared.plan.permissions.removed || prepared.applicable.length);
}

async function applyCopy(prepared, user) {
	const { target, plan, applicable } = prepared;
	const reason = `Copied from ${prepared.source.name} via /perms copy by ${user.tag}`;
	const failed = [];

	if (plan.permissions.added || plan.permissions.removed) {
		await target.setPermissions(plan.permissions.next, reason);
	}
	let done = 0;
	for (const { channel, change } of applicable) {
		try {
			if (change.action === 'remove') {
				await channel.permissionOverwrites.delete(target.id, reason);
			} else {
				// create() replaces the whole override, so permissions left out end
				// up neutral, which is what the plan describes.
				await channel.permissionOverwrites.create(target.id,
					{ ...flagsSetTo(change.allow, true), ...flagsSetTo(change.deny, false) },
					{ reason, type: OverwriteType.Role });
			}
			done++;
		} catch (error) {
			failed.push(`${channel} — ${error.message}`);
		}
	}
	return { done, failed };
}

// Every /perms change is reported, like moderation actions are.
async function alertPermsChange(guild, user, title, lines) {
	const embed = new EmbedBuilder()
		.setColor(INFO_COLOR)
		.setTitle(title)
		.setDescription(fitLines(lines, '\n', 4096))
		.setFooter({ text: `By ${user.tag}` })
		.setTimestamp();
	await sendAlert(guild, { embeds: [embed], allowedMentions: { parse: [] } }).catch((error) => {
		console.error(`Perms: failed to send alert in guild ${guild.id}:`, error.message);
	});
}

// Confirm and Cancel on a /perms copy preview. The preview is ephemeral, so
// only the admin who ran the command sees the buttons; the clicker is still
// checked, as with any button.
async function handlePermsButtonInteraction(interaction) {
	if (interaction.customId === CANCEL_BUTTON_ID) {
		await interaction.update({ content: 'Cancelled. Nothing was changed.', embeds: [], components: [] });
		return true;
	}
	const parsed = parseCopyButtonId(interaction.customId);
	if (!parsed) return false;

	if (!interaction.inGuild() || !interaction.member) throw new Error('This only works in the server it came from.');
	if (!features.isEnabled(interaction.guildId, 'permissionTools')) throw new Error(features.disabledMessage('permissionTools'));
	if (!isAdmin(interaction.member, interaction.guildId)) throw new Error('Only admins can copy role permissions.');

	// Recomputed rather than trusted from the preview: roles and channels may
	// have changed since, and the button's IDs are all it carries.
	const prepared = prepareCopy(interaction.guild, interaction.member, parsed.sourceId, parsed.targetId, parsed.mode);
	await interaction.deferUpdate();
	const { done, failed } = await applyCopy(prepared, interaction.user);

	const lines = [
		`Copied ${prepared.source} → ${prepared.target} (${prepared.mode}).`,
		prepared.plan.permissions.added || prepared.plan.permissions.removed ? 'Server-wide permissions updated.' : 'Server-wide permissions were already the same.',
		`Channel overrides changed: ${done}.`,
		prepared.skipped.length ? `Skipped, missing my permissions: ${prepared.skipped.length}.` : null,
		failed.length ? `Failed: ${failed.length}\n${fitLines(failed, '\n', 1500)}` : null,
	].filter(Boolean);
	await interaction.editReply({ content: lines.join('\n'), embeds: [], components: [], allowedMentions: { parse: [] } });
	await alertPermsChange(interaction.guild, interaction.user, 'Role permissions copied', lines);
	return true;
}

module.exports = {
	COPY_BUTTON_PREFIX,
	CANCEL_BUTTON_ID,
	COPY_MODES,
	NEVER_COPIED,
	HIDE_BITS,
	SHOW_BITS,
	copyButtonId,
	parseCopyButtonId,
	permissionNames,
	speakBits,
	planCopy,
	touchedBits,
	isStaffTarget,
	requireMayRestrict,
	groupByAccess,
	reportCapabilities,
	INFO_COLOR,
	fitLines,
	flagsSetTo,
	missingForOverwrite,
	prepareCopy,
	copyPreview,
	copyButtons,
	copyHasChanges,
	alertPermsChange,
	handlePermsButtonInteraction,
};
