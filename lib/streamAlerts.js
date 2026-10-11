const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const streamerStore = require('../state/streamers');
const features = require('./features');
const guildSettings = require('../state/guildSettings');
const twitch = require('./twitch');
const youtube = require('./youtube');
const { renderAlertContent } = require('./alertContent');

const TWITCH_COLOR = 0x9146ff;
const YOUTUBE_COLOR = 0xff0033;

// Polling rather than push notifications (Twitch EventSub, YouTube
// PubSubHubbub): both need a public HTTPS endpoint, which a self-hosted bot
// behind a home connection usually doesn't have. A short delay is an
// acceptable trade. YouTube polls less often: its RSS feeds only refresh
// every few minutes anyway, and each poll spends API quota.
const TWITCH_POLL_INTERVAL_MS = 60 * 1000;
const YOUTUBE_POLL_INTERVAL_MS = 2 * 60 * 1000;

// The /live page check only exists for streams the feed can't see — 24/7 or
// long-running ones, or one buried under newer uploads — which have usually
// been going a while, so a slower cadence costs little. It's also the
// expensive check (an ordinary web page, ~150–200 KB a channel), so this is
// where the bandwidth is saved. See getLiveVideoId in lib/youtube.js.
const YOUTUBE_LIVE_PAGE_INTERVAL_MS = 15 * 60 * 1000;

// Only videos this recent are checked each feed poll. Bounds the quota spent
// per poll, and is why an upload's announcement can be forgotten after 30
// days (see state/streamers.js).
const YOUTUBE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

// Once a day is plenty — the retention window is 30 days.
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const THUMBNAIL_WIDTH = 1280;
const THUMBNAIL_HEIGHT = 720;

// Everything an alert needs that differs by platform and kind, built by the
// pollers below and turned into a Discord message by buildAlertMessage.
//   { platform, kind, contentId, color, heading, title, url, displayName,
//     game, imageUrl, timestamp, buttonLabel }

const PLATFORM_LABELS = { twitch: 'Twitch', youtube: 'YouTube' };

// What a custom message (/streamers message) can fill in. See
// lib/alertContent.js for {role}.
const MESSAGE_PLACEHOLDERS = ['name', 'title', 'url', 'platform'];

function buildAlertMessage(alert, member, pingRoleId, customMessage) {
	const who = member ?? `**${alert.displayName}**`;
	const action = alert.kind === 'upload' ? 'uploaded a new video' : 'is live';

	const embed = new EmbedBuilder()
		.setColor(alert.color)
		.setAuthor({ name: alert.heading, url: alert.url })
		.setTitle(alert.title.slice(0, 256))
		.setURL(alert.url)
		.setDescription(`${who} ${action}${alert.game ? ` — **${alert.game}**` : ''}.`);
	if (alert.imageUrl) embed.setImage(alert.imageUrl);
	if (alert.timestamp) embed.setTimestamp(new Date(alert.timestamp));

	const row = new ActionRowBuilder().addComponents(
		new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(alert.buttonLabel).setURL(alert.url),
	);

	return {
		content: renderAlertContent(customMessage, {
			name: alert.displayName,
			title: alert.title,
			url: alert.url,
			platform: PLATFORM_LABELS[alert.platform],
		}, pingRoleId),
		embeds: [embed],
		components: [row],
		// Only the configured role is ever pinged — not the streamer, who's
		// named in the embed, and not anything typed into a custom message.
		allowedMentions: { parse: [], roles: pingRoleId ? [pingRoleId] : [] },
	};
}

async function announce(client, link, alert) {
	// Already announced means it's been seen again — for a live item, still
	// live. Refreshing last_seen_at is what keeps a long-running stream's
	// record from being pruned and the stream re-announced.
	if (streamerStore.isAnnounced(link.guildId, link.platform, alert.contentId, alert.kind)) {
		streamerStore.touchAnnouncement(link.guildId, link.platform, alert.contentId, alert.kind);
		return;
	}

	const guild = client.guilds.cache.get(link.guildId);
	if (!guild) return;

	const { streamAlertChannelId, streamAlertRoleId, streamAlertMessage, streamerRoleId } = guildSettings.getGuildSettings(link.guildId);
	if (!streamAlertChannelId) return;

	// Fetching one member by ID needs no privileged intent. An admin-added
	// channel may have no member at all, or one who has since left — the
	// alert then just names the channel instead.
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

	// Recorded before sending, so a failed send isn't retried every poll for
	// the rest of the broadcast — a deleted channel or missing permission
	// would otherwise flood the log (and Discord) until it ended.
	streamerStore.markAnnounced(link.guildId, link.platform, alert.contentId, alert.kind);

	if (!channel?.isTextBased()) {
		console.error(`StreamAlerts: alert channel ${streamAlertChannelId} in guild ${link.guildId} is missing — run /streamers channel again.`);
		return;
	}
	await channel.send(buildAlertMessage(alert, member, streamAlertRoleId, streamAlertMessage));
}

