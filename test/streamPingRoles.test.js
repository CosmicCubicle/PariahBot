const test = require('node:test');
const assert = require('node:assert');

const { useTempDb } = require('./helpers/tempDb');

useTempDb('streamPingRoles');

// Required only after the temp database is set, or these would read the real one.
const guildSettings = require('../state/guildSettings');
const { MAX_STREAM_PING_ROLES, addPingRole } = require('../lib/streamAlerts');
const { renderAlertContent, pingMentions } = require('../lib/alertContent');

const GUILD = 'guild-1';
const OTHER_GUILD = 'guild-2';

test('roles are added once each, and listed', () => {
	assert.equal(addPingRole(GUILD, 'role-a'), true);
	assert.equal(addPingRole(GUILD, 'role-b'), true);
	assert.equal(addPingRole(GUILD, 'role-a'), false, 'already on the list');
	assert.deepEqual(guildSettings.listStreamPingRoles(GUILD), ['role-a', 'role-b']);
});

test('@everyone is refused, since its ID is the server\'s', () => {
	assert.throws(() => addPingRole(GUILD, GUILD), /@everyone/);
});

test(`at most ${MAX_STREAM_PING_ROLES} roles, and the refusal changes nothing`, () => {
	guildSettings.clearStreamPingRoles('guild-cap');
	for (let i = 0; i < MAX_STREAM_PING_ROLES; i++) addPingRole('guild-cap', `role-${i}`);
	assert.throws(() => addPingRole('guild-cap', 'one-too-many'), /at most/);
	assert.equal(guildSettings.listStreamPingRoles('guild-cap').length, MAX_STREAM_PING_ROLES);
	// A role already on a full list is still just "already there", not an error.
	assert.equal(addPingRole('guild-cap', 'role-0'), false);
});

test('removing is scoped to the server', () => {
	addPingRole(OTHER_GUILD, 'shared-id');
	assert.equal(guildSettings.removeStreamPingRole(GUILD, 'shared-id'), false, 'another server\'s role must not be reachable');
	assert.deepEqual(guildSettings.listStreamPingRoles(OTHER_GUILD), ['shared-id']);
	assert.equal(guildSettings.removeStreamPingRole(OTHER_GUILD, 'shared-id'), true);
});

test('disabling stream alerts clears the channel and the ping roles', () => {
	guildSettings.setStreamAlerts('guild-off', 'channel-1');
	addPingRole('guild-off', 'role-a');

	guildSettings.clearStreamAlerts('guild-off');

	assert.equal(guildSettings.getGuildSettings('guild-off').streamAlertChannelId, null);
	assert.deepEqual(guildSettings.listStreamPingRoles('guild-off'), []);
});

test('setting the channel leaves the ping roles alone', () => {
	addPingRole('guild-keep', 'role-a');
	guildSettings.setStreamAlerts('guild-keep', 'channel-2');
	assert.equal(guildSettings.getGuildSettings('guild-keep').streamAlertChannelId, 'channel-2');
	assert.deepEqual(guildSettings.listStreamPingRoles('guild-keep'), ['role-a']);
});

test('every ping role goes together, at the start or where {role} is', () => {
	assert.equal(renderAlertContent(null, {}, ['a', 'b']), '<@&a> <@&b>');
	assert.equal(renderAlertContent('{name} is live', { name: 'X' }, ['a', 'b']), '<@&a> <@&b> X is live');
	assert.equal(renderAlertContent('{name} is live {role}', { name: 'X' }, ['a', 'b']), 'X is live <@&a> <@&b>');
	assert.equal(renderAlertContent(null, {}, []), undefined, 'no roles and no message means no text');
});

test('a single role ID still works, for Instagram and RSS', () => {
	assert.equal(renderAlertContent(null, {}, 'a'), '<@&a>');
	assert.equal(renderAlertContent(null, {}, null), undefined);
	assert.deepEqual(pingMentions('a'), { parse: [], roles: ['a'] });
	assert.deepEqual(pingMentions(null), { parse: [], roles: [] });
});

test('only the ping roles can notify anyone', () => {
	assert.deepEqual(pingMentions(['a', 'b']), { parse: [], roles: ['a', 'b'] });
});
