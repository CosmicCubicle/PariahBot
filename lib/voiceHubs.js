const { ChannelType } = require('discord.js');
const voiceStore = require('../state/voiceChannels');

// Managing join-to-create hubs: adding, creating, removing, editing, and
// fixing ones whose channel was deleted. Shared by /voice, the deleted-hub
// alert buttons (lib/hubDesync.js) and the admin dashboard, so the rules live
// in one place (CodeStandards.md § 3).

const DEFAULT_HUB_NAME = '➕ Join to Create';
const MAX_LIMIT = 99;
const MAX_TEMPLATE_LENGTH = 100;

// Category names aren't unique in Discord, so the first match wins rather than
// erroring — categories are a placement hint, not an identity anything else
// depends on.
async function resolveOrCreateCategory(guild, name) {
	if (!name) return null;
	const existing = guild.channels.cache.find(
		(channel) => channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === name.toLowerCase(),
	);
	return existing ?? guild.channels.create({ name, type: ChannelType.GuildCategory });
}

function register(guild, channel, category) {
	try {
		voiceStore.addHub(guild.id, channel.id, category?.id ?? null);
	} catch (error) {
		if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') throw new Error(`#${channel.name} is already a voice hub.`);
		throw error;
	}
}

// An existing voice channel becomes a hub.
function addExistingHub(guild, channel, category = null) {
	if (channel.guild?.id !== guild.id || channel.type !== ChannelType.GuildVoice) {
		throw new Error('A hub has to be a voice channel in this server.');
	}
	register(guild, channel, category);
	return channel;
}

// A new voice channel, made a hub.
async function createHub(guild, name, category = null) {
	const channel = await guild.channels.create({
		name: name || DEFAULT_HUB_NAME,
		type: ChannelType.GuildVoice,
		parent: category?.id ?? undefined,
	});
	register(guild, channel, category);
	return channel;
}

// Unregisters first: the database write can't really fail, while deleting the
// channel can (a missing permission, already deleted). The hub is reliably
// gone from tracking either way; the result says what happened to the channel.
// Returns null when hubId wasn't one of this guild's hubs.
async function removeHub(guild, hubId) {
	if (!voiceStore.removeHub(hubId, guild.id)) return null;
	const channel = guild.channels.cache.get(hubId);
	if (!channel) return { name: null, channelDeleted: false, error: null };
	try {
		await channel.delete('Voice hub removed');
		return { name: channel.name, channelDeleted: true, error: null };
	} catch (error) {
		return { name: channel.name, channelDeleted: false, error: error.message };
	}
}

// For a hub whose channel was deleted: forget it.
function pruneHub(guild, hubId) {
	return voiceStore.removeHub(hubId, guild.id);
}

// For a hub whose channel was deleted: make a new channel and move the hub's
// settings onto it. Its old name was never stored (Discord was its source of
// truth), so it gets the default name. Returns null when there's nothing to
// restore — already pruned or restored, perhaps by someone else at once.
async function restoreHub(guild, hubId) {
	const hub = voiceStore.getHub(hubId);
	if (!hub || hub.guildId !== guild.id) return null;
	if (guild.channels.cache.has(hubId)) throw new Error("That hub's channel still exists — there's nothing to restore.");

	const category = hub.categoryId ? guild.channels.cache.get(hub.categoryId) : null;
	const channel = await guild.channels.create({ name: DEFAULT_HUB_NAME, type: ChannelType.GuildVoice, parent: category?.id ?? undefined });
	voiceStore.migrateHubChannel(hubId, channel.id);
	return channel;
}

function requireLimit(value, label) {
	if (!Number.isInteger(value) || value < 0 || value > MAX_LIMIT) throw new Error(`The ${label} must be a whole number from 0 to ${MAX_LIMIT}.`);
	return value;
}

// Applies changes to a hub's settings, keeping anything not given. category
// is a category channel, or null to use the hub's own category. Throws a
// message the admin can act on; returns the hub as saved.
function editHub(guild, hubId, changes) {
	const hub = voiceStore.getHub(hubId);
	if (!hub || hub.guildId !== guild.id) throw new Error("That isn't one of this server's voice hubs.");

	const next = { ...hub };
	if (changes.nameTemplate !== undefined) {
		const template = String(changes.nameTemplate).trim();
		if (!template) throw new Error("The name template can't be empty. Use {owner} for the owner's name.");
		if (template.length > MAX_TEMPLATE_LENGTH) throw new Error(`The name template can be at most ${MAX_TEMPLATE_LENGTH} characters.`);
		next.nameTemplate = template;
	}
	if (changes.defaultLimit !== undefined) next.defaultLimit = requireLimit(changes.defaultLimit, 'default limit');
	if (changes.minLimit !== undefined) next.minLimit = requireLimit(changes.minLimit, 'minimum limit');
	if (changes.maxLimit !== undefined) next.maxLimit = requireLimit(changes.maxLimit, 'maximum limit');
	if (changes.category !== undefined) {
		if (changes.category && (changes.category.guild?.id !== guild.id || changes.category.type !== ChannelType.GuildCategory)) {
			throw new Error("That isn't a category in this server.");
		}
		next.categoryId = changes.category?.id ?? null;
	}

	if (next.minLimit > next.maxLimit) {
		throw new Error(`The minimum limit (${next.minLimit}) can't be above the maximum (${next.maxLimit}).`);
	}
	// Same rule /vc limit applies, so a new channel never starts at a limit its
	// owner couldn't set. 0 means "no limit", so it's only in range when the
	// minimum is 0 too.
	if (next.defaultLimit < next.minLimit || next.defaultLimit > next.maxLimit) {
		throw new Error(`The default limit (${next.defaultLimit}) has to be between the minimum (${next.minLimit}) and maximum (${next.maxLimit}). 0 means no limit, which needs a minimum of 0.`);
	}

	voiceStore.updateHubSettings(hubId, guild.id, next);
	return next;
}

function describeLimits(hub) {
	const limit = (value) => (value === 0 ? 'none' : String(value));
	return `default ${limit(hub.defaultLimit)}, owners can choose ${hub.minLimit}–${hub.maxLimit}`;
}

module.exports = {
	DEFAULT_HUB_NAME,
	MAX_LIMIT,
	MAX_TEMPLATE_LENGTH,
	resolveOrCreateCategory,
	addExistingHub,
	createHub,
	removeHub,
	pruneHub,
	restoreHub,
	editHub,
	describeLimits,
};
