const test = require('node:test');
const assert = require('node:assert');
const { PermissionFlagsBits } = require('discord.js');

const { useTempDb } = require('./helpers/tempDb');

useTempDb('serverlog');

const store = require('../state/serverLog');
const caseStore = require('../state/modCases');
const features = require('../lib/features');
const serverLog = require('../lib/serverLog');

const GUILD_A = 'guild-a';
const GUILD_B = 'guild-b';

test('a section nobody has touched is off, with no channel', () => {
	assert.deepEqual(store.getSection('untouched-guild', 'messages'), { enabled: false, channelId: null });
	assert.equal(serverLog.activeChannelId('untouched-guild', 'messages'), null);
});

test('picking a channel switches the section on; switching off keeps the channel', () => {
	store.setChannel(GUILD_A, 'joinsLeaves', 'chan-1');
	assert.deepEqual(store.getSection(GUILD_A, 'joinsLeaves'), { enabled: true, channelId: 'chan-1' });
	assert.equal(serverLog.activeChannelId(GUILD_A, 'joinsLeaves'), 'chan-1');

	store.setEnabled(GUILD_A, 'joinsLeaves', false);
	assert.deepEqual(store.getSection(GUILD_A, 'joinsLeaves'), { enabled: false, channelId: 'chan-1' });
	assert.equal(serverLog.activeChannelId(GUILD_A, 'joinsLeaves'), null, 'off means no posting');

	store.setEnabled(GUILD_A, 'joinsLeaves', true);
	assert.equal(serverLog.activeChannelId(GUILD_A, 'joinsLeaves'), 'chan-1', 'back on, same channel');
});

test('sections are independent, and so are servers', () => {
	store.setChannel(GUILD_A, 'kicksBans', 'mod-log');
	store.setChannel(GUILD_A, 'messages', 'message-log');

	assert.equal(serverLog.activeChannelId(GUILD_A, 'kicksBans'), 'mod-log');
	assert.equal(serverLog.activeChannelId(GUILD_A, 'messages'), 'message-log');
	assert.equal(serverLog.activeChannelId(GUILD_A, 'serverChanges'), null);

	// WorkingAgreements.md § 2: guild A's settings must never apply in guild B.
	assert.equal(serverLog.activeChannelId(GUILD_B, 'kicksBans'), null);
	assert.equal(store.getSections(GUILD_B).size, 0);
});

test('switching the whole feature off silences every section, and keeps them', () => {
	store.setChannel(GUILD_B, 'serverChanges', 'changes');
	features.setEnabled(GUILD_B, 'logging', false);
	assert.equal(serverLog.activeChannelId(GUILD_B, 'serverChanges'), null);
	assert.deepEqual(store.getSection(GUILD_B, 'serverChanges'), { enabled: true, channelId: 'changes' }, 'settings kept');

	features.reset(GUILD_B, 'logging');
	assert.equal(serverLog.activeChannelId(GUILD_B, 'serverChanges'), 'changes');
});

test('only the four sections exist', () => {
	assert.deepEqual(serverLog.SECTION_KEYS, ['kicksBans', 'joinsLeaves', 'messages', 'serverChanges']);
	assert.equal(serverLog.isSection('messages'), true);
	assert.equal(serverLog.isSection('toString'), false, 'not fooled by Object.prototype');
	assert.equal(serverLog.isSection('roles'), false);
});

test('permission changes read as names added and removed', () => {
	const old = String(PermissionFlagsBits.SendMessages | PermissionFlagsBits.AttachFiles);
	const updated = String(PermissionFlagsBits.SendMessages | PermissionFlagsBits.ManageMessages);
	assert.equal(serverLog.permissionDiffLine('Allowed', old, updated), 'Allowed: + Manage Messages; − Attach Files');
	assert.equal(serverLog.permissionDiffLine('Allowed', old, old), null, 'no change, no line');
	assert.equal(serverLog.permissionDiffLine('Denied', null, String(PermissionFlagsBits.ViewChannel)), 'Denied: + View Channel');
});

