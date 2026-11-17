// Minimal Patreon client — just what post alerts need. No dependency: Node's
// built-in fetch covers it.
//
// Patreon has no public per-creator feed, and its official API (v2) only
// reads a campaign's posts with that creator's own OAuth token, which would
// limit alerts to creators who authorise the bot. So this reads the same JSON
// patreon.com's own creator pages load in a logged-out browser. It's
// undocumented: if Patreon changes it, polling logs an error and nothing
// posts, the same failure mode as YouTube's /live check in lib/youtube.js.
// See ProjectContext.md § 1.
//
// NOTHING BEHIND THE PAYWALL (#112). Three things keep it that way, and all
// three must stay:
//   1. Every request is anonymous: no cookie, session or token is ever sent,
//      so Patreon itself only returns what a logged-out visitor can see.
//   2. The post body (`content`) is never requested — only the fields in
//      POST_FIELDS, so even a public post's full text isn't fetched.
//   3. mapPost() uses only the title, teaser text and the preview image
//      Patreon shows logged-out visitors on a locked post (its blurred
//      thumbnail), and links to the post's public page.
//
// The address is fixed here, never typed by a user, so it doesn't need
// lib/safeFetch.js (WorkingAgreements.md § 6). A creator's name is only ever
// sent as an encoded query value, and checked against VANITY_PATTERN first.

const API_URL = 'https://www.patreon.com/api';
const SITE_URL = 'https://www.patreon.com';

// Identifies the bot honestly rather than posing as a browser.
const USER_AGENT = 'PariahBot (self-hosted Discord bot)';
const REQUEST_TIMEOUT_MS = 15 * 1000;

// Posts polled per creator. A poll every 10 minutes (see
// lib/patreonAlerts.js) would need a creator to post more than this in that
// window to miss one.
const POSTS_PER_CREATOR = 10;

// Sparse fieldsets: only what an alert shows. `content` is deliberately
// absent — see point 2 above.
const POST_FIELDS = 'title,teaser_text,url,published_at,current_user_can_view,image,thumbnail';
const CAMPAIGN_FIELDS = 'name,vanity,url,avatar_photo_url,is_nsfw';

// The name in a creator's patreon.com/<name> link.
const VANITY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// First path segments of patreon.com links that aren't a creator's page.
// "c" and "cw" are prefixes Patreon puts in front of a creator's name, and
// are handled before this is checked.
const NON_CREATOR_PATHS = new Set([
	'posts', 'user', 'login', 'signup', 'home', 'explore', 'search', 'messages',
	'settings', 'api', 'join', 'checkout', 'notifications', 'membership', 'collection',
]);

const MAX_TEASER_LENGTH = 1000;

