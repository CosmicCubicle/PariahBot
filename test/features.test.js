const test = require('node:test');
const assert = require('node:assert');

const { useTempDb } = require('./helpers/tempDb');

useTempDb('features');

const features = require('../lib/features');
const store = require('../state/featureToggles');

const GUILD = 'guild-a';
const OTHER = 'guild-b';

test('every feature defaults to on, except banned words', () => {
	// A default of off would have silently disabled every feature in every
	// existing server the moment #69 shipped. Banned words keeps its original
	// opt-in default because switching it on creates real AutoMod rules.
	for (const key of features.FEATURE_KEYS) {
		const expected = key !== 'bannedWords';
		assert.equal(features.isEnabled('untouched-guild', key), expected, `${key} default`);
	}
	assert.equal(features.isEnabled('untouched-guild', 'bannedWords'), false);
});

test('an absent row means the default, not off', () => {
	// The distinction the whole design rests on: nothing stored is "use the
	// default", which is what lets a new feature ship without a backfill.
	assert.equal(store.getEnabled(GUILD, 'autoDelete'), null);
	assert.equal(features.isEnabled(GUILD, 'autoDelete'), true);
});

test('switching a feature off and on again is stored explicitly', () => {
	features.setEnabled(GUILD, 'autoDelete', false);
	assert.equal(features.isEnabled(GUILD, 'autoDelete'), false);
	assert.equal(store.getEnabled(GUILD, 'autoDelete'), false);

	features.setEnabled(GUILD, 'autoDelete', true);
	assert.equal(features.isEnabled(GUILD, 'autoDelete'), true);
});

test('switching a default-off feature on works the same way', () => {
	features.setEnabled(GUILD, 'bannedWords', true);
	assert.equal(features.isEnabled(GUILD, 'bannedWords'), true);
});

test('reset drops back to the default rather than storing it', () => {
	features.setEnabled(GUILD, 'leveling', false);
	assert.equal(features.isEnabled(GUILD, 'leveling'), false);

	assert.equal(features.reset(GUILD, 'leveling'), true);
	// Stored as nothing, so a later change to the default would be followed.
	assert.equal(store.getEnabled(GUILD, 'leveling'), null);
	assert.equal(features.isEnabled(GUILD, 'leveling'), true);
});

test('switches do not leak between guilds', () => {
	features.setEnabled(GUILD, 'giveaways', false);
	assert.equal(features.isEnabled(GUILD, 'giveaways'), false);
	assert.equal(features.isEnabled(OTHER, 'giveaways'), true, "another guild keeps the default");
});

test('an unknown feature reads as enabled, and cannot be set', () => {
	// Fails open on read: a typo in a gate must never silently switch a working
	// feature off for every server. Fails closed on write, where a typo would
	// otherwise store a row nothing ever reads.
	assert.equal(features.isEnabled(GUILD, 'notAFeature'), true);
	assert.throws(() => features.setEnabled(GUILD, 'notAFeature', false), /Unknown feature/);
});

test('list returns every feature with its state and whether it is a default', () => {
	features.setEnabled(GUILD, 'rss', false);
	const list = features.list(GUILD);

	assert.equal(list.length, features.FEATURE_KEYS.length);

	const rss = list.find((item) => item.key === 'rss');
	assert.equal(rss.enabled, false);
	assert.equal(rss.isDefault, false, 'explicitly set, so not a default');

	const instagram = list.find((item) => item.key === 'instagram');
	assert.equal(instagram.enabled, true);
	assert.equal(instagram.isDefault, true, 'never touched, so still a default');

	// Declaration order, so the reply and the dashboard read consistently.
	assert.deepEqual(list.map((item) => item.key), features.FEATURE_KEYS);
});

test('the disabled message names the command that turns it back on', () => {
	// The slash command stays registered with Discord, so this message is the
	// only thing telling a member why a visible command refuses to run.
	const message = features.disabledMessage('autoDelete');
	assert.match(message, /Message auto-deletion/);
	assert.match(message, /\/setup feature enable feature:autoDelete/);
});

test('listGuildsExplicitlyEnabled is restricted to default-off features', () => {
	features.setEnabled(GUILD, 'bannedWords', true);
	features.setEnabled(OTHER, 'bannedWords', false);

	assert.deepEqual(features.listGuildsExplicitlyEnabled('bannedWords'), [GUILD]);

	// For a default-on feature, "has a row set to 1" is not the same set as
	// "enabled" — every guild with no row at all is also enabled. Guarded
	// rather than silently returning a wrong, short answer.
	assert.throws(() => features.listGuildsExplicitlyEnabled('autoDelete'), /default-off/);
});
