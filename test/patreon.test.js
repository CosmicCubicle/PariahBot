const test = require('node:test');
const assert = require('node:assert');

const { useTempDb } = require('./helpers/tempDb');

useTempDb('patreon');

const patreon = require('../lib/patreon');
const { buildPostMessage } = require('../lib/patreonAlerts');
const patreonStore = require('../state/patreon');

// A locked post as Patreon returns it to a logged-out request. `content` and
// the full image are included here on purpose: Patreon doesn't send them for a
// locked post today, but if it ever did, none of it may reach Discord (#112).
const LOCKED_POST = {
	id: '171702077',
	type: 'post',
	attributes: {
		title: 'EXCLUSIVE PREVIEW: Our Next Video',
		teaser_text: 'A little taste of what is coming.',
		content: '<p>SECRET PATRON-ONLY BODY</p>',
		current_user_can_view: false,
		url: 'https://www.patreon.com/Example/posts/exclusive-171702077?utm_source=x',
		published_at: '2026-11-10T15:06:41.000+00:00',
		image: { large_url: 'https://c10.patreonusercontent.com/full-image.jpg' },
		thumbnail: { default_blurred: 'https://c10.patreonusercontent.com/blurred.jpg' },
	},
};

const PUBLIC_POST = {
	id: '174941180',
	type: 'post',
	attributes: {
		title: 'NEW VIDEO: Something public',
		teaser_text: null,
		current_user_can_view: true,
		url: 'https://www.patreon.com/Example/posts/new-video-174941180',
		published_at: '2026-11-12T10:00:00.000+00:00',
		image: { large_url: 'https://c10.patreonusercontent.com/public.jpg', url: 'https://c10.patreonusercontent.com/public-small.jpg' },
		thumbnail: { default_blurred: 'https://c10.patreonusercontent.com/public-blurred.jpg' },
	},
};

const CAMPAIGN = { id: '73401', name: 'Example', vanity: 'Example', url: 'https://www.patreon.com/Example', avatarUrl: null, isNsfw: false };

test('parseVanity accepts names and patreon.com links, and rejects post links', () => {
	assert.equal(patreon.parseVanity('Kurzgesagt'), 'Kurzgesagt');
	assert.equal(patreon.parseVanity('https://www.patreon.com/Kurzgesagt'), 'Kurzgesagt');
	assert.equal(patreon.parseVanity('patreon.com/cw/Kurzgesagt/posts'), 'Kurzgesagt');
	assert.equal(patreon.parseVanity('https://patreon.com/c/some_creator?ref=x'), 'some_creator');
	assert.equal(patreon.parseVanity('https://www.patreon.com/posts/some-post-123'), null);
	assert.equal(patreon.parseVanity('https://www.patreon.com/user?u=123'), null);
	assert.equal(patreon.parseVanity('not a name'), null);
	assert.equal(patreon.parseVanity('a&filter[x]=y'), null, 'nothing that could add query fields');
});

test('the post body is never requested', () => {
	const fields = patreon.POST_FIELDS.split(',');
	assert.ok(!fields.includes('content'));
	assert.ok(!fields.includes('content_json_string'));
	assert.ok(!fields.includes('post_file'));
});

test('a locked post keeps only its public preview', () => {
	const post = patreon.mapPost(LOCKED_POST);

	assert.equal(post.isPublic, false);
	assert.equal(post.title, 'EXCLUSIVE PREVIEW: Our Next Video');
	assert.equal(post.teaser, 'A little taste of what is coming.');
	assert.equal(post.imageUrl, 'https://c10.patreonusercontent.com/blurred.jpg', 'the blurred thumbnail, never the full image');
	assert.equal(post.url, 'https://www.patreon.com/Example/posts/exclusive-171702077', 'the public post page, without tracking');
	assert.ok(!JSON.stringify(post).includes('SECRET'), 'the body must not be carried along');
});

test('a public post shows its own image', () => {
	const post = patreon.mapPost(PUBLIC_POST);
	assert.equal(post.isPublic, true);
	assert.equal(post.imageUrl, 'https://c10.patreonusercontent.com/public.jpg');
	assert.equal(post.teaser, '');
});

test('anything other than a patreon.com post page is replaced by the canonical link', () => {
	const post = patreon.mapPost({ ...LOCKED_POST, attributes: { ...LOCKED_POST.attributes, url: 'https://evil.example/posts/1' } });
	assert.equal(post.url, 'https://www.patreon.com/posts/171702077');
});

test('a post without a publish date is skipped', () => {
	assert.equal(patreon.mapPost({ id: '1', type: 'post', attributes: { title: 'Draft' } }), null);
});

test('the alert for a locked post says so and holds nothing but the preview', () => {
	const message = buildPostMessage(CAMPAIGN, patreon.mapPost(LOCKED_POST), null, null);
	const embed = message.embeds[0].toJSON();

	assert.equal(embed.url, 'https://www.patreon.com/Example/posts/exclusive-171702077');
	assert.equal(embed.image.url, 'https://c10.patreonusercontent.com/blurred.jpg');
	assert.match(embed.fields[0].value, /Patrons only/);
	assert.ok(!JSON.stringify(message).includes('SECRET'));
	assert.ok(!JSON.stringify(message).includes('full-image'));
	assert.equal(message.components[0].toJSON().components[0].url, embed.url);
});

test('requests are anonymous and only go to patreon.com', async (t) => {
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		calls.push({ url: String(url), headers: options?.headers ?? {} });
		return new Response(JSON.stringify({ data: [LOCKED_POST], included: [{ id: '73401', type: 'campaign', attributes: { name: 'Example', vanity: 'Example' } }] }), { status: 200 });
	});

	const result = await patreon.getRecentPosts('73401');
	assert.equal(result.campaign.name, 'Example');
	assert.equal(result.posts.length, 1);

	const [call] = calls;
	assert.ok(call.url.startsWith('https://www.patreon.com/api/posts?'));
	const headerNames = Object.keys(call.headers).map((name) => name.toLowerCase());
	assert.ok(!headerNames.includes('cookie'));
	assert.ok(!headerNames.includes('authorization'));
	assert.ok(!new URL(call.url).searchParams.get('fields[post]').split(',').includes('content'));
});

test('getRecentPosts refuses a campaign ID that is not a number', async (t) => {
	const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
	assert.equal(await patreon.getRecentPosts('1&include=secret'), null);
	assert.equal(fetchMock.mock.callCount(), 0);
});

test("removeCreator won't remove another guild's creator", () => {
	patreonStore.addCreator('guild-a', '73401', 'Example', 'Example');

	assert.equal(patreonStore.removeCreator('guild-b', '73401'), false);
	assert.equal(patreonStore.removeCreator('guild-b', 'example'), false);
	assert.equal(patreonStore.listCreatorsForGuild('guild-a').length, 1);

	assert.equal(patreonStore.removeCreator('guild-a', 'example'), true, 'by name, ignoring case');
	assert.equal(patreonStore.listCreatorsForGuild('guild-a').length, 0);
});

test('re-adding a creator keeps when it was first added', () => {
	patreonStore.addCreator('guild-a', '114875', 'PhilosophyTube', 'Philosophy Tube');
	const first = patreonStore.getCreator('guild-a', '114875').addedAt;
	patreonStore.addCreator('guild-a', '114875', 'PhilosophyTube', 'Philosophy Tube (renamed)');

	const again = patreonStore.getCreator('guild-a', '114875');
	assert.equal(again.addedAt, first);
	assert.equal(again.name, 'Philosophy Tube (renamed)');
});
