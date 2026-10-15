const test = require('node:test');
const assert = require('node:assert');

const { PermissionFlagsBits } = require('discord.js');
const invite = require('../lib/invitePermissions');
const features = require('../lib/features');

test('every switchable feature has invite permissions', () => {
	// The drift guard. lib/features.js and lib/invitePermissions.js are separate
	// on purpose but share their keys: a feature added to one and not the other
	// means an invite that silently omits what that feature needs.
	const missing = features.FEATURE_KEYS.filter((key) => !Object.hasOwn(invite.FEATURE_PERMISSIONS, key));
	assert.deepEqual(missing, [], 'add these to lib/invitePermissions.js');
});

test('any extra entries are declared as always-on features', () => {
	// The other direction: the invite map legitimately covers features with no
	// switch (/setup, /alerts), and nothing else.
	const switchable = new Set(features.FEATURE_KEYS);
	const extra = invite.FEATURE_KEYS.filter((key) => !switchable.has(key));
	assert.deepEqual(extra.sort(), [...invite.ALWAYS_ON].sort(),
		'an entry that is neither switchable nor listed in ALWAYS_ON is unexplained');
});

test('the minimum invite grants only what the bot needs to reply', () => {
	assert.deepEqual(invite.permissionNames([]), ['Embed Links', 'Read Message History', 'Send Messages', 'View Channel']);
});

test('ticking a feature adds exactly its permissions, on top of the base', () => {
	const base = invite.bitsFor([]);
	const withMod = invite.bitsFor(['moderation']);

	// Base is always included, never traded away for a feature's own set.
	assert.equal(withMod & base, base);
	for (const flag of [PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers, PermissionFlagsBits.ModerateMembers]) {
		assert.equal((withMod & flag) === flag, true);
	}
	// And nothing it didn't ask for.
	assert.equal((withMod & PermissionFlagsBits.ManageGuild) === PermissionFlagsBits.ManageGuild, false);
});

test('overlapping features do not double-count', () => {
	// Several features want Manage Roles; the bitfield is a set, so asking for
	// all of them is the same as asking once.
	const once = invite.bitsFor(['roleMenus']);
	const thrice = invite.bitsFor(['roleMenus', 'captcha', 'honeypot']);
	assert.equal(once & PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageRoles);
	assert.equal(thrice & PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageRoles);
});

test('no feature asks for Administrator', () => {
	// Scaling permissions to features is the point of #91; Administrator would
	// make every checkbox meaningless.
	const all = invite.bitsFor(invite.FEATURE_KEYS);
	assert.equal((all & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator, false);
});

test('no feature asks for Mention Everyone', () => {
	// Deliberate: the wiki offers "Mention Everyone, or a mentionable ping
	// role", and the second costs nothing. If this ever starts failing, the
	// note on streamers/rss/instagram is wrong too.
	const all = invite.bitsFor(invite.FEATURE_KEYS);
	assert.equal((all & PermissionFlagsBits.MentionEveryone) === PermissionFlagsBits.MentionEveryone, false);
});

test('the bitfield is computed as BigInt, not a lossy Number', () => {
	// Timeout Members is bit 40, so any set including moderation is past 2^32 —
	// a 32-bit bitwise OR in JavaScript would silently drop it, and the invite
	// would come out missing exactly the permission the feature exists for.
	const all = invite.bitsFor(invite.FEATURE_KEYS);
	assert.equal(typeof all, 'bigint');
	assert.ok(all > 2n ** 32n, 'the full set must exceed what a 32-bit OR can hold');
	assert.equal((all & PermissionFlagsBits.ModerateMembers) === PermissionFlagsBits.ModerateMembers, true);
});

test('the invite URL carries the bot, its commands, and the permissions', () => {
	const url = new URL(invite.inviteUrl('123456789012345678', ['moderation']));

	assert.equal(url.origin + url.pathname, 'https://discord.com/oauth2/authorize');
	assert.equal(url.searchParams.get('client_id'), '123456789012345678');
	// Without applications.commands the bot joins with no slash commands, which
	// looks broken rather than limited.
	assert.equal(url.searchParams.get('scope'), 'bot applications.commands');
	assert.equal(url.searchParams.get('permissions'), invite.bitsFor(['moderation']).toString());
});

test('a missing CLIENT_ID is refused rather than producing a broken link', () => {
	assert.throws(() => invite.inviteUrl('', ['moderation']), /CLIENT_ID/);
	assert.throws(() => invite.inviteUrl(undefined), /CLIENT_ID/);
});

test('the catalogue describes every feature for the page', () => {
	const list = invite.catalogue();
	assert.equal(list.length, invite.FEATURE_KEYS.length);

	const setup = list.find((entry) => entry.key === 'setup');
	assert.equal(setup.alwaysOn, true);
	assert.deepEqual(setup.permissions, ['Manage Roles']);

	const tempVoice = list.find((entry) => entry.key === 'tempVoice');
	assert.equal(tempVoice.alwaysOn, false);
	assert.ok(tempVoice.permissions.includes('Move Members'));
});

// --- The two numbers the wiki publishes ----------------------------------------

test('the Required preset equals the number on the wiki Bot Setup page', () => {
	// The wiki hands people a literal invite URL with this number in it. If the
	// map here changes and that number doesn't, self-hosters get an invite that
	// is missing a permission, and the failure shows up much later as a feature
	// that silently doesn't work. Pinned so the wiki has to be updated with it.
	assert.equal(invite.bitsFor(invite.FEATURE_KEYS).toString(), '1099797982390');
});

test('the Recommended preset equals the other number on that page', () => {
	assert.equal(invite.bitsFor(invite.FEATURE_KEYS, { extras: true }).toString(), '7672240169807095');
});

test('Recommended is Required plus conveniences, never less', () => {
	const required = invite.bitsFor(invite.FEATURE_KEYS);
	const recommended = invite.bitsFor(invite.FEATURE_KEYS, { extras: true });

	assert.equal(recommended & required, required, 'Recommended must be a superset');
	assert.ok(recommended > required);
	// The conveniences are opt-in: no feature quietly depends on one.
	for (const flag of invite.RECOMMENDED_EXTRAS) {
		assert.equal((required & flag) === flag, false, 'a convenience leaked into a feature');
	}
});

test('the three presets are ordered and distinct', () => {
	const { minimum, required, recommended } = invite.PRESETS;
	const bits = (preset) => invite.bitsFor(preset.features, { extras: preset.extras });

	assert.ok(bits(minimum) < bits(required));
	assert.ok(bits(required) < bits(recommended));
});

test('Mention Everyone is only ever granted by the Recommended preset', () => {
	// It is one of the conveniences, so it must not appear below Recommended —
	// this is the pairing for the note on streamers, rss and instagram.
	const { MentionEveryone } = PermissionFlagsBits;
	assert.equal((invite.bitsFor(invite.FEATURE_KEYS) & MentionEveryone) === MentionEveryone, false);
	assert.equal((invite.bitsFor(invite.FEATURE_KEYS, { extras: true }) & MentionEveryone) === MentionEveryone, true);
});
