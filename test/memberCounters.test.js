const test = require('node:test');
const assert = require('node:assert');

const { useTempDb } = require('./helpers/tempDb');

useTempDb('member-counters');

const { ChannelType } = require('discord.js');
const counters = require('../lib/memberCounters');
const store = require('../state/memberCounters');
const features = require('../lib/features');
const { gatewayIntents, presenceEnabled } = require('../lib/intents');

const GUILD = 'guild-a';
const OTHER = 'guild-b';

// Enough guild for the count functions: a member cache with bot/presence
// flags, a role cache, and a channel cache.
function mockGuild(id, { humans = 0, bots = 0, online = 0, roles = 0, channels = 0, roleMembers = null } = {}) {
	const members = [];
	for (let i = 0; i < humans; i += 1) {
		members.push({ user: { bot: false }, presence: i < online ? { status: 'online' } : null });
	}
	for (let i = 0; i < bots; i += 1) members.push({ user: { bot: true }, presence: null });

	const roleCache = new Map([['everyone', { id: 'everyone' }]]);
	for (let i = 0; i < roles; i += 1) roleCache.set(`r${i}`, { id: `r${i}` });
	if (roleMembers !== null) roleCache.set('counted', { id: 'counted', members: { size: roleMembers } });

	const channelCache = new Map();
	for (let i = 0; i < channels; i += 1) channelCache.set(`c${i}`, { id: `c${i}`, type: ChannelType.GuildText });
	channelCache.set('cat', { id: 'cat', type: ChannelType.GuildCategory });

	return {
		id,
		memberCount: humans + bots,
		members: { cache: { filter: (fn) => ({ size: members.filter(fn).length }) } },
		roles: { cache: roleCache },
		channels: { cache: { filter: (fn) => ({ size: [...channelCache.values()].filter(fn).length }), size: channelCache.size } },
	};
}

test('each counter type counts what its label says', () => {
	const guild = mockGuild(GUILD, { humans: 10, bots: 3, roles: 4, channels: 5 });

	assert.equal(counters.countFor(guild, { type: 'members' }), 13, 'people and bots');
	assert.equal(counters.countFor(guild, { type: 'users' }), 10, 'humans only');
	assert.equal(counters.countFor(guild, { type: 'bots' }), 3);
	// @everyone is a role in the API but not one anyone means.
	assert.equal(counters.countFor(guild, { type: 'roles' }), 4);
	// Categories are containers, not channels people use.
	assert.equal(counters.countFor(guild, { type: 'channels' }), 5);
});

test('a role counter counts that role, and reports nothing when the role is gone', () => {
	const guild = mockGuild(GUILD, { humans: 10, roleMembers: 7 });

	assert.equal(counters.countFor(guild, { type: 'role', roleId: 'counted' }), 7);
	// Deleted role: null, not 0 — writing "0" into the channel name would be a
	// confident lie about a role that no longer exists.
	assert.equal(counters.countFor(guild, { type: 'role', roleId: 'deleted' }), null);
});

test('presence counters are unavailable unless the host opted in', () => {
	const guild = mockGuild(GUILD, { humans: 10, online: 4 });

	// MEMBER_COUNT_PRESENCE is unset in this process.
	assert.equal(presenceEnabled(), false);
	assert.equal(counters.countFor(guild, { type: 'online' }), null);
	assert.equal(counters.countFor(guild, { type: 'offline' }), null);

	assert.throws(() => counters.requireAvailableType('online'), /Presence intent/);
	assert.throws(() => counters.requireAvailableType('offline'), /MEMBER_COUNT_PRESENCE/);
});

test('the presence intent is requested only when the flag is set', () => {
	// The whole point of gating it: adding a privileged intent unconditionally
	// would refuse the login on every existing install until that host also
	// switched it on, which is what #81 did with Server Members.
	const names = (env) => gatewayIntents(env).map(String);
	const off = names({});
	const on = names({ MEMBER_COUNT_PRESENCE: 'true' });

	assert.equal(on.length, off.length + 1);
	assert.ok(off.every((bit) => on.includes(bit)), 'the flag only adds');
});

