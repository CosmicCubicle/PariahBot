const { EmbedBuilder } = require('discord.js');
const guildSettings = require('../state/guildSettings');
const { isAdmin } = require('./permissions');
const { sendAlert } = require('./alertDelivery');

const EMBED_COLOR = 0xed4245;

// Matches the reference bot's default: a "kick" is really a softban (ban then
// immediately unban) purely so Discord purges the spammer's recent messages
// on the way out — a plain kick leaves the spam behind.
const DELETE_MESSAGE_SECONDS = 60 * 60;

function buildWarningMessage() {
	const embed = new EmbedBuilder()
		.setTitle('⚠️ Do not post in this channel')
		.setColor(EMBED_COLOR)
		.setDescription([
			'This channel is a spam trap. Anyone who posts here is automatically removed from the server.',
			'',
			'There is nothing you need to do here — just leave it alone.',
		].join('\n'));

	return { embeds: [embed] };
}

async function setupHoneypotChannel(channel) {
	const botId = channel.client.user.id;
	const reason = 'PariahBot honeypot channel';

	// The trap only works if people can see it; the bot needs to post the
	// warning. Everything else about the channel is left to the admin, since
	// the reference bot's advice is to make it look like an ordinary channel.
	await channel.permissionOverwrites.edit(botId, { ViewChannel: true, SendMessages: true }, { reason });

	return channel.send(buildWarningMessage());
}

async function notifyTarget(member, action, guildName) {
	const verb = action === 'ban' ? 'banned from' : 'removed from';
	await member.send(
		`You were ${verb} **${guildName}** because you posted in a channel that exists only to catch spam bots. `
		+ 'If you believe this was a mistake, contact a server moderator.',
	).catch(() => null);
}

async function removeTarget(guild, userId, action, reason) {
	if (action === 'ban') {
		await guild.bans.create(userId, { deleteMessageSeconds: DELETE_MESSAGE_SECONDS, reason });
		return;
	}

	// Softban: the unban is what makes this a kick rather than a ban, while
	// still getting Discord to sweep their recent messages.
	await guild.bans.create(userId, { deleteMessageSeconds: DELETE_MESSAGE_SECONDS, reason });
	await guild.bans.remove(userId, `${reason} (softban — unbanning so they can rejoin)`);
}

async function reportAction(guild, user, action, channelId, failure) {
	const embed = new EmbedBuilder()
		.setTitle(failure ? '🍯 Honeypot triggered — action failed' : '🍯 Honeypot triggered')
		.setColor(EMBED_COLOR)
		.setDescription(
			failure
				? `${user} (\`${user.id}\`) posted in <#${channelId}>, but I couldn't remove them: ${failure}`
				: `${user} (\`${user.id}\`) posted in <#${channelId}> and was ${action === 'ban' ? 'banned' : 'removed (softban)'}.`,
		)
		.setTimestamp();

	await sendAlert(guild, { embeds: [embed] }).catch((error) => {
		console.error('Honeypot: failed to send alert:', error.message);
	});
}

// Returns false when this message isn't in a honeypot channel, so
// events/messageCreate.js can carry on with its other handlers.
async function handleHoneypotMessage(message) {
	if (!message.guild || message.author.bot) return false;

	const { honeypotChannelId, honeypotAction } = guildSettings.getGuildSettings(message.guildId);
	if (!honeypotChannelId || message.channelId !== honeypotChannelId) return false;

	// The one guard that must never be removed: a moderator wandering into the
	// trap must not be banned by their own bot.
	if (message.member && isAdmin(message.member, message.guildId)) return true;

	const action = honeypotAction === 'ban' ? 'ban' : 'kick';
	const reason = `Posted in the honeypot channel (#${message.channel.name})`;

	// DM first — once they're banned the bot can no longer open a DM channel
	// with them, so the order here matters.
	if (message.member) {
		await notifyTarget(message.member, action, message.guild.name);
	}

	try {
		await removeTarget(message.guild, message.author.id, action, reason);
		await reportAction(message.guild, message.author, action, honeypotChannelId, null);
	} catch (error) {
		console.error(`Honeypot: failed to ${action} ${message.author.id}:`, error.message);
		await reportAction(message.guild, message.author, action, honeypotChannelId, error.message);
	}

	return true;
}

module.exports = { setupHoneypotChannel, handleHoneypotMessage };
