// Minimal Instagram client — just what post alerts need. No dependency:
// Node's built-in fetch covers it.
//
// Instagram has no free public feed like YouTube's RSS, so this goes through
// the Graph API's Business Discovery: with a token for one Business/Creator
// account (the host's own, INSTAGRAM_BUSINESS_ACCOUNT_ID), it reads any other
// public Business or Creator account's recent posts by username, one call per
// account. Personal and age-gated accounts can't be read this way at all.
//
// The token is only ever read from hom.env, never refreshed or stored, so the
// bot never writes a live secret into the database (WorkingAgreements.md
// § 1). The host uses a System User token from their Meta business
// portfolio, which neither expires nor has its data access lapse. A Page
// token made from a person's login also never expires, but its data access
// lapses after 90 days and renewing it needs that person in a browser — no
// refresh from here could do it, which is why the wiki steers to System Users.

// Meta retires a Graph API version about two years after its release. Bump
// this before then, after checking the changelog for changes to the fields
// requested in getRecentMedia.
const GRAPH_API_VERSION = 'v25.0';
const API_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// Posts polled per account. A poll every 10 minutes (see
// lib/instagramAlerts.js) would need an account to post more than this in
// that window to miss one.
const MEDIA_PER_ACCOUNT = 10;

// Instagram usernames: 1–30 letters, numbers, periods and underscores.
const USERNAME_PATTERN = /^[\w.]{1,30}$/;

// The first path segment of instagram.com links that aren't profiles.
const NON_PROFILE_PATHS = new Set(['p', 'reel', 'reels', 'tv', 'stories', 'explore']);

// Graph API error codes worth telling apart. 110 / subcode 2207013 is
// Business Discovery's "no such Business or Creator account"; 190 is a bad,
// revoked or lapsed token; 10 and 200 mean the token is missing a
// permission; the rest are rate limits.
const NOT_FOUND_CODE = 110;
const NOT_FOUND_SUBCODE = 2_207_013;
const INVALID_TOKEN_CODE = 190;
const PERMISSION_CODES = new Set([10, 200]);
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80_002]);

function isConfigured() {
	return Boolean(process.env.INSTAGRAM_ACCESS_TOKEN && process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID);
}

// Accepts what people actually paste: an instagram.com/<username> link, an
// @username, or a bare username. Returns the lower-cased username, or null.
// Checked before any request so a typed-in value can't smuggle extra fields
// into the Business Discovery query, which embeds it unescaped.
function parseUsername(raw) {
	let value = raw.trim();

	const url = value.match(/^(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/([^/?#]+)/i);
	if (url) {
		// A pasted post or reel link names the post, not the account — and
		// "p" or "reel" would otherwise be read as a (real) username.
		if (NON_PROFILE_PATHS.has(url[1].toLowerCase())) return null;
		value = url[1];
	}

	value = value.replace(/^@/, '').toLowerCase();
	return USERNAME_PATTERN.test(value) ? value : null;
}

// The Graph API sends offsets as +0000, which isn't ISO 8601 and isn't
// guaranteed to parse. Everything stored or compared uses this form.
function normalizeTimestamp(timestamp) {
	return new Date(timestamp.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).toISOString();
}

function mapMedia(item) {
	return {
		id: item.id,
		caption: item.caption ?? '',
		// Videos carry the video itself in media_url; their still is
		// thumbnail_url. media_url is missing altogether for videos with
		// licensed audio, so the alert can end up with no image.
		imageUrl: item.media_type === 'VIDEO' ? (item.thumbnail_url ?? null) : (item.media_url ?? null),
		isReel: item.media_product_type === 'REELS',
		url: item.permalink,
		publishedAt: normalizeTimestamp(item.timestamp),
	};
}

// Returns { account: { id, username, name, profilePictureUrl }, media: [...] }
// for a Business or Creator account, newest post first, or null when there's
// no such account (or it's personal or age-gated, which look the same).
async function getRecentMedia(username) {
	const fields = `business_discovery.username(${username}){`
		+ 'id,username,name,profile_picture_url,'
		+ `media.limit(${MEDIA_PER_ACCOUNT}){id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp}`
		+ '}';
	const params = new URLSearchParams({ fields, access_token: process.env.INSTAGRAM_ACCESS_TOKEN });
	const response = await fetch(`${API_URL}/${process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID}?${params}`);
	const body = await response.json().catch(() => ({}));

	if (!response.ok) {
		const { code, error_subcode: subcode } = body.error ?? {};
		if (code === NOT_FOUND_CODE || subcode === NOT_FOUND_SUBCODE) return null;
		if (code === INVALID_TOKEN_CODE) {
			throw new Error('Instagram refused the access token (revoked, or a Page token whose 90-day data access lapsed) — the bot owner needs to generate a new INSTAGRAM_ACCESS_TOKEN for the System User, put it in hom.env and restart the bot.');
		}
		if (PERMISSION_CODES.has(code)) {
			throw new Error('Instagram says the access token is missing a permission — the bot owner needs to check the System User has the Page and Instagram account assigned, then generate a new INSTAGRAM_ACCESS_TOKEN with instagram_basic, instagram_manage_insights, pages_show_list, pages_read_engagement and business_management.');
		}
		if (RATE_LIMIT_CODES.has(code)) {
			throw new Error('Instagram is rate-limiting this bot — alerts will catch up once the limit resets.');
		}
		throw new Error(`Instagram API request failed (HTTP ${response.status}${body.error?.message ? `: ${body.error.message}` : ''}).`);
	}

	const account = body.business_discovery;
	if (!account) return null;
	return {
		account: {
			id: account.id,
			username: account.username,
			name: account.name ?? account.username,
			profilePictureUrl: account.profile_picture_url ?? null,
		},
		media: (account.media?.data ?? []).map(mapMedia),
	};
}

// Turns what an admin typed into a followable account, or throws a message
// they can act on. Shared by /instagram add and the admin dashboard.
async function resolveAccount(raw) {
	const username = parseUsername(raw);
	if (!username) {
		throw new Error(`"${raw}" doesn't look like an Instagram account — use its username, @username or instagram.com/<username> link.`);
	}
	const result = await getRecentMedia(username);
	if (!result) {
		throw new Error(`Couldn't read @${username} on Instagram. Check the spelling — and the account has to be a public Business or Creator account (Instagram doesn't let bots read personal accounts). Its owner can switch in Instagram's Settings → Account type and tools.`);
	}
	return result.account;
}

module.exports = { isConfigured, parseUsername, getRecentMedia, resolveAccount };
