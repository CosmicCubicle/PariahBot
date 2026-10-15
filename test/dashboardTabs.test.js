const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// dashboard/app.js is a browser script, not a module: it has no exports, and it
// calls start() on load. Rather than leave the tab rules untested — they decide
// what an admin can even reach — the source is evaluated in a context with just
// enough stubbed out, with that final call removed.
//
// This deliberately tests the rules only (which tabs show, and the fallback),
// not rendering. Anything touching the DOM needs a real browser.
function loadApp() {
	// Top-level `const` in a script stays lexically scoped — it never becomes a
	// property of the context — so what the test needs is handed out explicitly.
	const source = `${fs.readFileSync(path.resolve(__dirname, '..', 'dashboard', 'app.js'), 'utf8')
		.replace(/\r?\nstart\(\);\s*$/, '\n')}
		globalThis.__test = { state, visibleTabs, featureOn, ifFeature, TABS, buildInviteUrl };`;

	const context = {
		document: { getElementById: () => null, createElement: () => ({ append() {}, setAttribute() {}, addEventListener() {} }) },
		window: { confirm: () => true, location: { href: '' } },
		fetch: async () => ({ ok: true, json: async () => ({}) }),
		setTimeout,
		clearTimeout,
		console,
		// Browser globals the page uses that a bare vm context doesn't provide.
		URL,
		URLSearchParams,
	};
	vm.createContext(context);
	vm.runInContext(source, context);
	return context.__test;
}

// Every feature on unless named, matching lib/features.js's own defaults.
function withFeaturesOff(app, ...offKeys) {
	const keys = [
		'tempVoice', 'roleMenus', 'autoDelete', 'captcha', 'honeypot', 'leveling',
		'giveaways', 'bannedWords', 'moderation', 'streamers', 'rss', 'instagram', 'logging',
	];
	app.state.guild = {
		features: keys.map((key) => ({ key, label: key, commands: [], enabled: !offKeys.includes(key), isDefault: false })),
	};
}

test('General and Features are always shown, even with everything off', () => {
	const app = loadApp();
	withFeaturesOff(app, 'tempVoice', 'roleMenus', 'autoDelete', 'captcha', 'honeypot',
		'leveling', 'giveaways', 'bannedWords', 'moderation', 'streamers', 'rss', 'instagram', 'logging');

	const keys = app.visibleTabs().map(([key]) => key);
	// Features has to survive switching everything off, or there would be no way
	// back — it is the only page that can switch anything on again.
	assert.deepEqual(keys, ['general', 'features']);
});

test('all tabs are shown when nothing is switched off', () => {
	const app = loadApp();
	withFeaturesOff(app);

	const keys = app.visibleTabs().map(([key]) => key);
	assert.deepEqual(keys, ['general', 'features', 'bannedWords', 'alerts', 'autoDelete', 'moderation', 'logging', 'voice', 'other']);
});

test("a single feature's tab disappears with it", () => {
	const app = loadApp();
	withFeaturesOff(app, 'moderation', 'tempVoice', 'logging');

	const keys = app.visibleTabs().map(([key]) => key);
	assert.ok(!keys.includes('moderation'));
	assert.ok(!keys.includes('voice'));
	assert.ok(!keys.includes('logging'));
	assert.ok(keys.includes('autoDelete'), 'unrelated tabs stay');
});

test('a shared tab survives while any of its features is on', () => {
	const app = loadApp();

	// The alerts tab holds streamers, Instagram and RSS. Hiding it when one is
	// off would take the other two with it.
	withFeaturesOff(app, 'streamers', 'instagram');
	assert.ok(app.visibleTabs().map(([key]) => key).includes('alerts'), 'RSS is still on');

	withFeaturesOff(app, 'streamers', 'instagram', 'rss');
	assert.ok(!app.visibleTabs().map(([key]) => key).includes('alerts'), 'all three off, so the tab goes');
});

test('the Giveaways & more tab needs all four of its features off to disappear', () => {
	const app = loadApp();

	withFeaturesOff(app, 'giveaways', 'captcha', 'honeypot');
	assert.ok(app.visibleTabs().map(([key]) => key).includes('other'), 'leveling is still on');

	withFeaturesOff(app, 'giveaways', 'captcha', 'honeypot', 'leveling');
	assert.ok(!app.visibleTabs().map(([key]) => key).includes('other'));
});

test('featureOn defaults to true when the server snapshot has no feature list', () => {
	const app = loadApp();
	// An older cached snapshot, or a response from before the field existed:
	// failing open keeps the dashboard usable instead of hiding every tab.
	app.state.guild = {};
	assert.equal(app.featureOn('moderation'), true);

	app.state.guild = null;
	assert.equal(app.featureOn('moderation'), true);
});

test('ifFeature hides a card group but keeps it for an enabled feature', () => {
	const app = loadApp();
	withFeaturesOff(app, 'rss');

	assert.equal(app.ifFeature('rss', 'card-a', 'card-b'), null);
	assert.deepEqual(app.ifFeature('streamers', 'card-a', 'card-b'), ['card-a', 'card-b']);
});

// --- Invite builder (#91) ------------------------------------------------------

const invitePermissions = require('../lib/invitePermissions');

test('the page builds the same invite URL as the server would', () => {
	// The page rebuilds the link locally as boxes are ticked, instead of asking
	// the server each time. That means two builders, and two builders drift —
	// so they are compared directly, for the minimum and for every feature.
	const app = loadApp();
	const clientId = '123456789012345678';

	for (const keys of [[], ['moderation'], ['tempVoice', 'captcha'], invitePermissions.FEATURE_KEYS]) {
		const expected = invitePermissions.inviteUrl(clientId, keys);
		const actual = app.buildInviteUrl(clientId, invitePermissions.bitsFor(keys));
		assert.equal(actual, expected, `differed for [${keys.join(', ')}]`);
	}
});

test('the page combines permission bits without losing the high ones', () => {
	// The page gets bitfields as strings and ORs them with BigInt. Doing it with
	// Number would drop Timeout Members (bit 40) and hand out an invite missing
	// exactly what moderation needs.
	const app = loadApp();
	const base = BigInt(invitePermissions.bitsFor([]).toString());
	const mod = BigInt(invitePermissions.bitsFor(['moderation']).toString());

	const url = app.buildInviteUrl('1', base | mod);
	const granted = BigInt(new URL(url).searchParams.get('permissions'));

	assert.equal(granted, invitePermissions.bitsFor(['moderation']));
	assert.ok(granted > 2n ** 32n);
});