// Accepts what people actually paste: a patreon.com/<name> link (with or
// without Patreon's /c/ or /cw/ prefix), or a bare name. Returns the name, or
// null.
function parseVanity(raw) {
	let value = raw.trim();

	const url = value.match(/^(?:https?:\/\/)?(?:www\.)?patreon\.com\/(?:(?:c|cw)\/)?([^/?#]+)/i);
	if (url) {
		// A pasted post link names the post, not the creator.
		if (NON_CREATOR_PATHS.has(url[1].toLowerCase())) return null;
		value = url[1];
	}

	value = value.replace(/^@/, '');
	return VANITY_PATTERN.test(value) ? value : null;
}

async function request(path, params) {
	// No credentials of any kind: this is what keeps every response to the
	// logged-out view (point 1 above). Node's fetch sends no cookies.
	const response = await fetch(`${API_URL}/${path}?${params}`, {
		headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.api+json' },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (response.status === 404) return null;
	if (response.status === 429) {
		throw new Error('Patreon is rate-limiting this bot — alerts will catch up once the limit resets.');
	}
	if (!response.ok) {
		throw new Error(`Patreon request failed (HTTP ${response.status}). If this keeps happening, Patreon may have changed the page data the bot reads — see the wiki's Patreon Alerts page.`);
	}
	const body = await response.json().catch(() => null);
	if (!body || !Array.isArray(body.data)) {
		throw new Error("Patreon sent something the bot didn't expect — it may have changed the page data the bot reads. See the wiki's Patreon Alerts page.");
	}
	return body;
}

function mapCampaign(resource) {
	if (!resource) return null;
	const attributes = resource.attributes ?? {};
	const vanity = attributes.vanity ?? null;
	return {
		id: resource.id,
		name: attributes.name || vanity || `Creator ${resource.id}`,
		vanity,
		url: attributes.url || (vanity ? `${SITE_URL}/${vanity}` : `${SITE_URL}/`),
		avatarUrl: attributes.avatar_photo_url ?? null,
		isNsfw: attributes.is_nsfw === true,
	};
}

// Teaser text is meant to be plain, but is stripped of tags anyway so a stray
// bit of markup never reaches the embed.
function cleanText(text) {
	if (!text) return '';
	const cleaned = text.replace(/<[^>]*>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
	return cleaned.length > MAX_TEASER_LENGTH ? cleaned.slice(0, MAX_TEASER_LENGTH) : cleaned;
}

// Only a patreon.com post page is ever linked: that's the page a logged-out
// visitor can open, showing the same preview. Anything else falls back to the
// canonical /posts/<id> address.
function publicPostUrl(url, id) {
	if (typeof url === 'string') {
		try {
			const parsed = new URL(url, SITE_URL);
			if (parsed.protocol === 'https:' && parsed.hostname === 'www.patreon.com' && parsed.pathname.includes('/posts/')) {
				return `${parsed.origin}${parsed.pathname}`;
			}
		} catch {
			// fall through
		}
	}
	return `${SITE_URL}/posts/${id}`;
}

// The preview image a logged-out visitor sees. A public post shows its own
// image. A locked post shows only its thumbnail, in the form Patreon serves
// for locked posts (default_blurred) — never the post's full image, even if
// Patreon were to include one.
function previewImage(attributes, isPublic) {
	if (isPublic) return attributes.image?.large_url ?? attributes.image?.url ?? null;
	return attributes.thumbnail?.default_blurred ?? null;
}

function mapPost(item) {
	const attributes = item.attributes ?? {};
	const publishedAt = Date.parse(attributes.published_at ?? '');
	if (!item.id || Number.isNaN(publishedAt)) return null;

	// The request is anonymous, so "the current user can view" means anyone
	// can: a public post. Anything else is treated as locked.
	const isPublic = attributes.current_user_can_view === true;
	return {
		id: String(item.id),
		title: attributes.title?.trim() || 'New post',
		teaser: cleanText(attributes.teaser_text),
		imageUrl: previewImage(attributes, isPublic),
		isPublic,
		url: publicPostUrl(attributes.url, item.id),
		publishedAt: new Date(publishedAt).toISOString(),
	};
}

// Returns the creator for a patreon.com/<name>, or null when there's none.
async function getCampaign(vanity) {
	if (!VANITY_PATTERN.test(vanity)) return null;
	const params = new URLSearchParams({ 'filter[vanity]': vanity, 'fields[campaign]': CAMPAIGN_FIELDS });
	const body = await request('campaigns', params);
	return mapCampaign(body?.data[0]);
}

// Returns { campaign, posts } for a creator, newest post first, or null when
// the creator no longer exists. Only published posts, and only the public
// preview of each — see the top of this file.
async function getRecentPosts(campaignId) {
	if (!/^\d+$/.test(campaignId)) return null;
	const params = new URLSearchParams({
		'filter[campaign_id]': campaignId,
		'filter[is_draft]': 'false',
		sort: '-published_at',
		'page[count]': String(POSTS_PER_CREATOR),
		'json-api-use-default-includes': 'false',
		include: 'campaign',
		'fields[post]': POST_FIELDS,
		'fields[campaign]': CAMPAIGN_FIELDS,
	});
	const body = await request('posts', params);
	if (!body) return null;

	const campaign = mapCampaign((body.included ?? []).find((resource) => resource.type === 'campaign' && resource.id === campaignId));
	return {
		campaign,
		posts: body.data.filter((item) => item.type === 'post').map(mapPost).filter(Boolean),
	};
}

// Turns what an admin typed into a followable creator, or throws a message
// they can act on. Shared by /patreon add and the admin dashboard.
async function resolveCreator(raw) {
	const vanity = parseVanity(raw);
	if (!vanity) {
		throw new Error(`"${raw}" doesn't look like a Patreon creator — use their patreon.com/<name> link, or just the name from it.`);
	}
	const campaign = await getCampaign(vanity);
	if (!campaign) {
		throw new Error(`Couldn't find patreon.com/${vanity}. Check the spelling against the creator's Patreon page address.`);
	}
	return campaign;
}

module.exports = {
	POST_FIELDS,
	parseVanity,
	mapPost,
	mapCampaign,
	getCampaign,
	getRecentPosts,
	resolveCreator,
};