function twitchAlert(stream) {
	const url = `https://www.twitch.tv/${stream.userLogin}`;

	// Twitch serves the same thumbnail URL for the whole broadcast; the
	// timestamp stops Discord showing a cached frame from an earlier stream.
	// It can be empty for a stream that only just started.
	const imageUrl = stream.thumbnailUrl
		? `${stream.thumbnailUrl.replace('{width}', THUMBNAIL_WIDTH).replace('{height}', THUMBNAIL_HEIGHT)}?t=${Date.now()}`
		: null;

	return {
		platform: 'twitch',
		kind: 'live',
		contentId: stream.id,
		color: TWITCH_COLOR,
		heading: `${stream.userName} is live on Twitch`,
		title: stream.title || `${stream.userName} is live`,
		url,
		displayName: stream.userName,
		game: stream.gameName,
		imageUrl,
		timestamp: stream.startedAt,
		buttonLabel: 'Watch on Twitch',
	};
}

async function pollTwitch(client) {
	// Guilds with the feature switched off (#69) are dropped before any
	// external request, so they cost no API quota — not just no message.
	const links = streamerStore.listLinksForPlatform('twitch')
		.filter((link) => features.isEnabled(link.guildId, 'streamers'));
	if (links.length === 0) return;

	// The same account can be on several guilds' lists; ask Twitch once.
	const accountIds = [...new Set(links.map((link) => link.accountId))];
	const live = await twitch.getLiveStreams(accountIds);

	for (const link of links) {
		const stream = live.get(link.accountId);
		if (!stream) continue;

		if (stream.userLogin !== link.accountName) {
			streamerStore.setAccountName(link.guildId, 'twitch', link.accountId, stream.userLogin);
		}

		await announce(client, link, twitchAlert(stream)).catch((error) => {
			console.error(`StreamAlerts: failed to announce Twitch ${stream.userLogin} in guild ${link.guildId}:`, error.message);
		});
	}
}

function youtubeAlert(video, kind) {
	const url = `https://www.youtube.com/watch?v=${video.id}`;
	return {
		platform: 'youtube',
		kind,
		contentId: video.id,
		color: YOUTUBE_COLOR,
		heading: kind === 'live' ? `${video.channelTitle} is live on YouTube` : `${video.channelTitle} uploaded a new video`,
		title: video.title,
		url,
		displayName: video.channelTitle,
		game: null,
		imageUrl: video.thumbnailUrl,
		timestamp: kind === 'live' ? video.startedAt : video.publishedAt,
		buttonLabel: 'Watch on YouTube',
	};
}

// Decides whether a video is worth an alert for this link, and which kind.
//   live now → a live alert (streams and premieres)
//   an ordinary upload published after the link was added → an upload alert
// Scheduled streams wait until they actually go live. Finished streams are
// never announced as uploads: their VOD is the same video ID, and the stream
// already had its own alert (or was missed, and is old news now).
// Times are compared parsed, never as strings: the feed, the API and our own
// added_at each format them differently (+00:00, Z, .000Z).
function classifyForLink(video, link) {
	if (video.state === 'live') return 'live';
	if (video.state === 'none' && !video.wasLive && Date.parse(video.publishedAt) >= Date.parse(link.addedAt)) return 'upload';
	return null;
}

async function pollYouTube(client) {
	// Guilds with the feature switched off (#69) are dropped before any
	// external request, so they cost no API quota — not just no message.
	const links = streamerStore.listLinksForPlatform('youtube')
		.filter((link) => features.isEnabled(link.guildId, 'streamers'));
	if (links.length === 0) return;

	// Feeds are free, so every channel's is read; only the recent videos in
	// them go to the quota-spending videos.list call, and only once each even
	// when several guilds follow the same channel.
	const channelIds = [...new Set(links.map((link) => link.accountId))];
	const cutoff = Date.now() - YOUTUBE_LOOKBACK_MS;
	const recentByChannel = new Map();
	for (const channelId of channelIds) {
		const feed = await youtube.getFeedVideos(channelId).catch((error) => {
			console.error(`StreamAlerts: ${error.message}`);
			return [];
		});
		recentByChannel.set(channelId, feed.filter((entry) => Date.parse(entry.publishedAt) >= cutoff).map((entry) => entry.videoId));
	}

	// A video already announced as an upload can never need another alert
	// (an ordinary upload never goes live), so it's dropped from the quota-
	// spending check once every guild following it has had it. Everything
	// else stays in: a scheduled stream has to be re-checked each poll until
	// it actually starts.
	const toCheck = new Set();
	for (const link of links) {
		for (const videoId of recentByChannel.get(link.accountId) ?? []) {
			if (!streamerStore.isAnnounced(link.guildId, 'youtube', videoId, 'upload')) toCheck.add(videoId);
		}
	}
	if (toCheck.size === 0) return;

	const videos = await youtube.getVideos([...toCheck]);

	for (const link of links) {
		for (const videoId of recentByChannel.get(link.accountId) ?? []) {
			const video = videos.get(videoId);
			if (!video) continue;

			if (video.channelTitle !== link.accountName) {
				streamerStore.setAccountName(link.guildId, 'youtube', link.accountId, video.channelTitle);
			}

			const kind = classifyForLink(video, link);
			if (!kind) continue;

			await announce(client, link, youtubeAlert(video, kind)).catch((error) => {
				console.error(`StreamAlerts: failed to announce YouTube ${videoId} in guild ${link.guildId}:`, error.message);
			});
		}
	}
}

