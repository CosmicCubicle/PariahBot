const { ChannelType, PermissionFlagsBits, RESTJSONErrorCodes } = require('discord.js');
const counterStore = require('../state/memberCounters');
const features = require('./features');
const { presenceEnabled } = require('./intents');

// Member count channels (#90): a voice channel whose NAME is the count, e.g.
// "Members: 1,204". Modelled on the Member Count bot
// (https://membercount.net) — see References.md.
//
// **Voice** channels, not text, for the reason that bot settled on: a member
// sees the name in the channel list but cannot open it, and Discord shows it
// with a lock. A text counter would invite people to click into an empty
// channel. The lock comes from denying Connect to @everyone, which is why
// setup needs Manage Roles as well as Manage Channels.
//
// Renamed on a **timer, never on an event.** Discord allows roughly two
// renames per ten minutes per channel, and a busy server would blow through
// that in seconds if each join renamed a channel. The reference bot was forced
// to the same conclusion: "The counters in your server update every 20
// minutes. This is due to ratelimits -- previously it was instant." There is
// deliberately no manual refresh command for the same reason.
const REFRESH_INTERVAL_MS = 20 * 60 * 1000;

// Discord caps a channel name at 100 characters.
const MAX_NAME_LENGTH = 100;

// Per guild. The reference bot caps its role counters at 30; this covers every
// type together, because each one is a channel in someone's channel list and a
// rename on every sweep.
const MAX_COUNTERS_PER_GUILD = 20;

// `needsPresence` marks the two that can only be answered by the privileged
// GuildPresences intent — unavailable unless the host set MEMBER_COUNT_PRESENCE
// (see lib/intents.js). `needsMembers` is informational: GuildMembers is
// always requested, so those work, but it records why.
const COUNTER_TYPES = {
	members: {
		label: 'Members (people and bots)',
		defaultTemplate: 'Members: {count}',
		count: (guild) => guild.memberCount,
	},
	users: {
		label: 'Humans',
		defaultTemplate: 'Humans: {count}',
		needsMembers: true,
		needsMemberCache: true,
		count: (guild) => guild.members.cache.filter((member) => !member.user.bot).size,
	},
	bots: {
		label: 'Bots',
		defaultTemplate: 'Bots: {count}',
		needsMembers: true,
		needsMemberCache: true,
		count: (guild) => guild.members.cache.filter((member) => member.user.bot).size,
	},
	roles: {
		label: 'Roles',
		defaultTemplate: 'Roles: {count}',
		// Minus @everyone, which is a role in the API but not one anyone means.
		count: (guild) => Math.max(guild.roles.cache.size - 1, 0),
	},
	channels: {
		label: 'Channels',
		defaultTemplate: 'Channels: {count}',
		// Categories excluded: they're containers, not channels people use.
		count: (guild) => guild.channels.cache.filter((channel) => channel.type !== ChannelType.GuildCategory).size,
	},
	role: {
		label: 'Members in a role',
		defaultTemplate: '{count}',
		needsMembers: true,
		needsMemberCache: true,
		needsRole: true,
		count: (guild, roleId) => guild.roles.cache.get(roleId)?.members.size ?? null,
	},
	online: {
		label: 'Online members',
		defaultTemplate: 'Online: {count}',
		needsPresence: true,
		needsMemberCache: true,
		count: (guild) => guild.members.cache.filter((member) => member.presence && member.presence.status !== 'offline').size,
	},
	offline: {
		label: 'Offline members',
		defaultTemplate: 'Offline: {count}',
		needsPresence: true,
		needsMemberCache: true,
		count: (guild) => guild.members.cache.filter((member) => !member.presence || member.presence.status === 'offline').size,
	},
};

const COUNTER_TYPE_KEYS = Object.keys(COUNTER_TYPES);

function isCounterType(type) {
	return Object.hasOwn(COUNTER_TYPES, type);
}

// Thrown rather than returned so the command layer reports it the way it
// reports every other user error (CodeStandards.md § 4).
function requireAvailableType(type) {
	if (!isCounterType(type)) throw new Error(`There is no counter called \`${type}\`.`);

	const spec = COUNTER_TYPES[type];
	if (spec.needsPresence && !presenceEnabled()) {
		throw new Error(
			`The **${spec.label}** counter needs Discord's Presence intent, which this host hasn't turned on. `
			+ 'Set `MEMBER_COUNT_PRESENCE=true` in `hom.env`, switch on **Presence Intent** in the Developer Portal '
			+ '(your application → Bot → Privileged Gateway Intents), and restart the bot.',
		);
	}
	return spec;
}

// {count} is the only placeholder, and the formatted number is the whole point
// of the template, so a template without it would produce a channel name that
// never changes. The command layer refuses that before getting here; this also
// tolerates it rather than throwing mid-sweep.
function renderName(template, count) {
	const text = template.includes('{count}')
		? template.replaceAll('{count}', count.toLocaleString('en-US'))
		: `${template} ${count.toLocaleString('en-US')}`;
	return text.slice(0, MAX_NAME_LENGTH);
}

// Null when the count can't be worked out right now — a role that was deleted,
// or presence data the bot isn't receiving. The caller skips rather than
// writing a misleading zero into the channel name.
function countFor(guild, counter) {
	const spec = COUNTER_TYPES[counter.type];
	if (!spec) return null;
	if (spec.needsPresence && !presenceEnabled()) return null;

	const value = spec.count(guild, counter.roleId);
	return Number.isFinite(value) ? value : null;
}

