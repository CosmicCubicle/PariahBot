const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const auth = require('./auth');
const api = require('./api');

// The admin dashboard's web server. Off unless DASHBOARD_PORT is set, and on
// 127.0.0.1 unless DASHBOARD_HOST says otherwise: it's meant to be opened on
// the bot's own host, or through an SSH tunnel to it. node:http and static
// files, no framework — see CodeStandards.md § 1.
//
// Protection, in the order a request meets it:
//   - the Host header must be this dashboard's own (a DNS-rebinding page
//     can't talk to it under another name)
//   - every response carries a strict Content-Security-Policy, and can't be
//     framed
//   - /api/* needs a valid session cookie for one of the bot's owners
//   - changes are POSTs with a JSON body, a custom header and, when the
//     browser sends one, a matching Origin — a form on another site can't
//     produce that request

const STATIC_DIR = path.join(__dirname, '..', '..', 'dashboard');
const STATIC_FILES = {
	'/': { file: 'index.html', type: 'text/html; charset=utf-8' },
	'/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
	'/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

const MAX_BODY_BYTES = 64 * 1024;
const CSRF_HEADER = 'x-pariahbot-dashboard';

const SECURITY_HEADERS = {
	'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://cdn.discordapp.com data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'no-referrer',
	'X-Frame-Options': 'DENY',
	'Cache-Control': 'no-store',
};

function config() {
	const port = Number(process.env.DASHBOARD_PORT);
	const host = process.env.DASHBOARD_HOST || '127.0.0.1';
	const publicUrl = (process.env.DASHBOARD_PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, '');
	return { port, host, publicUrl, redirectUri: `${publicUrl}/auth/callback`, secure: publicUrl.startsWith('https:') };
}

function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
	res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, ...headers });
	res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function redirect(res, location, headers = {}) {
	res.writeHead(302, { ...SECURITY_HEADERS, Location: location, ...headers });
	res.end();
}

function readJson(req) {
	return new Promise((resolve, reject) => {
		if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
			reject(Object.assign(new Error('Expected a JSON body.'), { status: 415 }));
			return;
		}
		let size = 0;
		const chunks = [];
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(Object.assign(new Error('Request too large.'), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			try {
				resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
			} catch {
				reject(Object.assign(new Error('Invalid JSON.'), { status: 400 }));
			}
		});
		req.on('error', reject);
	});
}