test('the name template puts the number where {count} is, with thousands separators', () => {
	assert.equal(counters.renderName('Members: {count}', 1204), 'Members: 1,204');
	assert.equal(counters.renderName('{count} humans', 42), '42 humans');
	assert.equal(counters.renderName('👥 | {count}', 7), '👥 | 7');
	// Used more than once, because nothing stops an admin doing that.
	assert.equal(counters.renderName('{count}/{count}', 5), '5/5');
});

test('a template with no placeholder still shows the number', () => {
	// The command layer refuses this, but a row could predate that check, and a
	// channel named with no number at all would be silently useless.
	assert.equal(counters.renderName('Members', 12), 'Members 12');
});

test('the rendered name is cut to Discord channel-name length', () => {
	const name = counters.renderName(`${'x'.repeat(120)}{count}`, 1);
	assert.equal(name.length, counters.MAX_NAME_LENGTH);
});

test('counters are stored per guild and do not leak', () => {
	store.addCounter({ channelId: 'chan-a', guildId: GUILD, type: 'members', nameTemplate: 'M: {count}' });
	store.addCounter({ channelId: 'chan-b', guildId: OTHER, type: 'members', nameTemplate: 'M: {count}' });

	assert.deepEqual(store.listForGuild(GUILD).map((c) => c.channelId), ['chan-a']);
	// A channel id typed by hand could belong to another guild the bot is in.
	assert.equal(store.removeCounter('chan-a', OTHER), false, 'wrong guild must not remove it');
	assert.equal(store.setTemplate('chan-a', OTHER, 'hijacked'), false);
	assert.equal(store.getCounter('chan-a').nameTemplate, 'M: {count}');

	assert.equal(store.removeCounter('chan-a', GUILD), true);
});

test('one counter per thing, but one per role', () => {
	store.addCounter({ channelId: 'c-users', guildId: GUILD, type: 'users', nameTemplate: '{count}' });
	assert.equal(store.hasCounter(GUILD, 'users'), true);
	assert.equal(store.hasCounter(OTHER, 'users'), false, 'per guild');

	store.addCounter({ channelId: 'c-role1', guildId: GUILD, type: 'role', roleId: 'r1', nameTemplate: '{count}' });
	assert.equal(store.hasCounter(GUILD, 'role', 'r1'), true);
	// A second role counter is the point of the type, so a different role is free.
	assert.equal(store.hasCounter(GUILD, 'role', 'r2'), false);
});

test('a deleted channel is forgotten rather than retried forever', async () => {
	store.addCounter({ channelId: 'gone', guildId: GUILD, type: 'members', nameTemplate: 'M: {count}' });

	const client = { guilds: { cache: new Map([[GUILD, { ...mockGuild(GUILD, { humans: 3 }), channels: { cache: new Map() } }]]) } };
	const result = await counters.refreshCounter(client, store.getCounter('gone'));

	assert.equal(result.skipped, 'channel-deleted');
	assert.equal(result.forgotten, true);
	assert.equal(store.getCounter('gone'), null, 'the row is the only thing pointing at it');
});

test('a switched-off feature keeps its counters but stops renaming them', async () => {
	store.addCounter({ channelId: 'c-off', guildId: GUILD, type: 'members', nameTemplate: 'M: {count}' });
	features.setEnabled(GUILD, 'memberCount', false);

	let renamed = false;
	const guild = mockGuild(GUILD, { humans: 5 });
	guild.channels.cache = new Map([['c-off', { name: 'old', async setName() { renamed = true; } }]]);
	const client = { guilds: { cache: new Map([[GUILD, guild]]) } };

	const result = await counters.refreshCounter(client, store.getCounter('c-off'));

	assert.equal(result.skipped, 'feature-off');
	assert.equal(renamed, false);
	assert.ok(store.getCounter('c-off'), 'the counter is kept, so switching it back on restores it');

	features.reset(GUILD, 'memberCount');
});