test('audit log changes become readable lines, skipping lists and objects', () => {
	const lines = serverLog.describeChanges([
		{ key: 'name', old: 'general', new: 'chat' },
		{ key: 'nsfw', old: false, new: true },
		{ key: 'color', old: 0, new: 0xff0000 },
		{ key: 'parent_id', old: null, new: '123456789012345678' },
		{ key: 'rate_limit_per_user', old: 0, new: 30 },
		{ key: 'permission_overwrites', old: undefined, new: [{ id: '1' }] },
		{ key: 'permissions', old: '0', new: String(PermissionFlagsBits.KickMembers) },
	]);
	assert.deepEqual(lines, [
		'Name: general → chat',
		'Age-restricted: no → yes',
		'Color: #000000 → #ff0000',
		'Category: none → <#123456789012345678>',
		'Slowmode: 0s → 30s',
		'Permissions: + Kick Members',
	]);
});

test("a member's role update lists roles added and removed", () => {
	assert.deepEqual(serverLog.describeRoleUpdate([
		{ key: '$add', new: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }] },
		{ key: '$remove', new: [{ id: '3', name: 'C' }] },
	]), ['Added: <@&1>, <@&2>', 'Removed: <@&3>']);
});

test('long text is cut to fit an embed field', () => {
	assert.equal(serverLog.truncate('x'.repeat(2000)).length, 1024);
	assert.ok(serverLog.truncate('x'.repeat(2000)).endsWith('…'));
	assert.equal(serverLog.truncate('short'), 'short');
});

test("the case behind the bot's own ban is found by member, window and action", () => {
	const before = new Date(Date.now() - 1000).toISOString();
	const banId = caseStore.addCase({ guildId: GUILD_A, userId: 'member-1', moderatorId: 'mod-1', action: 'tempban', reason: 'spam' });

	assert.equal(caseStore.findRecentCase(GUILD_A, 'member-1', ['ban', 'tempban', 'softban'], before)?.id, banId);
	// A kick log must not pick up a ban's case.
	assert.equal(caseStore.findRecentCase(GUILD_A, 'member-1', ['kick'], before), null);
	// Outside the window, nothing: an old case isn't this action's.
	assert.equal(caseStore.findRecentCase(GUILD_A, 'member-1', ['tempban'], new Date(Date.now() + 60_000).toISOString()), null);
	// Another server's case for the same member is never matched.
	assert.equal(caseStore.findRecentCase(GUILD_B, 'member-1', ['tempban'], before), null);
});

test('problems are worded as fixes', () => {
	const fakeGuild = (canAudit, channel) => ({
		members: { me: { permissions: { has: (flag) => flag !== PermissionFlagsBits.ViewAuditLog || canAudit } } },
		channels: { cache: { get: () => channel } },
	});
	const postable = { name: 'logs', permissionsFor: () => ({ has: () => true }) };
	const muted = { name: 'logs', permissionsFor: () => ({ has: () => false }) };

	assert.deepEqual(serverLog.sectionProblems(fakeGuild(true, postable), 'kicksBans', 'c'), []);
	assert.match(serverLog.sectionProblems(fakeGuild(false, postable), 'kicksBans', 'c')[0], /View Audit Log/);
	assert.deepEqual(serverLog.sectionProblems(fakeGuild(false, postable), 'joinsLeaves', 'c'), [], 'joins need no audit log');
	assert.match(serverLog.sectionProblems(fakeGuild(true, muted), 'messages', 'c')[0], /can't post in #logs/);
	assert.match(serverLog.sectionProblems(fakeGuild(true, undefined), 'messages', 'c')[0], /deleted/);
});

test('the message cache sweeper drops old messages and servers not logging messages', () => {
	store.setChannel('logs-messages', 'messages', 'chan');
	const sweep = serverLog.messageCacheSweepers().messages.filter();
	const now = Date.now();

	assert.equal(sweep({ guildId: 'logs-messages', createdTimestamp: now }), false, 'recent, logging: kept');
	assert.equal(sweep({ guildId: 'logs-messages', createdTimestamp: now - serverLog.MESSAGE_CACHE_LIFETIME_MS - 1 }), true, 'too old: dropped');
	assert.equal(sweep({ guildId: 'quiet-guild', createdTimestamp: now }), true, 'server not logging messages: dropped');
	assert.equal(sweep({ guildId: null, createdTimestamp: now }), true, 'DMs: dropped');
});
