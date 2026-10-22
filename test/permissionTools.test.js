const test = require('node:test');
const assert = require('node:assert');

const { useTempDb } = require('./helpers/tempDb');

useTempDb('permissionTools');

// Required only after the temp database is set, or these would read the real one.
const { ChannelType, PermissionFlagsBits: F } = require('discord.js');
const guildSettings = require('../state/guildSettings');
const tools = require('../lib/permissionTools');

const GUILD = 'guild-1';

function overwrites(entries) {
	return new Map(Object.entries(entries));
}

test.before(() => {
	guildSettings.addAdminRole(GUILD, 'admin-role');
	guildSettings.addModRole(GUILD, 'mod-role');
});

// --- copy ---

test('add keeps the target\'s permissions and gains the source\'s', () => {
	const plan = tools.planCopy(
		{ permissions: F.SendMessages | F.Connect, overwrites: overwrites({}) },
		{ permissions: F.SendMessages | F.AddReactions, overwrites: overwrites({}) },
		'add',
	);
	assert.equal(plan.permissions.next, F.SendMessages | F.Connect | F.AddReactions);
	assert.equal(plan.permissions.added, F.Connect);
	assert.equal(plan.permissions.removed, 0n);
});

test('replace makes the target the same, removing what the source lacks', () => {
	const plan = tools.planCopy(
		{ permissions: F.SendMessages, overwrites: overwrites({}) },
		{ permissions: F.SendMessages | F.AddReactions, overwrites: overwrites({}) },
		'replace',
	);
	assert.equal(plan.permissions.next, F.SendMessages);
	assert.equal(plan.permissions.removed, F.AddReactions);
});

test('Administrator is never copied, and never removed', () => {
	const fromAdmin = tools.planCopy({ permissions: F.Administrator | F.SendMessages, overwrites: overwrites({}) }, { permissions: 0n, overwrites: overwrites({}) }, 'replace');
	assert.equal(fromAdmin.permissions.next & F.Administrator, 0n);

	const ontoAdmin = tools.planCopy({ permissions: F.SendMessages, overwrites: overwrites({}) }, { permissions: F.Administrator, overwrites: overwrites({}) }, 'replace');
	assert.equal(ontoAdmin.permissions.next & F.Administrator, F.Administrator);
	assert.equal(ontoAdmin.permissions.removed, 0n);
});

test('add merges overrides: the source wins for each permission it sets', () => {
	const plan = tools.planCopy(
		{ permissions: 0n, overwrites: overwrites({ c1: { allow: F.ViewChannel, deny: F.SendMessages } }) },
		{ permissions: 0n, overwrites: overwrites({ c1: { allow: F.SendMessages | F.AddReactions, deny: F.ViewChannel } }) },
		'add',
	);
	assert.deepEqual(plan.overwrites, [{ channelId: 'c1', action: 'update', allow: F.ViewChannel | F.AddReactions, deny: F.SendMessages }]);
});

test('add creates overrides the target lacks and leaves its others alone', () => {
	const plan = tools.planCopy(
		{ permissions: 0n, overwrites: overwrites({ c1: { allow: F.ViewChannel, deny: 0n } }) },
		{ permissions: 0n, overwrites: overwrites({ c2: { allow: F.ViewChannel, deny: 0n } }) },
		'add',
	);
	assert.deepEqual(plan.overwrites, [{ channelId: 'c1', action: 'create', allow: F.ViewChannel, deny: 0n }]);
});

test('replace copies overrides exactly and removes the target\'s extra ones', () => {
	const plan = tools.planCopy(
		{ permissions: 0n, overwrites: overwrites({ c1: { allow: F.ViewChannel, deny: 0n } }) },
		{ permissions: 0n, overwrites: overwrites({ c1: { allow: F.ViewChannel | F.SendMessages, deny: 0n }, c2: { allow: F.ViewChannel, deny: 0n } }) },
		'replace',
	);
	assert.deepEqual(plan.overwrites, [
		{ channelId: 'c1', action: 'update', allow: F.ViewChannel, deny: 0n },
		{ channelId: 'c2', action: 'remove', allow: 0n, deny: 0n },
	]);
});

test('an override that already matches is not touched', () => {
	const same = { allow: F.ViewChannel, deny: F.SendMessages };
	const plan = tools.planCopy({ permissions: 0n, overwrites: overwrites({ c1: same }) }, { permissions: 0n, overwrites: overwrites({ c1: { ...same } }) }, 'add');
	assert.deepEqual(plan.overwrites, []);
});