// Whether anything in this list reads guild.members.cache.
function needsMemberCache(counters) {
	return counters.some((counter) => COUNTER_TYPES[counter.type]?.needsMemberCache);
}

// Fills guild.members.cache, which is the whole reason #105 existed: the cache
// holds only members the bot has happened to see since it started, so counting
// humans straight off it reported a handful. The GuildMembers intent makes this
// fetch possible; it does not make it happen.
//
// Called once per guild per sweep, and only when a counter there actually reads
// the cache — a server with just members/roles/channels counters costs nothing.
// withPresences is only legal with the Presence intent, so it follows the flag.
//
// Returns false when the fetch failed, so the caller skips rather than writing
// a number it knows is short.
async function ensureMemberCache(guild) {
	try {
		await guild.members.fetch({ withPresences: presenceEnabled() });
		return true;
	} catch (error) {
		console.error(`MemberCount: couldn't fetch members for guild ${guild.id}:`, error.message);
		return false;
	}
}

// Denies Connect to @everyone so the channel reads as a locked label rather
// than somewhere to join, and grants the bot what it needs to keep renaming
// it. Discord only lets the bot set a permission it holds itself, which is why
// the invite asks for Connect (the same reason /vc lock does).
async function lockCounterChannel(channel) {
	const reason = 'PariahBot member count channel';
	await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { Connect: false }, { reason });
	await channel.permissionOverwrites.edit(channel.client.user.id, {
		ViewChannel: true,
		Connect: true,
		ManageChannels: true,
	}, { reason });
}

// Creates the channel for a counter. The caller has already established that
// the admin asked for it and said where it goes (WorkingAgreements.md § 7).
async function createCounterChannel(guild, { name, category, actor }) {
	return guild.channels.create({
		name,
		type: ChannelType.GuildVoice,
		parent: category?.id ?? undefined,
		reason: `PariahBot member count channel, created via /membercount by ${actor}`,
	});
}

// One counter. Returns what happened, so a sweep can be summarised and a
// single failure never stops the rest.
async function refreshCounter(client, counter) {
	const guild = client.guilds.cache.get(counter.guildId);
	if (!guild) return { skipped: 'guild-unavailable' };

	// A guild with the feature switched off keeps its counters and its rows;
	// they just stop being rewritten (#69).
	if (!features.isEnabled(counter.guildId, 'memberCount')) return { skipped: 'feature-off' };

	const channel = guild.channels.cache.get(counter.channelId);
	if (!channel) {
		// Deleted in Discord. The row is the only thing left pointing at it, so
		// drop it rather than retrying every 20 minutes forever.
		counterStore.forgetChannel(counter.channelId);
		return { skipped: 'channel-deleted', forgotten: true };
	}

	const count = countFor(guild, counter);
	if (count === null) return { skipped: 'no-count' };

	const name = renderName(counter.nameTemplate, count);
	if (channel.name === name) return { skipped: 'unchanged' };

	try {
		await channel.setName(name, 'PariahBot member count refresh');
		return { renamed: true, name };
	} catch (error) {
		if (error.code === RESTJSONErrorCodes.MissingPermissions) {
			return { skipped: 'missing-permissions' };
		}
		throw error;
	}
}

// Every counter in every guild, one sweep. Grouped by guild so the member
// fetch happens once per guild rather than once per counter (#105) — five
// counters in one server used to mean five chances to get this wrong.
//
// Best-effort per counter (CodeStandards.md § 5): one failing channel must not
// stop the others.
async function refreshAll(client) {
	const byGuild = new Map();
	for (const counter of counterStore.listAll()) {
		if (!byGuild.has(counter.guildId)) byGuild.set(counter.guildId, []);
		byGuild.get(counter.guildId).push(counter);
	}

	for (const [guildId, counters] of byGuild) {
		const guild = client.guilds.cache.get(guildId);
		if (!guild) continue;

		// Skipped entirely when the feature is off, so a switched-off guild
		// doesn't fetch its whole member list every 20 minutes.
		if (!features.isEnabled(guildId, 'memberCount')) continue;

		if (needsMemberCache(counters) && !await ensureMemberCache(guild)) continue;

		for (const counter of counters) {
			await refreshCounter(client, counter).catch((error) => {
				console.error(`MemberCount: refresh failed for channel ${counter.channelId}:`, error.message);
			});
		}
	}
}

let timer = null;

// Called from events/ready.js. Sweeps once at startup so counters are right
// after a restart without waiting 20 minutes, then on the interval.
function startRefreshTimer(client) {
	if (timer) return timer;

	refreshAll(client).catch((error) => {
		console.error('MemberCount: initial refresh failed:', error.message);
	});

	timer = setInterval(() => {
		refreshAll(client).catch((error) => {
			console.error('MemberCount: refresh sweep failed:', error.message);
		});
	}, REFRESH_INTERVAL_MS);
	timer.unref?.();
	return timer;
}

function requireManageChannels(guild) {
	if (!guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) {
		throw new Error('I need the **Manage Channels** permission to make and rename counter channels. Add it to my PariahBot role in Server Settings → Roles.');
	}
}

module.exports = {
	REFRESH_INTERVAL_MS,
	MAX_NAME_LENGTH,
	MAX_COUNTERS_PER_GUILD,
	COUNTER_TYPES,
	COUNTER_TYPE_KEYS,
	isCounterType,
	requireAvailableType,
	requireManageChannels,
	renderName,
	countFor,
	needsMemberCache,
	ensureMemberCache,
	lockCounterChannel,
	createCounterChannel,
	refreshCounter,
	refreshAll,
	startRefreshTimer,
};
