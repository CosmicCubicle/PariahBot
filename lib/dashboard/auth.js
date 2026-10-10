const crypto = require('node:crypto');

// Signing in to the admin dashboard: Discord OAuth2 (identify scope only),
// then a signed session cookie. Only the bot's owner gets in — the
// application's owner, or every member of its team — checked on every request.
//
// Sessions aren't stored anywhere: the cookie carries the user's ID and an
// expiry, signed with HMAC-SHA256, so a restart doesn't sign anyone out and
// there's no session table or in-memory map (WorkingAgreements.md § 1). The
// key is derived from DISCORD_CLIENT_SECRET, so rotating that secret in the
// Developer Portal signs everyone out.

const SESSION_COOKIE = 'pariahbot_session';
const STATE_COOKIE = 'pariahbot_oauth_state';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;

// Owner IDs come from Discord and are cheap to fetch again, so they're only
// cached briefly (like lib/autoDelete.js's message cache, Discord is the
// source of truth). Someone removed from the team loses access within this.
const OWNER_CACHE_MS = 5 * 60 * 1000;

const DISCORD_API = 'https://discord.com/api/v10';

function signingKey() {
	return crypto.createHmac('sha256', process.env.DISCORD_CLIENT_SECRET).update('pariahbot-dashboard-session').digest();
}

function sign(payload) {
	const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
	const mac = crypto.createHmac('sha256', signingKey()).update(body).digest('base64url');
	return `${body}.${mac}`;
}

// Returns the payload, or null for anything forged, tampered with or expired.
function verify(token) {
	if (typeof token !== 'string') return null;
	const [body, mac] = token.split('.');
	if (!body || !mac) return null;
	const expected = crypto.createHmac('sha256', signingKey()).update(body).digest();
	const given = Buffer.from(mac, 'base64url');
	if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
	try {
		const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
		return payload.exp > Date.now() ? payload : null;
	} catch {
		return null;
	}
}

function parseCookies(header = '') {
	return Object.fromEntries(header.split(';').map((part) => {
		const index = part.indexOf('=');
		return index === -1 ? [part.trim(), ''] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
	}).filter(([name]) => name));
}

// Lax, not Strict: the browser has to send the state cookie back on the
// redirect from discord.com, and the session cookie on the page load that
// follows it. Changes are protected separately — see lib/dashboard/server.js.
function cookie(name, value, maxAgeMs, secure) {
	return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? '; Secure' : ''}`;
}

function clearCookie(name, secure) {
	return cookie(name, '', 0, secure);
}

let ownerCache = { ids: new Set(), fetchedAt: 0 };

async function getOwnerIds(client) {
	if (Date.now() - ownerCache.fetchedAt < OWNER_CACHE_MS) return ownerCache.ids;
	const application = await client.application.fetch();
	const { owner } = application;
	// A team-owned application lists its members; a personal one, its owner.
	const ids = owner?.members ? new Set(owner.members.map((member) => member.id)) : new Set(owner ? [owner.id] : []);
	ownerCache = { ids, fetchedAt: Date.now() };
	return ids;
}

// The signed-in owner for this request, or null.
async function currentUser(req, client) {
	const session = verify(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
	if (!session) return null;
	const owners = await getOwnerIds(client);
	return owners.has(session.id) ? { id: session.id, username: session.username, avatar: session.avatar } : null;
}

function newState() {
	return crypto.randomBytes(24).toString('base64url');
}

function authorizeUrl(redirectUri, state) {
	const params = new URLSearchParams({
		client_id: process.env.CLIENT_ID,
		response_type: 'code',
		redirect_uri: redirectUri,
		scope: 'identify',
		state,
		prompt: 'none',
	});
	return `https://discord.com/oauth2/authorize?${params}`;
}

// Swaps the one-time code for an access token, reads who signed in, and
// throws the token away — the dashboard never acts as the user on Discord.
async function identify(code, redirectUri) {
	const tokenResponse = await fetch(`${DISCORD_API}/oauth2/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: process.env.CLIENT_ID,
			client_secret: process.env.DISCORD_CLIENT_SECRET,
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirectUri,
		}),
	});
	if (!tokenResponse.ok) {
		throw new Error(`Discord refused the sign-in (HTTP ${tokenResponse.status}). Check DISCORD_CLIENT_SECRET, and that ${redirectUri} is listed under OAuth2 → Redirects in the Developer Portal.`);
	}
	const { access_token: accessToken } = await tokenResponse.json();

	const userResponse = await fetch(`${DISCORD_API}/users/@me`, { headers: { Authorization: `Bearer ${accessToken}` } });
	if (!userResponse.ok) throw new Error(`Couldn't read your Discord account (HTTP ${userResponse.status}).`);
	const user = await userResponse.json();
	return { id: user.id, username: user.global_name || user.username, avatar: user.avatar };
}

function sessionToken(user) {
	return sign({ id: user.id, username: user.username, avatar: user.avatar, exp: Date.now() + SESSION_TTL_MS });
}

function stateToken(state) {
	return sign({ state, exp: Date.now() + STATE_TTL_MS });
}

function verifyState(req, state) {
	const saved = verify(parseCookies(req.headers.cookie)[STATE_COOKIE]);
	if (!saved || typeof state !== 'string') return false;
	const a = Buffer.from(saved.state);
	const b = Buffer.from(state);
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
	SESSION_COOKIE,
	STATE_COOKIE,
	SESSION_TTL_MS,
	STATE_TTL_MS,
	cookie,
	clearCookie,
	currentUser,
	getOwnerIds,
	newState,
	authorizeUrl,
	identify,
	sessionToken,
	stateToken,
	verifyState,
	verify,
	sign,
};
