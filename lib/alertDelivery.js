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
	const recipients = guildSettings.listAlertRecipients(guild.id);

	// Since #92 the bot no longer creates an alert channel on its own, so a
	// server can genuinely have nowhere for alerts to go. That used to be
	// impossible, which means callers were written to assume delivery happened.
	// Logged once per alert rather than swallowed: honeypot removals, moderation
	// actions, blocked words and dead-hub notices all come through here, and
	// losing them silently is worse than a noisy log.
	if (!effectiveChannelId && recipients.length === 0) {
		console.warn(`Alerts: guild ${guild.id} (${guild.name}) has no alert destination — set one with /alerts channel. Dropping this alert.`);
		result.undelivered = true;
		return result;
	}

	if (effectiveChannelId) {
		try {
			const channel = guild.channels.cache.get(effectiveChannelId) ?? await guild.channels.fetch(effectiveChannelId);
			await channel.send(payload);
			result.channel = { id: effectiveChannelId, ok: true };
		} catch (error) {
			result.channel = { id: effectiveChannelId, ok: false, error: error.message };
		}
	}

	for (const userId of recipients) {
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
