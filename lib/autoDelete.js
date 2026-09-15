const { RESTJSONErrorCodes } = require('discord.js');

const SWEEP_INTERVAL_MS = 60 * 1000;
const BACKLOG_FETCH_LIMIT = 100;

// channelId -> { channel, config: {maxMessages, liveSeconds}, live: [{id, createdTimestamp}, ...] }
// `live` is always kept oldest-first. This is intentionally not persisted —
// see state/autoDeleteChannels.js for why: it's rebuilt from Discord's own
// channel history rather than kept as a second, driftable copy of it.
const tracked = new Map();

// Accepts one or more <number><unit> chunks (h/m/s), e.g. "24h", "30m",
// "1h30m", summed to seconds. No dependency — the repo had none for this.
function parseDuration(raw) {
	const compact = raw.replace(/\s+/g, '');
	if (!/^(\d+[hms])+$/i.test(compact)) {
		throw new Error(`"${raw}" isn't a valid duration — use a combination like 24h, 30m, 1h30m, or 90s.`);
	}

	let totalSeconds = 0;
	const partRe = /(\d+)([hms])/gi;
	let match = partRe.exec(compact);
	while (match !== null) {
		const value = Number(match[1]);
		const unit = match[2].toLowerCase();
		totalSeconds += unit === 'h' ? value * 3600 : unit === 'm' ? value * 60 : value;
		match = partRe.exec(compact);
	}

	if (totalSeconds <= 0) {
		throw new Error('Duration must be greater than zero.');
	}
	return totalSeconds;
}

function isTracked(channelId) {
	return tracked.has(channelId);
}

function updateConfig(channelId, config) {
	const entry = tracked.get(channelId);
	if (entry) entry.config = config;
}

// Seeds the live list from recent channel history, then does one reap pass —
// this is what catches messages that already expired (e.g. while the bot was
// offline) as soon as a channel starts being tracked.
async function startTracking(channel, config) {
	const messages = await channel.messages.fetch({ limit: BACKLOG_FETCH_LIMIT }).catch(() => null);
	const live = messages
		? [...messages.values()]
			.map((message) => ({ id: message.id, createdTimestamp: message.createdTimestamp }))
			.sort((a, b) => a.createdTimestamp - b.createdTimestamp)
		: [];

	tracked.set(channel.id, { channel, config, live });
	await reapChannel(channel.id);
}

function stopTracking(channelId) {
	tracked.delete(channelId);
}

function trackMessage(message) {
	const entry = tracked.get(message.channelId);
	if (!entry) return;
	entry.live.push({ id: message.id, createdTimestamp: message.createdTimestamp });
}

// Pins are checked live (one fetchPinned() call per reap, not per message)
// rather than cached at track time, since a message can be pinned well after
// it was first seen — caching pinned status at creation would go stale.
async function reapChannel(channelId) {
	const entry = tracked.get(channelId);
	if (!entry || entry.live.length === 0) return;

	const { channel, config, live } = entry;

	let pinnedIds = new Set();
	try {
		const pins = await channel.messages.fetchPinned();
		pinnedIds = new Set(pins.keys());
	} catch (error) {
		console.error(`AutoDelete: failed to fetch pins for channel ${channelId}:`, error.message);
	}

	const now = Date.now();
	const toDeleteIds = new Set();
	// Non-pinned, not yet time-expired — the only messages eligible for the
	// count-based trim below. Pinned messages must never enter this array:
	// mixing them into a single "survivors" list before trimming would let the
	// count limit delete a pin just because it happened to be the oldest.
	const candidates = [];

	for (const item of live) {
		if (pinnedIds.has(item.id)) continue;
		const expired = config.liveSeconds > 0 && now - item.createdTimestamp >= config.liveSeconds * 1000;
		if (expired) {
			toDeleteIds.add(item.id);
		} else {
			candidates.push(item);
		}
	}

	// candidates is still oldest-first, so trimming from the front removes the
	// oldest non-pinned messages first.
	if (config.maxMessages > 0 && candidates.length > config.maxMessages) {
		for (const item of candidates.splice(0, candidates.length - config.maxMessages)) {
			toDeleteIds.add(item.id);
		}
	}

	entry.live = live.filter((item) => !toDeleteIds.has(item.id));

	for (const id of toDeleteIds) {
		try {
			await channel.messages.delete(id);
		} catch (error) {
			// Already gone (manually deleted, or a previous reap raced it) — not
			// worth logging every time this happens.
			if (error.code !== RESTJSONErrorCodes.UnknownMessage) {
				console.error(`AutoDelete: failed to delete message ${id} in channel ${channelId}:`, error.message);
			}
		}
	}
}

function reapAllChannels() {
	for (const channelId of tracked.keys()) {
		reapChannel(channelId).catch((error) => {
			console.error(`AutoDelete: reap failed for channel ${channelId}:`, error.message);
		});
	}
}

let sweepTimer = null;

// Catches time-based expiry even when nobody's posting — messageCreate alone
// would never notice a channel that's gone quiet.
function startSweepTimer() {
	if (sweepTimer) return;
	sweepTimer = setInterval(reapAllChannels, SWEEP_INTERVAL_MS);
}

// Called once from events/ready.js: brings every guild's configured channels
// (from state/autoDeleteChannels.js) under tracking on startup.
async function seedAll(client, configs) {
	for (const config of configs) {
		const channel = await client.channels.fetch(config.channelId).catch(() => null);
		if (!channel) continue;
		await startTracking(channel, { maxMessages: config.maxMessages, liveSeconds: config.liveSeconds }).catch((error) => {
			console.error(`AutoDelete: failed to start tracking channel ${config.channelId}:`, error.message);
		});
	}
}

module.exports = {
	parseDuration,
	isTracked,
	updateConfig,
	startTracking,
	stopTracking,
	trackMessage,
	reapChannel,
	startSweepTimer,
	seedAll,
};
