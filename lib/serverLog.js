const { AuditLogEvent, EmbedBuilder, PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const store = require('../state/serverLog');
const caseStore = require('../state/modCases');
const autoDeleteStore = require('../state/autoDeleteChannels');
const features = require('./features');
const { messageContentEnabled } = require('./intents');

// The server log (#81): what happens in a server, posted to channels its
// admins pick, in four sections that each switch on and off by themselves.
//
// Where each section's events come from, and what that needs:
//   kicksBans, serverChanges — audit log entries (GuildModeration intent), so
//     the bot needs View Audit Log in the server. Discord has no kick event at
//     all, and the audit log is also what names who did something.
//   joinsLeaves — guildMemberAdd/Remove, which need the privileged Guild
//     Members intent (lib/intents.js).
//   messages — messageUpdate/Delete. The text needs the privileged Message
//     Content intent, which is opt-in; without it, who, where and when.
//
// Everything here is best-effort (CodeStandards.md § 5): a log that can't be
// posted is reported on the console and never gets in the way of the event.

const COLOR_INFO = 0x5865f2;
const COLOR_GOOD = 0x57f287;
const COLOR_BAD = 0xed4245;

const FIELD_MAX = 1024;
const POST_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

// The bot writes its case right after Discord confirms a ban or kick, and the
// audit log event for it can arrive first. Waiting this long before looking
// the case up lets it land.
const CASE_WAIT_MS = 2000;
const CASE_WINDOW_MS = 60 * 1000;

// With message text on, discord.js's own cache of recent messages is what the
// "before" of an edit and the text of a deletion come from. These bound it.
const MESSAGE_CACHE_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MESSAGE_SWEEP_INTERVAL_SECONDS = 30 * 60;

// `key` is stored in guild_log_sections.section. Renaming one orphans every
// stored row, so treat these as permanent identifiers.
const SECTIONS = {
	kicksBans: {
		label: 'Kicks and bans',
		description: 'Members kicked, banned and unbanned, by anyone. Ones the bot carried out name their case.',
		needsAuditLog: true,
	},
	joinsLeaves: {
		label: 'Joins and leaves',
		description: 'Members joining and leaving the server.',
		needsAuditLog: false,
	},
	messages: {
		label: 'Messages',
		description: 'Edited and deleted messages. Messages in auto-delete channels are left out.',
		needsAuditLog: false,
	},
	serverChanges: {
		label: 'Server changes',
		description: 'Roles and channels created, edited or deleted, channel permissions, and members gaining or losing roles. Changes the bot makes itself, such as temporary voice channels and role menus, are left out.',
		needsAuditLog: true,
	},
};

const SECTION_KEYS = Object.keys(SECTIONS);

function isSection(key) {
	return Object.hasOwn(SECTIONS, key);
}

// The channel a section posts to right now, or null when it shouldn't post:
// the whole feature off, the section off, or no channel picked.
function activeChannelId(guildId, section) {
	if (!features.isEnabled(guildId, 'logging')) return null;
	const { enabled, channelId } = store.getSection(guildId, section);
	return enabled ? channelId : null;
}

async function post(guild, section, embed) {
	const channelId = activeChannelId(guild.id, section);
	if (!channelId) return;
	const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
	if (!channel) {
		console.error(`ServerLog: the ${section} channel ${channelId} in guild ${guild.id} no longer exists.`);
		return;
	}
	await channel.send({ embeds: [embed.setTimestamp()], allowedMentions: { parse: [] } });
}

// --- What admins see: each section's state and anything stopping it -----------

// Problems that stop a section working fully, worded as fixes, for /logging
// status and the dashboard.
function sectionProblems(guild, section, channelId) {
	const problems = [];
	const me = guild.members.me;
	if (SECTIONS[section].needsAuditLog && !me.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
		problems.push('I need **View Audit Log** to see this. Add it to my PariahBot role in Server Settings → Roles.');
	}
	if (channelId) {
		const channel = guild.channels.cache.get(channelId);
		if (!channel) {
			problems.push('Its channel was deleted. Pick another.');
		} else if (!channel.permissionsFor(me).has(POST_PERMISSIONS)) {
			problems.push(`I can't post in #${channel.name}. Give me View Channel, Send Messages and Embed Links there.`);
		}
	}
	return problems;
}

// Not a problem, just a limit worth knowing about.
function sectionNote(section) {
	if (section === 'messages' && !messageContentEnabled()) {
		return "Shows who edited or deleted a message, where and when, but not the text: the bot's host hasn't switched on message text (SERVER_LOG_MESSAGE_CONTENT).";
	}
	return null;
}

function describeSections(guild) {
	const stored = store.getSections(guild.id);
	return SECTION_KEYS.map((key) => {
		const { enabled, channelId } = stored.get(key) ?? { enabled: false, channelId: null };
		return {
			key,
			label: SECTIONS[key].label,
			description: SECTIONS[key].description,
			enabled,
			channelId,
			problems: sectionProblems(guild, key, channelId),
			note: sectionNote(key),
		};
	});
}

// --- Formatting -------------------------------------------------------------------

function truncate(text, max = FIELD_MAX) {
	const value = String(text ?? '');
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function userLine(user, userId) {
	return user ? `<@${user.id}> (\`${user.tag ?? user.username}\`, ${user.id})` : `<@${userId}> (${userId})`;
}

function relativeTime(timestamp) {
	return timestamp ? `<t:${Math.floor(timestamp / 1000)}:R>` : 'Unknown';
}

// "SendMessages" → "Send Messages"
function permissionName(flag) {
	return flag.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function permissionNames(bits) {
	return new PermissionsBitField(BigInt(bits ?? 0)).toArray().map(permissionName);
}

// "Allowed: + Send Messages; − Attach Files", or null when nothing changed.
function permissionDiffLine(label, oldBits, newBits) {
	const before = new Set(permissionNames(oldBits));
	const after = new Set(permissionNames(newBits));
	const added = [...after].filter((name) => !before.has(name));
	const removed = [...before].filter((name) => !after.has(name));
	if (!added.length && !removed.length) return null;
	const parts = [];
	if (added.length) parts.push(`+ ${added.join(', ')}`);
	if (removed.length) parts.push(`− ${removed.join(', ')}`);
	return `${label}: ${parts.join('; ')}`;
}

const CHANGE_LABELS = {
	name: 'Name',
	topic: 'Topic',
	nsfw: 'Age-restricted',
	rate_limit_per_user: 'Slowmode',
	bitrate: 'Bitrate',
	user_limit: 'User limit',
	parent_id: 'Category',
	color: 'Color',
	hoist: 'Shown separately',
	mentionable: 'Mentionable',
	unicode_emoji: 'Emoji',
};

// Shown as permission differences rather than raw bitfields.
const PERMISSION_KEYS = { permissions: 'Permissions', allow: 'Allowed', deny: 'Denied' };

function formatValue(key, value) {
	if (value === null || value === undefined || value === '') return 'none';
	if (typeof value === 'boolean') return value ? 'yes' : 'no';
	if (key === 'parent_id') return `<#${value}>`;
	if (key === 'color') return `#${Number(value).toString(16).padStart(6, '0')}`;
	if (key === 'rate_limit_per_user') return `${value}s`;
	return truncate(value, 200);
}

// One line per change an audit log entry records. Keys that hold lists or
// objects (a new channel's whole permission set, say) are skipped: the line
// would be unreadable, and the entry's own title already says what happened.
function describeChanges(changes = []) {
	const lines = [];
	for (const change of changes) {
		if (PERMISSION_KEYS[change.key]) {
			const line = permissionDiffLine(PERMISSION_KEYS[change.key], change.old, change.new);
			if (line) lines.push(line);
			continue;
		}
		if (typeof change.old === 'object' && change.old !== null) continue;
		if (typeof change.new === 'object' && change.new !== null) continue;
		const label = CHANGE_LABELS[change.key] ?? change.key;
		lines.push(`${label}: ${formatValue(change.key, change.old)} → ${formatValue(change.key, change.new)}`);
	}
	return lines;
}

// A member's role update records the roles as `$add` and `$remove` lists.
function describeRoleUpdate(changes = []) {
	const lines = [];
	for (const change of changes) {
		const roles = (change.new ?? []).map((role) => `<@&${role.id}>`).join(', ');
		if (change.key === '$add' && roles) lines.push(`Added: ${roles}`);
		if (change.key === '$remove' && roles) lines.push(`Removed: ${roles}`);
	}
	return lines;
}

function changeName(entry, side) {
	return entry.changes?.find((change) => change.key === 'name')?.[side] ?? null;
}

// --- Kicks and bans -----------------------------------------------------------------

// Which case actions a ban or kick by the bot can come from: a softban is a
// ban and an unban, and both are its case.
const MOD_ACTIONS = {
	[AuditLogEvent.MemberKick]: { title: '👢 Member kicked', color: COLOR_BAD, cases: ['kick'] },
	[AuditLogEvent.MemberBanAdd]: { title: '🔨 Member banned', color: COLOR_BAD, cases: ['ban', 'tempban', 'softban'] },
	[AuditLogEvent.MemberBanRemove]: { title: '🔓 Member unbanned', color: COLOR_GOOD, cases: ['unban', 'softban'] },
};

function caseLine(entry) {
	return entry.moderatorId
		? `#${entry.id}, through the bot by <@${entry.moderatorId}>`
		: `#${entry.id}, by the bot on its own (honeypot, automatic timeout or a temporary ban ending)`;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function logModAction(entry, guild) {
	if (!activeChannelId(guild.id, 'kicksBans')) return;
	const spec = MOD_ACTIONS[entry.action];
	const byBot = entry.executorId === guild.client.user.id;

	// Decision 4 in #81: everything is logged, and the bot's own actions name
	// their case, so they can be matched to /mod history and admin alerts.
	let caseEntry = null;
	if (byBot) {
		await sleep(CASE_WAIT_MS);
		const since = new Date(Date.now() - CASE_WINDOW_MS).toISOString();
		caseEntry = caseStore.findRecentCase(guild.id, entry.targetId, spec.cases, since);
	}

	const target = await guild.client.users.fetch(entry.targetId).catch(() => null);
	const embed = new EmbedBuilder()
		.setTitle(spec.title)
		.setColor(spec.color)
		.setDescription(userLine(target, entry.targetId))
		.addFields({ name: 'By', value: byBot ? 'PariahBot' : (entry.executorId ? `<@${entry.executorId}>` : 'Unknown'), inline: true });
	if (caseEntry) embed.addFields({ name: 'Case', value: caseLine(caseEntry), inline: true });
	embed.addFields({ name: 'Reason', value: truncate(entry.reason || 'No reason given') });
	if (target) embed.setThumbnail(target.displayAvatarURL({ size: 64 }));

	await post(guild, 'kicksBans', embed);
}

// --- Server changes ---------------------------------------------------------------

const SERVER_ACTIONS = {
	[AuditLogEvent.RoleCreate]: { title: '➕ Role created', kind: 'role', color: COLOR_GOOD },
	[AuditLogEvent.RoleUpdate]: { title: '✏️ Role edited', kind: 'role', color: COLOR_INFO },
	[AuditLogEvent.RoleDelete]: { title: '➖ Role deleted', kind: 'role', color: COLOR_BAD },
	[AuditLogEvent.ChannelCreate]: { title: '➕ Channel created', kind: 'channel', color: COLOR_GOOD },
	[AuditLogEvent.ChannelUpdate]: { title: '✏️ Channel edited', kind: 'channel', color: COLOR_INFO },
	[AuditLogEvent.ChannelDelete]: { title: '➖ Channel deleted', kind: 'channel', color: COLOR_BAD },
	[AuditLogEvent.ChannelOverwriteCreate]: { title: '🔐 Channel permissions changed', kind: 'overwrite', color: COLOR_INFO },
	[AuditLogEvent.ChannelOverwriteUpdate]: { title: '🔐 Channel permissions changed', kind: 'overwrite', color: COLOR_INFO },
	[AuditLogEvent.ChannelOverwriteDelete]: { title: '🔐 Channel permissions changed', kind: 'overwrite', color: COLOR_INFO },
	[AuditLogEvent.MemberRoleUpdate]: { title: '🎭 Member roles changed', kind: 'memberRoles', color: COLOR_INFO },
};

const DELETED = new Set([AuditLogEvent.RoleDelete, AuditLogEvent.ChannelDelete]);
const CREATED = new Set([AuditLogEvent.RoleCreate, AuditLogEvent.ChannelCreate]);

// Who or what an overwrite is for: a role, or a single member.
function overwriteSubject(entry, guild) {
	const id = entry.extra?.id;
	if (!id) return 'someone';
	if (id === guild.id) return '@everyone';
	if (guild.roles.cache.has(id)) return `<@&${id}>`;
	return entry.extra?.name ? `@${entry.extra.name}` : `<@${id}>`;
}

function serverChangeSubject(entry, guild, spec) {
	const deleted = DELETED.has(entry.action);
	const name = changeName(entry, deleted ? 'old' : 'new') ?? entry.target?.name;
	if (spec.kind === 'role') return deleted ? `@${name ?? entry.targetId}` : `<@&${entry.targetId}>`;
	if (spec.kind === 'channel') return deleted ? `#${name ?? entry.targetId}` : `<#${entry.targetId}>`;
	if (spec.kind === 'overwrite') return `${overwriteSubject(entry, guild)} in <#${entry.targetId}>`;
	return userLine(entry.target?.tag ? entry.target : null, entry.targetId);
}

async function logServerChange(entry, guild) {
	if (!activeChannelId(guild.id, 'serverChanges')) return;
	// The bot's own changes would drown the log: every temporary voice channel
	// is a create and a delete, and every role menu pick a member role update.
	// Its deliberate changes are in the command audit log instead.
	if (entry.executorId === guild.client.user.id) return;

	const spec = SERVER_ACTIONS[entry.action];
	const changes = spec.kind === 'memberRoles'
		? describeRoleUpdate(entry.changes)
		: (CREATED.has(entry.action) || DELETED.has(entry.action) ? [] : describeChanges(entry.changes));
	// An edit that only touched things this doesn't show isn't worth a post.
	if (!changes.length && !CREATED.has(entry.action) && !DELETED.has(entry.action)) return;

	const embed = new EmbedBuilder()
		.setTitle(spec.title)
		.setColor(spec.color)
		.setDescription(serverChangeSubject(entry, guild, spec))
		.addFields({ name: 'By', value: entry.executorId ? `<@${entry.executorId}>` : 'Unknown', inline: true });
	if (changes.length) embed.addFields({ name: 'Changes', value: truncate(changes.join('\n')) });
	if (entry.reason) embed.addFields({ name: 'Reason', value: truncate(entry.reason) });

	await post(guild, 'serverChanges', embed);
}

async function handleAuditEntry(entry, guild) {
	if (MOD_ACTIONS[entry.action]) return logModAction(entry, guild);
	if (SERVER_ACTIONS[entry.action]) return logServerChange(entry, guild);
	return undefined;
}

// --- Joins and leaves --------------------------------------------------------------

async function handleMemberAdd(member) {
	if (!activeChannelId(member.guild.id, 'joinsLeaves')) return;
	const embed = new EmbedBuilder()
		.setTitle('📥 Member joined')
		.setColor(COLOR_GOOD)
		.setDescription(userLine(member.user, member.id))
		.setThumbnail(member.user.displayAvatarURL({ size: 64 }))
		.addFields(
			{ name: 'Account created', value: relativeTime(member.user.createdTimestamp), inline: true },
			{ name: 'Members now', value: String(member.guild.memberCount), inline: true },
		);
	await post(member.guild, 'joinsLeaves', embed);
}

// A partial member is one the bot hadn't seen since it started, so when they
// joined and which roles they had aren't known.
async function handleMemberRemove(member) {
	if (!activeChannelId(member.guild.id, 'joinsLeaves')) return;
	const roles = member.partial
		? null
		: member.roles.cache.filter((role) => role.id !== member.guild.id).map((role) => `<@&${role.id}>`);
	const embed = new EmbedBuilder()
		.setTitle('📤 Member left')
		.setColor(COLOR_BAD)
		.setDescription(userLine(member.user, member.id))
		.addFields(
			{ name: 'Joined', value: relativeTime(member.joinedTimestamp), inline: true },
			{ name: 'Members now', value: String(member.guild.memberCount), inline: true },
			{ name: 'Roles', value: roles ? truncate(roles.join(', ') || 'None') : 'Unknown' },
		);
	if (member.user) embed.setThumbnail(member.user.displayAvatarURL({ size: 64 }));
	await post(member.guild, 'joinsLeaves', embed);
}

// --- Messages ------------------------------------------------------------------------

const NOT_CACHED = "*Not known: the message is older than the bot's memory of it.*";

function messageText(message) {
	if (message.partial) return NOT_CACHED;
	return message.content ? truncate(message.content) : '*No text*';
}

// Deleted on purpose by /autodelete, so logging them would be noise.
function skipChannel(channelId) {
	return Boolean(autoDeleteStore.getChannel(channelId));
}

async function handleMessageUpdate(oldMessage, newMessage) {
	if (!newMessage.inGuild() || !activeChannelId(newMessage.guildId, 'messages')) return;
	if (!newMessage.author || newMessage.author.bot || newMessage.webhookId || skipChannel(newMessage.channelId)) return;
	// Discord also sends an update when a link preview loads, which isn't an
	// edit. Only a changed edit timestamp means someone edited it.
	if (!newMessage.editedTimestamp || newMessage.editedTimestamp === oldMessage?.editedTimestamp) return;

	const embed = new EmbedBuilder()
		.setTitle('✏️ Message edited')
		.setColor(COLOR_INFO)
		.setDescription(`${userLine(newMessage.author, newMessage.author?.id)} in <#${newMessage.channelId}> · [Jump to message](${newMessage.url})`);
	if (messageContentEnabled()) {
		embed.addFields(
			{ name: 'Before', value: messageText(oldMessage) },
			{ name: 'After', value: newMessage.content ? truncate(newMessage.content) : '*No text*' },
		);
	}
	await post(newMessage.guild, 'messages', embed);
}

async function handleMessageDelete(message) {
	if (!message.guildId || !activeChannelId(message.guildId, 'messages')) return;
	if (!message.partial && (message.author?.bot || message.webhookId)) return;
	if (skipChannel(message.channelId)) return;
	const guild = message.guild ?? message.client.guilds.cache.get(message.guildId);
	if (!guild) return;

	const embed = new EmbedBuilder()
		.setTitle('🗑️ Message deleted')
		.setColor(COLOR_BAD)
		.setDescription(message.partial
			? `In <#${message.channelId}>. It's older than the bot's memory of messages, so who sent it isn't known.`
			: `${userLine(message.author, message.author?.id)} in <#${message.channelId}>, sent ${relativeTime(message.createdTimestamp)}`);
	if (messageContentEnabled() && !message.partial) embed.addFields({ name: 'Text', value: messageText(message) });
	const attachments = message.partial ? [] : [...message.attachments.values()].map((file) => file.name);
	if (attachments.length) embed.addFields({ name: 'Attachments', value: truncate(attachments.join(', ')) });
	await post(guild, 'messages', embed);
}

async function handleMessageBulkDelete(messages, channel) {
	if (!channel.guild || !activeChannelId(channel.guild.id, 'messages') || skipChannel(channel.id)) return;
	const embed = new EmbedBuilder()
		.setTitle('🧹 Messages deleted in bulk')
		.setColor(COLOR_BAD)
		.setDescription(`${messages.size} messages in <#${channel.id}>.`);
	await post(channel.guild, 'messages', embed);
}

// --- The message cache, when message text is on --------------------------------------

// discord.js sweepers option. Each sweep drops messages older than the
// lifetime, and every message from a server that isn't logging messages: with
// message text on, holding members' words for no reason is exactly what the
// opt-in is meant to keep to a minimum.
function messageCacheSweepers() {
	return {
		messages: {
			interval: MESSAGE_SWEEP_INTERVAL_SECONDS,
			filter: () => {
				const cutoff = Date.now() - MESSAGE_CACHE_LIFETIME_MS;
				const logging = new Map();
				return (message) => {
					if (message.createdTimestamp < cutoff || !message.guildId) return true;
					if (!logging.has(message.guildId)) logging.set(message.guildId, Boolean(activeChannelId(message.guildId, 'messages')));
					return !logging.get(message.guildId);
				};
			},
		},
	};
}

module.exports = {
	SECTIONS,
	SECTION_KEYS,
	MESSAGE_CACHE_LIFETIME_MS,
	isSection,
	activeChannelId,
	describeSections,
	sectionProblems,
	permissionDiffLine,
	describeChanges,
	describeRoleUpdate,
	truncate,
	handleAuditEntry,
	handleMemberAdd,
	handleMemberRemove,
	handleMessageUpdate,
	handleMessageDelete,
	handleMessageBulkDelete,
	messageCacheSweepers,
};
