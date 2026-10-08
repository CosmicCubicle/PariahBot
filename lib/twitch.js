// Minimal Twitch Helix client — just the two lookups stream alerts need. No
// dependency: Node's built-in fetch covers it, matching the repo's habit of
// not pulling in a package for a few lines of code.

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const HELIX_URL = 'https://api.twitch.tv/helix';

// Helix caps repeated query parameters (user_id=, user_login=) at 100 per call.
const MAX_IDS_PER_REQUEST = 100;

// Refresh this long before Twitch's stated expiry, so a token never dies
// partway through a poll.
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

// Twitch's own rule for logins. Checked before any request so a typed-in
// value can't smuggle extra query parameters into the URL.
const LOGIN_PATTERN = /^[a-zA-Z0-9_]{4,25}$/;

// { value, expiresAt }. Deliberately in memory, not SQLite: it's a credential
// Twitch issues on demand (an app access token from the client-credentials
// grant), so a restart just asks for a new one, and writing a live secret to
// the database file would only widen who can read it. See WorkingAgreements.md
// § 1 for the exception.
let appToken = null;

function isConfigured() {
	return Boolean(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET);
}

function isValidLogin(login) {
	return LOGIN_PATTERN.test(login);
}

async function getAppToken() {
	if (appToken && appToken.expiresAt > Date.now()) return appToken.value;

	const response = await fetch(TOKEN_URL, {
		method: 'POST',
		body: new URLSearchParams({
			client_id: process.env.TWITCH_CLIENT_ID,
			client_secret: process.env.TWITCH_CLIENT_SECRET,
			grant_type: 'client_credentials',
		}),
	});
	if (!response.ok) {
		throw new Error(`Twitch rejected the client credentials (HTTP ${response.status}) — check TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in hom.env.`);
	}

	const { access_token: value, expires_in: expiresInSeconds } = await response.json();
	appToken = { value, expiresAt: Date.now() + (expiresInSeconds * 1000) - TOKEN_EXPIRY_MARGIN_MS };
	return value;
}

// One retry on 401: Twitch can revoke an app token before its stated expiry
// (e.g. the client secret was rotated), and the fix is just a fresh token.
async function helixGet(path, params, retried = false) {
	const token = await getAppToken();
	const response = await fetch(`${HELIX_URL}/${path}?${params}`, {
		headers: { 'Client-Id': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` },
	});

	if (response.status === 401 && !retried) {
		appToken = null;
		return helixGet(path, params, true);
	}
	if (!response.ok) {
		throw new Error(`Twitch API request to /${path} failed (HTTP ${response.status}).`);
	}
	return (await response.json()).data;
}

// Returns { id, login, displayName } or null when no such account exists.
async function getUserByLogin(login) {
	if (!isValidLogin(login)) return null;

	const [user] = await helixGet('users', new URLSearchParams({ login: login.toLowerCase() }));
	if (!user) return null;
	return { id: user.id, login: user.login, displayName: user.display_name };
}

// Returns a Map of twitchUserId -> stream, containing only the accounts that
// are live right now. Offline accounts are simply absent from Helix's reply.
async function getLiveStreams(twitchUserIds) {
	const live = new Map();
	for (let i = 0; i < twitchUserIds.length; i += MAX_IDS_PER_REQUEST) {
		const params = new URLSearchParams();
		for (const id of twitchUserIds.slice(i, i + MAX_IDS_PER_REQUEST)) params.append('user_id', id);

		const streams = await helixGet('streams', params);
		for (const stream of streams) {
			live.set(stream.user_id, {
				id: stream.id,
				userLogin: stream.user_login,
				userName: stream.user_name,
				title: stream.title,
				gameName: stream.game_name,
				viewerCount: stream.viewer_count,
				startedAt: stream.started_at,
				thumbnailUrl: stream.thumbnail_url,
			});
		}
	}
	return live;
}

module.exports = { isConfigured, isValidLogin, getUserByLogin, getLiveStreams };
