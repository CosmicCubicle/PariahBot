const voiceStore = require('../state/voiceChannels');

// Shared by events/voiceStateUpdate.js's live leave-handling and the reconciliation
// sweep below, so there's exactly one "what does cleaning up a temp channel mean"
// implementation instead of two that could drift apart.
async function cleanupIfEmpty(channel) {
	if (!channel || !voiceStore.isTempChannel(channel.id)) return;
	if (channel.members.size > 0) return;

	// Unregister first: the database write is local and effectively can't fail,
	// while the Discord API call below can (already deleted, rate limit) — so the
	// channel is reliably gone from our tracking either way. Same ordering as
	// /voice remove, for the same reason.
	voiceStore.removeTempChannel(channel.id);
	try {
		await channel.delete('Temporary voice channel emptied.');
	} catch (error) {
		// 10003 = Unknown Channel — already gone (e.g. deleted manually), nothing to do.
		if (error.code !== 10003) console.error(`Failed to delete empty temp channel ${channel.id}:`, error.message);
	}
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
