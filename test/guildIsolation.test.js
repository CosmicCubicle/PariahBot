const test = require('node:test');
const assert = require('node:assert');

const { useTempDb } = require('./helpers/tempDb');

useTempDb('isolation');

const voiceStore = require('../state/voiceChannels');
const guildSettings = require('../state/guildSettings');

const GUILD_A = 'guild-a';
const GUILD_B = 'guild-b';

// WorkingAgreements.md § 2: a free-typed id from another guild must be a
// no-op, not a cross-guild write. These are the queries that take an id the
// user could have typed by hand rather than picked from a Discord option.

test('removeHub will not delete another guild\'s hub', () => {
	voiceStore.addHub(GUILD_A, 'hub-1', null);

	// Guild B's admin types guild A's hub channel id into /voice remove.
	assert.equal(voiceStore.removeHub('hub-1', GUILD_B), false, 'must report nothing removed');
	assert.equal(voiceStore.listHubs(GUILD_A).length, 1, "guild A's hub must survive");

	// The owning guild can still remove it.
	assert.equal(voiceStore.removeHub('hub-1', GUILD_A), true);
	assert.equal(voiceStore.listHubs(GUILD_A).length, 0);
});

test('updateHubSettings will not edit another guild\'s hub', () => {
	voiceStore.addHub(GUILD_A, 'hub-2', null);

	const changed = voiceStore.updateHubSettings('hub-2', GUILD_B, {
		categoryId: null, nameTemplate: 'hijacked', defaultLimit: 0, minLimit: 0, maxLimit: 99,
	});

	assert.equal(changed, false);
	assert.notEqual(voiceStore.getHub('hub-2').nameTemplate, 'hijacked');
});

test('listHubs only returns the asking guild\'s hubs', () => {
	voiceStore.addHub(GUILD_A, 'hub-a', null);
	voiceStore.addHub(GUILD_B, 'hub-b', null);

	assert.deepEqual(voiceStore.listHubs(GUILD_B).map((hub) => hub.channelId), ['hub-b']);
});

test('settings written for one guild are invisible to another', () => {
	guildSettings.setMemberRole(GUILD_A, 'member-role-a');
	guildSettings.addModRole(GUILD_A, 'mod-a');

	assert.equal(guildSettings.getGuildSettings(GUILD_A).memberRoleId, 'member-role-a');
	assert.equal(guildSettings.getGuildSettings(GUILD_B).memberRoleId, null);
	assert.deepEqual(guildSettings.listModRoles(GUILD_B), []);
});

test('removeModRole is scoped to its guild', () => {
	guildSettings.addModRole(GUILD_A, 'shared-role-id');
	guildSettings.addModRole(GUILD_B, 'shared-role-id');

	// The same role id in two guilds: removing it from one must not touch the other.
	assert.equal(guildSettings.removeModRole(GUILD_A, 'shared-role-id'), true);
	assert.deepEqual(guildSettings.listModRoles(GUILD_B), ['shared-role-id']);
});

test('clearModRoles only clears the asking guild', () => {
	// Self-contained: earlier tests in this file left rows behind, and the
	// point here is cross-guild scoping, not accumulated state.
	guildSettings.clearModRoles(GUILD_A);
	guildSettings.clearModRoles(GUILD_B);

	guildSettings.addModRole(GUILD_A, 'm1');
	guildSettings.addModRole(GUILD_B, 'm2');

	assert.equal(guildSettings.clearModRoles(GUILD_A), 1, 'should report how many it cleared');
	assert.deepEqual(guildSettings.listModRoles(GUILD_A), []);
	assert.deepEqual(guildSettings.listModRoles(GUILD_B), ['m2']);
});
