const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const zlib = require('node:zlib');

// Fetches a URL that a server admin typed in (an RSS feed), without letting
// it reach anything on the host's own network. PariahBot is self-hosted —
// often on a home network next to routers, NAS boxes and admin panels — and
// any admin of any server the bot is in can add a feed. Without this, a feed
// pointed at http://192.168.1.1/ would have the bot fetch it and post what
// it found into Discord (server-side request forgery).
//
// The address check runs inside the connection itself (the `lookup` hook),
// on every address DNS returns, for every hop of a redirect. Checking only
// the URL when the feed is added wouldn't do: DNS can be changed afterwards
// to point a harmless-looking name at an internal address.
//
// node:http rather than the built-in fetch, because fetch has no hook for
// vetting the address it's about to connect to.

const MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15 * 1000;

const USER_AGENT = 'PariahBot RSS (+https://github.com/CosmicCubicle/PariahBot)';

// Everything that isn't the public internet.
const BLOCKED = new net.BlockList();
for (const [address, prefix] of [
	['0.0.0.0', 8], // "this" network
	['10.0.0.0', 8], // private
	['100.64.0.0', 10], // carrier-grade NAT
	['127.0.0.0', 8], // loopback
	['169.254.0.0', 16], // link-local, including cloud metadata services
	['172.16.0.0', 12], // private
	['192.0.0.0', 24], // IETF protocol assignments
	['192.168.0.0', 16], // private
	['198.18.0.0', 15], // benchmarking
	['224.0.0.0', 4], // multicast
	['240.0.0.0', 4], // reserved, and broadcast
]) {
	BLOCKED.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
	['::', 128], // unspecified
	['::1', 128], // loopback
	['fc00::', 7], // unique local
	['fe80::', 10], // link-local
	['ff00::', 8], // multicast
]) {
	BLOCKED.addSubnet(address, prefix, 'ipv6');
}

class BlockedAddressError extends Error {
	constructor(address) {
		super(`${address} is on a private or local network, which PariahBot won't fetch from.`);
		this.code = 'EBLOCKEDADDRESS';
	}
}

function isBlockedAddress(address) {
	const family = net.isIP(address);
	if (family === 4) return BLOCKED.check(address, 'ipv4');
	if (family === 6) {
		// An IPv4 address written as IPv6 (::ffff:10.0.0.1) is still that IPv4
		// address.
		const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
		if (mapped) return BLOCKED.check(mapped, 'ipv4');
		return BLOCKED.check(address, 'ipv6');
	}
	return true;
}

// Called by the socket for every connection. Node may ask for one address or
// all of them (when trying IPv4 and IPv6 side by side); if any is internal,
// none are used, so a name can't mix a public address with a private one.
function safeLookup(hostname, options, callback) {
	dns.lookup(hostname, options, (error, address, family) => {
		if (error) return callback(error);
		const addresses = Array.isArray(address) ? address : [{ address, family }];
		const blocked = addresses.find((entry) => isBlockedAddress(entry.address));
		if (blocked) return callback(new BlockedAddressError(blocked.address));
		return callback(null, address, family);
	});
}

function decompress(response) {
	const encoding = (response.headers['content-encoding'] ?? '').toLowerCase();
	if (encoding === 'gzip' || encoding === 'x-gzip') return response.pipe(zlib.createGunzip());
	if (encoding === 'deflate') return response.pipe(zlib.createInflate());
	if (encoding === 'br') return response.pipe(zlib.createBrotliDecompress());
	return response;
}

// One request, no redirect following. Resolves { status, location, body }.
function request(url, { maxBytes, deadline }) {
	return new Promise((resolve, reject) => {
		const client = url.protocol === 'https:' ? https : http;
		const remaining = Math.max(1, deadline - Date.now());
		const req = client.get(url, {
			lookup: safeLookup,
			headers: {
				'User-Agent': USER_AGENT,
				Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5',
				'Accept-Encoding': 'gzip, deflate, br',
			},
			timeout: remaining,
		}, (response) => {
			const status = response.statusCode ?? 0;
			if (status >= 300 && status < 400) {
				response.resume();
				resolve({ status, location: response.headers.location ?? null, body: null });
				return;
			}

			const stream = decompress(response);
			const chunks = [];
			let size = 0;
			stream.on('data', (chunk) => {
				size += chunk.length;
				if (size > maxBytes) {
					req.destroy(new Error(`the response is bigger than ${Math.round(maxBytes / 1024 / 1024)} MB`));
					return;
				}
				chunks.push(chunk);
			});
			stream.on('end', () => resolve({ status, location: null, body: Buffer.concat(chunks) }));
			stream.on('error', reject);
		});
		req.on('timeout', () => req.destroy(new Error('it took too long to respond')));
		req.on('error', reject);
	});
}

// Returns the response body as a Buffer, or throws an Error whose message
// says what went wrong in terms an admin can act on.
async function safeFetch(rawUrl, { maxBytes = DEFAULT_MAX_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	const deadline = Date.now() + timeoutMs;
	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error(`"${rawUrl}" isn't a valid web address.`);
	}

	for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
		if (url.protocol !== 'https:' && url.protocol !== 'http:') {
			throw new Error('Only http and https addresses can be fetched.');
		}
		// A bare IP address skips DNS, and so the lookup hook — check it here.
		const host = url.hostname.replace(/^\[|\]$/g, '');
		if (net.isIP(host) && isBlockedAddress(host)) throw new BlockedAddressError(host);

		const { status, location, body } = await request(url, { maxBytes, deadline });
		if (body) {
			if (status < 200 || status >= 300) throw new Error(`the site answered with HTTP ${status}`);
			return body;
		}
		if (!location) throw new Error(`the site redirected (HTTP ${status}) without saying where`);
		url = new URL(location, url);
	}
	throw new Error(`the site redirected more than ${MAX_REDIRECTS} times`);
}

module.exports = { safeFetch, isBlockedAddress, BlockedAddressError };
