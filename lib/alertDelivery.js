const guildSettings = require('../state/guildSettings');

// General-purpose, not voice-specific: takes a guild and a message payload, and
// delivers it to whatever this guild has configured — any future feature that
// wants to notify a server's admins can call this directly. Also takes a guild
// (not an interaction) so it works from non-interactive contexts too, like the
// startup reconciliation sweep delivering real hub-desync notices with no slash
// command interaction to hang the call off of.
async function sendAlert(guild, payload) {
	const settings = guildSettings.getGuildSettings(guild.id);
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

	for (const userId of guildSettings.listAlertRecipients(guild.id)) {
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
