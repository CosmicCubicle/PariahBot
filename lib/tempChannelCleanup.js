const voiceStore = require('../state/voiceChannels');

// Shared by events/voiceStateUpdate.js's live leave-handling and the reconciliation
// sweep below, so there's exactly one "what does cleaning up a temp channel mean"
// implementation instead of two that could drift apart.
async function cleanupIfEmpty(channel) {
	if (!channel || !voiceStore.isTempChannel(channel.id)) return;
	if (channel.members.size > 0) return;

	// Delete first, unregister only once the channel's fate is actually known.
	// The reverse order (used until this was caught) unregistered unconditionally
	// before attempting the delete, on the assumption the only failure mode was
	// "already deleted" — but a real failure (e.g. the channel's own permission
	// overwrites locking the bot out, see /vc lock) orphans the channel forever
	// once the tracking row is gone: reconciliation and /voice audit both work
	// off that row, so a channel that still exists on Discord but isn't tracked
	// becomes invisible to every recovery path this bot has.
	try {
		await channel.delete('Temporary voice channel emptied.');
	} catch (error) {
		// 10003 = Unknown Channel — already gone (e.g. deleted manually) — fall
		// through and drop the row below. Any other error means the channel is
		// still there and still broken, so the row stays too, and the next
		// reconciliation sweep will simply try again instead of losing track of it.
		if (error.code !== 10003) {
			console.error(`Failed to delete empty temp channel ${channel.id}:`, error.message);
			return;
		}
	}

	voiceStore.removeTempChannel(channel.id);
}

// Catches up on drift the live voiceStateUpdate handler couldn't have seen — a temp
// channel that emptied out (or was deleted entirely) while the bot was offline, or
// since the last opportunistic check. Called both from events/ready.js (every guild,
// at startup) and opportunistically from a guild-scoped hub join (cache-only, no
// extra API calls, no timer — see events/voiceStateUpdate.js).
async function reconcileTempChannels(guild) {
	for (const record of voiceStore.listTempChannelsForGuild(guild.id)) {
		const channel = guild.channels.cache.get(record.channelId);
		if (!channel) {
			// Gone from Discord entirely (e.g. deleted manually while offline) — no
			// channel left to clean up, just drop the stale record.
			voiceStore.removeTempChannel(record.channelId);
			continue;
		}
		await cleanupIfEmpty(channel);
	}
}

module.exports = { cleanupIfEmpty, reconcileTempChannels };