// Catches the live streams pollYouTube's feed can't see (see
// YOUTUBE_LIVE_PAGE_INTERVAL_MS). The /live page only nominates a video; it's
// confirmed live through videos.list before anything is announced, since
// the page also points at scheduled streams.
async function pollYouTubeLivePages(client) {
	// Same as pollYouTube: filtered before the /live page fetches.
	const links = streamerStore.listLinksForPlatform('youtube')
		.filter((link) => features.isEnabled(link.guildId, 'streamers'));
	if (links.length === 0) return;

	const liveByChannel = new Map();
	for (const channelId of new Set(links.map((link) => link.accountId))) {
		const videoId = await youtube.getLiveVideoId(channelId).catch((error) => {
			console.error(`StreamAlerts: YouTube /live page for ${channelId} failed:`, error.message);
			return null;
		});
		if (videoId) liveByChannel.set(channelId, videoId);
	}

	// A stream already announced everywhere needs no quota: still being on the
	// /live page is enough to keep its record fresh. Only new candidates go
	// to the API.
	const toCheck = new Set();
	for (const link of links) {
		const videoId = liveByChannel.get(link.accountId);
		if (!videoId) continue;
		if (streamerStore.isAnnounced(link.guildId, 'youtube', videoId, 'live')) {
			streamerStore.touchAnnouncement(link.guildId, 'youtube', videoId, 'live');
		} else {
			toCheck.add(videoId);
		}
	}
	if (toCheck.size === 0) return;

	const videos = await youtube.getVideos([...toCheck]);
	for (const link of links) {
		const video = videos.get(liveByChannel.get(link.accountId));
		if (video?.state !== 'live') continue;

		await announce(client, link, youtubeAlert(video, 'live')).catch((error) => {
			console.error(`StreamAlerts: failed to announce YouTube ${video.id} in guild ${link.guildId}:`, error.message);
		});
	}
}

// One timer per platform, each with its own in-flight guard: a slow
// response or a long list of sends could outlast the interval, and
// overlapping polls would both see the same unannounced item and post it
// twice. The guards only cover the poll in progress — nothing here needs
// persisting.
function startPlatformPoller(name, poll, intervalMs, client) {
	let polling = false;
	const run = async () => {
		if (polling) return;
		polling = true;
		try {
			await poll(client);
		} catch (error) {
			console.error(`StreamAlerts: ${name} poll failed:`, error.message);
		} finally {
			polling = false;
		}
	};

	run();
	return setInterval(run, intervalMs);
}

let started = false;

// Called once from events/ready.js. A platform with no credentials stays off
// rather than failing every poll; /streamers explains what's missing.
function startPoller(client) {
	if (started) return;
	started = true;

	const prune = () => {
		try {
			streamerStore.pruneAnnouncements();
		} catch (error) {
			console.error('StreamAlerts: failed to prune old announcements:', error.message);
		}
	};
	prune();
	setInterval(prune, PRUNE_INTERVAL_MS);

	if (twitch.isConfigured()) {
		startPlatformPoller('Twitch', pollTwitch, TWITCH_POLL_INTERVAL_MS, client);
	} else {
		console.log('StreamAlerts: TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET not set — Twitch alerts are disabled.');
	}

	if (youtube.isConfigured()) {
		startPlatformPoller('YouTube', pollYouTube, YOUTUBE_POLL_INTERVAL_MS, client);
		startPlatformPoller('YouTube live pages', pollYouTubeLivePages, YOUTUBE_LIVE_PAGE_INTERVAL_MS, client);
	} else {
		console.log('StreamAlerts: YOUTUBE_API_KEY not set — YouTube alerts are disabled.');
	}
}

module.exports = { MESSAGE_PLACEHOLDERS, startPoller, buildAlertMessage, classifyForLink };
