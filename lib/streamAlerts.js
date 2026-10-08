const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const streamerStore = require('../state/streamers');
const guildSettings = require('../state/guildSettings');
const twitch = require('./twitch');

// Twitch purple, so a go-live alert reads as Twitch at a glance.
const EMBED_COLOR = 0x9146ff;

// Polling rather than Twitch EventSub webhooks: EventSub needs a public HTTPS
// endpoint, which a self-hosted bot behind a home connection usually doesn't
// have. A minute's delay on a go-live alert is an acceptable trade.
const POLL_INTERVAL_MS = 60 * 1000;

const THUMBNAIL_WIDTH = 1280;
const THUMBNAIL_HEIGHT = 720;

function buildAlertMessage(stream, member, pingRoleId) {
	const url = `https://www.twitch.tv/${stream.userLogin}`;

	const embed = new EmbedBuilder()
		.setColor(EMBED_COLOR)
		.setAuthor({ name: `${stream.userName} is live on Twitch`, url })
		.setTitle(stream.title || `${stream.userName} is live`)
		.setURL(url)
		.setDescription(`${member ?? `**${stream.userName}**`} is streaming${stream.gameName ? ` **${stream.gameName}**` : ''}.`)
		.setTimestamp(new Date(stream.startedAt));

	// Twitch serves the same thumbnail URL for the whole broadcast; the
	// timestamp stops Discord showing a cached frame from an earlier stream.
	// It can be empty for a stream that only just started.
	if (stream.thumbnailUrl) {
		const thumbnail = stream.thumbnailUrl
			.replace('{width}', THUMBNAIL_WIDTH)
			.replace('{height}', THUMBNAIL_HEIGHT);
		embed.setImage(`${thumbnail}?t=${Date.now()}`);
	}

	const row = new ActionRowBuilder().addComponents(
		new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Watch on Twitch').setURL(url),
	);

	return {
		content: pingRoleId ? `<@&${pingRoleId}>` : undefined,
		embeds: [embed],
		components: [row],
		// Only the configured role is ever pinged. The streamer is named in the
		// embed, where a mention doesn't notify anyone.
		allowedMentions: { parse: [], roles: pingRoleId ? [pingRoleId] : [] },
	};
}

async function announce(client, link, stream) {
	const guild = client.guilds.cache.get(link.guildId);
	if (!guild) return;

	const { streamAlertChannelId, streamAlertRoleId, streamerRoleId } = guildSettings.getGuildSettings(link.guildId);
	if (!streamAlertChannelId) return;

	// Fetching one member by ID needs no privileged intent. An admin-added
	// channel may have no member at all, or one who has since left — the
	// alert then just names the Twitch account instead.
	const member = link.userId
		? await guild.members.fetch(link.userId).catch(() => null)
		: null;

	// Self-linked streamers are checked live on every alert, not just at link
	// time: losing the streamer role stops alerts straight away, the same way
	// lib/permissions.js checks mod roles live. Admin-added ones skip this —
	// an admin putting them on the list is the permission.
	if (!link.manual && !(streamerRoleId && member?.roles.cache.has(streamerRoleId))) return;

	const channel = guild.channels.cache.get(streamAlertChannelId)
		?? await guild.channels.fetch(streamAlertChannelId).catch(() => null);

	// Recorded before sending, so a failed send isn't retried every minute for
	// the rest of the broadcast — a deleted channel or missing permission
	// would otherwise flood the log (and Discord) until the stream ended.
	streamerStore.setLastStreamId(link.guildId, link.twitchUserId, stream.id);

	if (!channel?.isTextBased()) {
		console.error(`StreamAlerts: alert channel ${streamAlertChannelId} in guild ${link.guildId} is missing — run /streamers channel again.`);
		return;
	}
	await channel.send(buildAlertMessage(stream, member, streamAlertRoleId));
}

async function pollOnce(client) {
	const links = streamerStore.listAllLinks();
	if (links.length === 0) return;

	// The same Twitch account can be linked in several guilds; ask Twitch once.
	const twitchIds = [...new Set(links.map((link) => link.twitchUserId))];
	const live = await twitch.getLiveStreams(twitchIds);

	for (const link of links) {
		const stream = live.get(link.twitchUserId);
		if (!stream || stream.id === link.lastStreamId) continue;

		if (stream.userLogin !== link.twitchLogin) {
			streamerStore.setTwitchLogin(link.guildId, link.twitchUserId, stream.userLogin);
		}

		await announce(client, link, stream).catch((error) => {
			console.error(`StreamAlerts: failed to announce ${stream.userLogin} in guild ${link.guildId}:`, error.message);
		});
	}
}

let pollTimer = null;
// A slow Twitch response or a long list of sends could outlast the interval;
// overlapping polls would both see the same unannounced stream and post it
// twice. This only guards the in-flight poll — nothing here needs persisting.
let polling = false;

async function pollSafely(client) {
	if (polling) return;
	polling = true;
	try {
		await pollOnce(client);
	} catch (error) {
		console.error('StreamAlerts: poll failed:', error.message);
	} finally {
		polling = false;
	}
}

// Called once from events/ready.js. With no Twitch credentials the feature
// stays off rather than failing every minute; /streamers explains why.
function startPoller(client) {
	if (pollTimer) return;
	if (!twitch.isConfigured()) {
		console.log('StreamAlerts: TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET not set — Twitch go-live alerts are disabled.');
		return;
	}

	pollSafely(client);
	pollTimer = setInterval(() => pollSafely(client), POLL_INTERVAL_MS);
}

module.exports = { startPoller, buildAlertMessage };