function createHandler(client, settings) {
	const allowedHosts = new Set([
		new URL(settings.publicUrl).host,
		`localhost:${settings.port}`,
		`127.0.0.1:${settings.port}`,
		`[::1]:${settings.port}`,
	]);
	if (settings.host !== '0.0.0.0' && settings.host !== '::') allowedHosts.add(`${settings.host}:${settings.port}`);
	const allowedOrigin = new URL(settings.publicUrl).origin;

	async function handleApi(req, res, url) {
		const user = await auth.currentUser(req, client);
		if (!user) return send(res, 401, { error: 'Sign in first.' });

		if (req.method === 'GET') {
			if (url.pathname === '/api/me') return send(res, 200, user);
			if (url.pathname === '/api/status') return send(res, 200, api.status(client));
			if (url.pathname === '/api/guilds') return send(res, 200, api.guildList(client));
			const guildMatch = url.pathname.match(/^\/api\/guilds\/(\d{17,20})$/);
			if (guildMatch) return send(res, 200, api.guildSnapshot(client, api.requireGuild(client, guildMatch[1])));
			return send(res, 404, { error: 'Not found.' });
		}

		if (req.method === 'POST') {
			// Forged-request guard: a cross-site form can't set a custom header
			// or send JSON, and a browser always says where a request came from.
			if (req.headers[CSRF_HEADER] !== '1') return send(res, 403, { error: 'Missing dashboard header.' });
			if (req.headers.origin && req.headers.origin !== allowedOrigin) return send(res, 403, { error: 'Wrong origin.' });

			const actionMatch = url.pathname.match(/^\/api\/guilds\/(\d{17,20})\/actions\/([\w.]+)$/);
			if (!actionMatch) return send(res, 404, { error: 'Not found.' });
			const body = await readJson(req);
			const message = await api.runAction(client, user, actionMatch[1], actionMatch[2], body);
			return send(res, 200, { message });
		}

		return send(res, 405, { error: 'Method not allowed.' });
	}

	async function handleLogin(res) {
		const state = auth.newState();
		redirect(res, auth.authorizeUrl(settings.redirectUri, state), {
			'Set-Cookie': auth.cookie(auth.STATE_COOKIE, auth.stateToken(state), auth.STATE_TTL_MS, settings.secure),
		});
	}

	async function handleCallback(req, res, url) {
		const clearState = auth.clearCookie(auth.STATE_COOKIE, settings.secure);
		if (url.searchParams.get('error')) {
			return send(res, 400, 'Sign-in was cancelled. <a href="/">Back</a>', 'text/html; charset=utf-8', { 'Set-Cookie': clearState });
		}
		if (!auth.verifyState(req, url.searchParams.get('state'))) {
			return send(res, 400, 'That sign-in link expired or was tampered with. <a href="/">Try again</a>', 'text/html; charset=utf-8', { 'Set-Cookie': clearState });
		}

		const user = await auth.identify(url.searchParams.get('code') ?? '', settings.redirectUri);
		const owners = await auth.getOwnerIds(client);
		if (!owners.has(user.id)) {
			console.warn(`Dashboard: refused sign-in from ${user.username} (${user.id}) — not an owner of the bot's application.`);
			return send(res, 403, "Only the bot's owner can use this dashboard. <a href=\"/\">Back</a>", 'text/html; charset=utf-8', { 'Set-Cookie': clearState });
		}

		console.log(`Dashboard: ${user.username} (${user.id}) signed in.`);
		return redirect(res, '/', {
			'Set-Cookie': [auth.cookie(auth.SESSION_COOKIE, auth.sessionToken(user), auth.SESSION_TTL_MS, settings.secure), clearState],
		});
	}

	return async (req, res) => {
		try {
			if (!allowedHosts.has(req.headers.host ?? '')) return send(res, 421, { error: 'Unknown host.' });
			const url = new URL(req.url, settings.publicUrl);

			if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
			if (req.method === 'GET' && url.pathname === '/login') return await handleLogin(res);
			if (req.method === 'GET' && url.pathname === '/auth/callback') return await handleCallback(req, res, url);
			if (req.method === 'POST' && url.pathname === '/logout') {
				if (req.headers[CSRF_HEADER] !== '1') return send(res, 403, { error: 'Missing dashboard header.' });
				return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': auth.clearCookie(auth.SESSION_COOKIE, settings.secure) });
			}

			const asset = req.method === 'GET' ? STATIC_FILES[url.pathname] : null;
			if (asset) return send(res, 200, fs.readFileSync(path.join(STATIC_DIR, asset.file)), asset.type);
			return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
		} catch (error) {
			// An action's own error is a message for the page; anything else is
			// logged and kept vague.
			const status = error.status ?? (req.url?.startsWith('/api/') ? 400 : 500);
			if (status >= 500) console.error('Dashboard: request failed:', error);
			if (!res.headersSent) send(res, status, { error: error.message });
			return undefined;
		}
	};
}

// Called once from events/ready.js.
function startDashboard(client) {
	if (!process.env.DASHBOARD_PORT) {
		console.log('Dashboard: DASHBOARD_PORT not set — the admin dashboard is off.');
		return null;
	}
	const settings = config();
	if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65_535) {
		console.error(`Dashboard: DASHBOARD_PORT "${process.env.DASHBOARD_PORT}" isn't a valid port — the dashboard is off.`);
		return null;
	}
	if (!process.env.CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
		console.error('Dashboard: CLIENT_ID and DISCORD_CLIENT_SECRET are needed for Discord sign-in — the dashboard is off.');
		return null;
	}

	const server = http.createServer(createHandler(client, settings));
	server.on('error', (error) => console.error(`Dashboard: couldn't listen on ${settings.host}:${settings.port}:`, error.message));
	server.listen(settings.port, settings.host, () => {
		console.log(`Dashboard: listening on http://${settings.host}:${settings.port} — open ${settings.publicUrl} (redirect URL: ${settings.redirectUri}).`);
	});
	return server;
}

module.exports = { startDashboard, createHandler, config };