test('an unchanged name is not rewritten', async () => {
	// Every rename spends one of Discord's two-per-ten-minutes per channel, so
	// writing the same name again would waste the budget for no change.
	store.addCounter({ channelId: 'c-same', guildId: GUILD, type: 'members', nameTemplate: 'M: {count}' });

	let renames = 0;
	const guild = mockGuild(GUILD, { humans: 4 });
	guild.channels.cache = new Map([['c-same', { name: 'M: 4', async setName() { renames += 1; } }]]);
	const client = { guilds: { cache: new Map([[GUILD, guild]]) } };

	assert.equal((await counters.refreshCounter(client, store.getCounter('c-same'))).skipped, 'unchanged');
	assert.equal(renames, 0);
});

test('the refresh interval stays inside Discord rate limits', () => {
	// Discord allows about 2 renames per 10 minutes per channel. The reference
	// bot (membercount.net) settled on 20 minutes after being forced off
	// instant updates; going below 10 would throttle and silently stop.
	assert.ok(counters.REFRESH_INTERVAL_MS >= 10 * 60 * 1000, 'below the rate limit window');
	assert.equal(counters.REFRESH_INTERVAL_MS, 20 * 60 * 1000);
});

test('every counter type is declared with a label and a default template', () => {
	for (const key of counters.COUNTER_TYPE_KEYS) {
		const spec = counters.COUNTER_TYPES[key];
		assert.ok(spec.label, `${key} needs a label`);
		assert.ok(spec.defaultTemplate.includes('{count}'), `${key}'s default template needs {count}`);
		assert.equal(typeof spec.count, 'function');
	}
});

// --- The member cache (#105) ---------------------------------------------------

// The mocks above hand `filter` a populated array, which is why they passed
// while Humans reported 2 in a real server. This models the real object: the
// cache starts with only the members the bot happens to have seen, and is
// filled by fetch(). A test that can't express an empty cache can't catch this.
function mockCacheGuild(id, { seen = 1, actual = 50, bots = 2, fetchFails = false } = {}) {
	const guild = {
		id,
		memberCount: actual + bots,
		fetches: [],
		renames: [],
		roles: { cache: new Map([['everyone', { id: 'everyone' }]]) },
		channels: { cache: new Map() },
	};

	let loaded = seen;
	const asArray = () => {
		const members = [];
		for (let i = 0; i < Math.min(loaded, actual); i += 1) members.push({ user: { bot: false }, presence: null });
		if (loaded > actual) for (let i = 0; i < bots; i += 1) members.push({ user: { bot: true }, presence: null });
		return members;
	};

	guild.members = {
		cache: { filter: (fn) => ({ size: asArray().filter(fn).length }) },
		async fetch(options) {
			guild.fetches.push(options);
			if (fetchFails) throw new Error('Members did not arrive within 120 seconds.');
			loaded = actual + bots;
			return guild.members.cache;
		},
	};
	return guild;
}

function counterChannel(guild, channelId) {
	guild.channels.cache.set(channelId, {
		name: 'placeholder',
		async setName(name) { guild.renames.push(name); this.name = name; },
	});
}

test('a sweep fills the member cache before counting humans', async () => {
	const guild = mockCacheGuild('g-cache', { seen: 2, actual: 50, bots: 3 });
	counterChannel(guild, 'c-humans');
	store.addCounter({ channelId: 'c-humans', guildId: 'g-cache', type: 'users', nameTemplate: 'Humans: {count}' });

	await counters.refreshAll({ guilds: { cache: new Map([['g-cache', guild]]) } });

	assert.equal(guild.fetches.length, 1, 'the cache has to be fetched, not assumed');
	// The bug: without the fetch this was 'Humans: 2'.
	assert.deepEqual(guild.renames, ['Humans: 50']);
});