test('the copy button carries everything Confirm needs, and nothing else parses', () => {
	const id = tools.copyButtonId('replace', '111', '222');
	assert.ok(id.length <= 100, 'Discord caps customId at 100 characters');
	assert.deepEqual(tools.parseCopyButtonId(id), { mode: 'replace', sourceId: '111', targetId: '222' });
	assert.equal(tools.parseCopyButtonId('perms:copy:delete:1:2'), null, 'an unknown mode is refused');
	assert.equal(tools.parseCopyButtonId('giveaway:enter:1'), null);
});

// --- hide, show, speak ---

test('speaking means messages in text, and messages and voice elsewhere', () => {
	assert.equal(tools.speakBits(ChannelType.GuildText), F.SendMessages);
	assert.equal(tools.speakBits(ChannelType.GuildVoice), F.SendMessages | F.Speak);
	assert.equal(tools.speakBits(ChannelType.GuildCategory), F.SendMessages | F.Speak);
});

test('show includes message history; hide only takes away sight', () => {
	assert.equal(tools.SHOW_BITS, F.ViewChannel | F.ReadMessageHistory);
	assert.equal(tools.HIDE_BITS, F.ViewChannel);
});

// Just enough member and role for the staff checks.
function member({ permissions = [], roles = [] } = {}) {
	const bits = permissions.reduce((total, flag) => total | flag, 0n);
	return {
		permissions: { has: (flag) => (bits & flag) === flag },
		roles: { cache: new Map(roles.map((id) => [id, { id }])) },
	};
}

function roleTarget(id, permissions = 0n) {
	return { role: { id, permissions: { has: (flag) => (permissions & flag) === flag } }, label: id };
}

test('admin and mod roles, Administrator roles and staff members are staff targets', () => {
	assert.equal(tools.isStaffTarget(roleTarget('admin-role'), GUILD), true);
	assert.equal(tools.isStaffTarget(roleTarget('mod-role'), GUILD), true);
	assert.equal(tools.isStaffTarget(roleTarget('boss', F.Administrator), GUILD), true);
	assert.equal(tools.isStaffTarget({ member: member({ roles: ['mod-role'] }), label: 'm' }, GUILD), true);
	assert.equal(tools.isStaffTarget(roleTarget('members'), GUILD), false);
	assert.equal(tools.isStaffTarget({ member: member(), label: 'm' }, GUILD), false);
});

test('@everyone is not a staff target, so mods can make channels private', () => {
	assert.equal(tools.isStaffTarget(roleTarget(GUILD), GUILD), false);
});

test('a mod is refused on staff targets; an admin is not', () => {
	const mod = member({ roles: ['mod-role'] });
	const admin = member({ roles: ['admin-role'] });
	assert.throws(() => tools.requireMayRestrict(mod, roleTarget('admin-role'), GUILD), /Only admins/);
	assert.doesNotThrow(() => tools.requireMayRestrict(admin, roleTarget('admin-role'), GUILD));
	assert.doesNotThrow(() => tools.requireMayRestrict(mod, roleTarget('members'), GUILD));
});

// --- report ---

test('roles are grouped by what they can do, and unseen means nothing else', () => {
	const caps = tools.reportCapabilities(ChannelType.GuildText);
	const groups = tools.groupByAccess([
		{ id: 'a', permissions: F.ViewChannel | F.SendMessages },
		{ id: 'b', permissions: F.ViewChannel },
		{ id: 'c', permissions: F.SendMessages },
		{ id: 'd', permissions: F.Administrator },
	], caps);
	assert.deepEqual([...groups], [
		['Can see, send messages', ['a']],
		['Can see', ['b']],
		["Can't see it", ['c']],
		['Administrator (sees and does everything)', ['d']],
	]);
});

test('voice channels and categories also report connect and speak', () => {
	assert.deepEqual(tools.reportCapabilities(ChannelType.GuildVoice).map(([label]) => label), ['see', 'send messages', 'connect', 'speak']);
	assert.deepEqual(tools.reportCapabilities(ChannelType.GuildText).map(([label]) => label), ['see', 'send messages']);
});

test('long lists are cut to fit an embed field, saying how many were left out', () => {
	const lines = Array.from({ length: 200 }, (_, i) => `<@&${String(i).padStart(18, '0')}>`);
	const text = tools.fitLines(lines, ' ');
	assert.ok(text.length <= 1024);
	assert.match(text, /…and \d+ more$/);
	assert.equal(tools.fitLines(['a', 'b']), 'a\nb');
});

test('overwrite flags are named the way Discord\'s API takes them', () => {
	assert.deepEqual(tools.flagsSetTo(F.ViewChannel | F.SendMessages, false), { ViewChannel: false, SendMessages: false });
});
