// Minimal YouTube client — just what stream and upload alerts need. No
// dependency: Node's built-in fetch covers it, and the RSS feed is simple
// enough to read without an XML parser.
//
// Two sources, chosen for quota:
// - Each channel's public RSS feed lists its ~15 latest videos (uploads,
//   live streams and premieres alike). Free, no key, no quota.
// - The Data API's videos.list then says which of those are live right now.
//   1 quota unit per 50 videos, against a default 10,000 a day.
// The obvious alternative, search.list with eventType=live, costs 100 units
// a call — polling it every couple of minutes would exhaust the daily quota
// with a handful of channels.

const API_URL = 'https://www.googleapis.com/youtube/v3';
const FEED_URL = 'https://www.youtube.com/feeds/videos.xml';

// videos.list accepts at most 50 IDs per call.
const MAX_IDS_PER_REQUEST = 50;

const CHANNEL_ID_PATTERN = /^UC[\w-]{22}$/;
const HANDLE_PATTERN = /^@[\w.-]{3,30}$/;

function isConfigured() {
	return Boolean(process.env.YOUTUBE_API_KEY);
}

// Accepts what people actually paste: a channel URL (/@handle or /channel/UC…),
// a bare @handle, a bare handle, or a UC… channel ID. Returns { channelId }
// or { handle }, or null if it's none of those. Checked before any request so
// a typed-in value can't smuggle extra query parameters into the URL.
function parseChannelInput(raw) {
	let value = raw.trim();

	const url = value.match(/^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/(.+)$/i);
	if (url) {
		const path = url[1].split(/[/?#]/);
		if (path[0].startsWith('@')) value = path[0];
		else if (path[0] === 'channel' && path[1]) value = path[1];
		else return null;
	}

	if (CHANNEL_ID_PATTERN.test(value)) return { channelId: value };
	const handle = value.startsWith('@') ? value : `@${value}`;
	if (HANDLE_PATTERN.test(handle)) return { handle };
	return null;
}

async function apiGet(path, params) {
	params.set('key', process.env.YOUTUBE_API_KEY);
	const response = await fetch(`${API_URL}/${path}?${params}`);
	if (response.status === 403) {
		throw new Error("YouTube refused the request (HTTP 403) — check YOUTUBE_API_KEY in hom.env, and that the daily API quota isn't used up.");
	}
	if (!response.ok) {
		throw new Error(`YouTube API request to /${path} failed (HTTP ${response.status}).`);
	}
	return (await response.json()).items ?? [];
}

// Returns { id, name } or null when no such channel exists. 1 quota unit.
async function resolveChannel(raw) {
	const parsed = parseChannelInput(raw);
	if (!parsed) return null;

	const params = new URLSearchParams({ part: 'snippet' });
	if (parsed.channelId) params.set('id', parsed.channelId);
	else params.set('forHandle', parsed.handle);

	const [channel] = await apiGet('channels', params);
	if (!channel) return null;
	return { id: channel.id, name: channel.snippet.title };
}

function decodeXml(text) {
	return text
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&');
}

// Returns [{ videoId, publishedAt }] from the channel's RSS feed, newest
// first. An empty list (not an error) for a channel with no videos.
async function getFeedVideos(channelId) {
	const response = await fetch(`${FEED_URL}?${new URLSearchParams({ channel_id: channelId })}`);
	if (response.status === 404) return [];
	if (!response.ok) {
		throw new Error(`YouTube feed for ${channelId} failed (HTTP ${response.status}).`);
	}

	const xml = await response.text();
	const videos = [];
	for (const [entry] of xml.matchAll(/<entry>[\s\S]*?<\/entry>/g)) {
		const videoId = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
		const publishedAt = entry.match(/<published>([^<]+)<\/published>/)?.[1];
		if (videoId && publishedAt) videos.push({ videoId: decodeXml(videoId), publishedAt });
	}
	return videos;
}

// The feed only holds a channel's 15 newest videos, so it can't see a stream
// that started long ago (a 24/7 stream) or one buried under newer uploads.
// A channel's /live page points at whatever it's streaming right now,
// however old: its canonical link is that video's watch URL when there's a
// stream on (or scheduled — getVideos tells those apart), and the channel's
// own URL when there isn't.
//
// The page is ~1.3 MB and the canonical link sits ~750 KB in, so the body is
// read as a stream and abandoned the moment the link turns up — compressed,
// that's roughly 150–200 KB per check. It's also an ordinary web page, not an
// API: if YouTube changes its markup this quietly finds nothing, and alerts
// fall back to what the feed can see.
const LIVE_PAGE_READ_LIMIT = 2 * 1024 * 1024;
const CANONICAL_PATTERN = /<link rel="canonical" href="([^"]+)"/;
const WATCH_URL_PATTERN = /^https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})$/;

// Returns the video ID the channel's /live page points at, or null.
async function getLiveVideoId(channelId) {
	const response = await fetch(`https://www.youtube.com/channel/${channelId}/live`, {
		// Without this, hosts in the EU get Google's cookie-consent page
		// instead of the channel.
		headers: { 'Accept-Language': 'en', Cookie: 'CONSENT=YES+1' },
	});
	if (!response.ok || !response.body) return null;

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let html = '';
	try {
		while (html.length < LIVE_PAGE_READ_LIMIT) {
			const { done, value } = await reader.read();
			if (done) break;
			html += decoder.decode(value, { stream: true });

			const canonical = CANONICAL_PATTERN.exec(html);
			if (canonical) return WATCH_URL_PATTERN.exec(canonical[1])?.[1] ?? null;
		}
		return null;
	} finally {
		await reader.cancel().catch(() => null);
	}
}

function bestThumbnail(thumbnails = {}) {
	return (thumbnails.maxres ?? thumbnails.standard ?? thumbnails.high ?? thumbnails.medium ?? thumbnails.default)?.url ?? null;
}

// Returns a Map of videoId -> video for the IDs YouTube still knows about
// (deleted or private videos are simply absent). 1 quota unit per 50 IDs.
//   state: 'live' (streaming or premiering now), 'upcoming' (scheduled), or
//          'none' (an ordinary upload, or a stream that has finished)
//   wasLive: true for anything that is or was a live stream or premiere —
//            what tells a finished stream apart from a real upload.
async function getVideos(videoIds) {
	const videos = new Map();
	for (let i = 0; i < videoIds.length; i += MAX_IDS_PER_REQUEST) {
		const params = new URLSearchParams({
			part: 'snippet,liveStreamingDetails',
			id: videoIds.slice(i, i + MAX_IDS_PER_REQUEST).join(','),
		});

		for (const item of await apiGet('videos', params)) {
			videos.set(item.id, {
				id: item.id,
				title: item.snippet.title,
				channelId: item.snippet.channelId,
				channelTitle: item.snippet.channelTitle,
				publishedAt: item.snippet.publishedAt,
				thumbnailUrl: bestThumbnail(item.snippet.thumbnails),
				state: item.snippet.liveBroadcastContent,
				wasLive: Boolean(item.liveStreamingDetails),
				startedAt: item.liveStreamingDetails?.actualStartTime ?? null,
			});
		}
	}
	return videos;
}

module.exports = { isConfigured, parseChannelInput, resolveChannel, getFeedVideos, getLiveVideoId, getVideos };
