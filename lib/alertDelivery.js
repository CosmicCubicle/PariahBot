const voiceStore = require('../state/voiceChannels');

// Takes a guild (not an interaction) so this also works from a non-interactive
// context later — Stage 1 checkpoint 5c's startup reconciliation sweep will call
// this same function to deliver real hub-desync notices, with no slash command
// interaction available to hang the call off of.
async function sendAlert(guild, payload) {
	const settings = voiceStore.getGuildSettings(guild.id);
	const effectiveChannelId = settings.alertChannelId ?? settings.defaultChannelId;

	const result = { channel: null, dms: [] };

	if (effectiveChannelId) {
		try {
			const channel = guild.channels.cache.get(effectiveChannelId) ?? await guild.channels.fetch(effectiveChannelId);
			await channel.send(payload);
			result.channel = { id: effectiveChannelId, ok: true };
		} catch (error) {
			result.channel = { id: effectiveChannelId, ok: false, error: error.message };
		}
	}

	for (const userId of voiceStore.listAlertRecipients(guild.id)) {
		try {
			const user = await guild.client.users.fetch(userId);
			await user.send(payload);
			result.dms.push({ id: userId, ok: true });
		} catch (error) {
			result.dms.push({ id: userId, ok: false, error: error.message });
		}
	}

	return result;
}

module.exports = { sendAlert };