test('the cache is fetched once per guild, not once per counter', async () => {
	const guild = mockCacheGuild('g-many', { seen: 1, actual: 40, bots: 4 });
	for (const [id, type] of [['c1', 'users'], ['c2', 'bots'], ['c3', 'members']]) {
		counterChannel(guild, id);
		store.addCounter({ channelId: id, guildId: 'g-many', type, nameTemplate: '{count}' });
	}

	await counters.refreshAll({ guilds: { cache: new Map([['g-many', guild]]) } });

	assert.equal(guild.fetches.length, 1, 'three counters, one fetch');
	assert.deepEqual(guild.renames.sort(), ['4', '40', '44'], 'bots, humans, and total');
});

test('a guild with no cache-reading counters is never fetched', async () => {
	// members/roles/channels all come from data Discord already sent, so a
	// server using only those should cost no extra API call.
	const guild = mockCacheGuild('g-cheap', { seen: 1, actual: 30, bots: 2 });
	counterChannel(guild, 'c-total');
	counterChannel(guild, 'c-roles');
	store.addCounter({ channelId: 'c-total', guildId: 'g-cheap', type: 'members', nameTemplate: '{count}' });
	store.addCounter({ channelId: 'c-roles', guildId: 'g-cheap', type: 'roles', nameTemplate: 'R{count}' });

	await counters.refreshAll({ guilds: { cache: new Map([['g-cheap', guild]]) } });

	assert.deepEqual(guild.fetches, [], 'no counter here reads the member cache');
	assert.deepEqual(guild.renames.sort(), ['32', 'R0']);
});

test('withPresences follows the presence flag', async () => {
	// Asking for presences without the intent is rejected by Discord, so the
	// option has to track the flag rather than always being true.
	const guild = mockCacheGuild('g-presence', { seen: 1, actual: 10, bots: 1 });
	counterChannel(guild, 'c-humans2');
	store.addCounter({ channelId: 'c-humans2', guildId: 'g-presence', type: 'users', nameTemplate: '{count}' });

	await counters.refreshAll({ guilds: { cache: new Map([['g-presence', guild]]) } });

	assert.equal(guild.fetches[0].withPresences, false, 'MEMBER_COUNT_PRESENCE is unset here');
});

test('a failed fetch leaves the names alone rather than writing a short count', async () => {
	// Discord times the member chunk out on large guilds. Writing the partial
	// cache then would publish a wrong number and look authoritative.
	const guild = mockCacheGuild('g-fail', { seen: 2, actual: 500, bots: 5, fetchFails: true });
	counterChannel(guild, 'c-fail');
	store.addCounter({ channelId: 'c-fail', guildId: 'g-fail', type: 'users', nameTemplate: 'Humans: {count}' });

	const warnings = [];
	const original = console.error;
	console.error = (...args) => warnings.push(args.join(' '));
	try {
		await counters.refreshAll({ guilds: { cache: new Map([['g-fail', guild]]) } });
	} finally {
		console.error = original;
	}

	assert.equal(guild.fetches.length, 1);
	assert.deepEqual(guild.renames, [], 'nothing written');
	assert.ok(warnings.some((line) => /couldn't fetch members/i.test(line)), 'and it says so');
});

test('every cache-reading type is flagged as such', () => {
	// The flag is what decides whether a fetch happens, so a new type that
	// reads the cache and forgets it would reintroduce #105 silently.
	for (const key of ['users', 'bots', 'role', 'online', 'offline']) {
		assert.equal(counters.COUNTER_TYPES[key].needsMemberCache, true, `${key} reads guild.members.cache`);
	}
	for (const key of ['members', 'roles', 'channels']) {
		assert.ok(!counters.COUNTER_TYPES[key].needsMemberCache, `${key} does not need a fetch`);
	}
});
