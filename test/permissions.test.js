const test = require('node:test');
const assert = require('node:assert');

const { useTempDb } = require('./helpers/tempDb');

useTempDb('permissions');

// Required only after the temp database is set, or these would read the real one.
const { PermissionFlagsBits } = require('discord.js');
const guildSettings = require('../state/guildSettings');
const { isAdmin, isMod, canOverrideVoiceOwner } = require('../lib/permissions');

const GUILD = 'guild-1';
const OTHER_GUILD = 'guild-2';

// Just enough member: permission bits plus a role cache.
function member({ permissions = [], roles = [] } = {}) {
	const bits = permissions.reduce((total, flag) => total | flag, 0n);
	return {
		permissions: { has: (flag) => (bits & flag) === flag },
		roles: { cache: new Map(roles.map((id) => [id, { id }])) },
	};
}

test.before(() => {
	guildSettings.addAdminRole(GUILD, 'admin-role');
	guildSettings.addModRole(GUILD, 'mod-role');
});

test('Administrator is admin, and therefore also mod', () => {
	const m = member({ permissions: [PermissionFlagsBits.Administrator] });
	assert.equal(isAdmin(m, GUILD), true);
	assert.equal(isMod(m, GUILD), true);
});

test('an admin role is admin and mod; a mod role is mod but not admin', () => {
	const adminRole = member({ roles: ['admin-role'] });
	assert.equal(isAdmin(adminRole, GUILD), true);
	assert.equal(isMod(adminRole, GUILD), true);

	const modRole = member({ roles: ['mod-role'] });
	assert.equal(isAdmin(modRole, GUILD), false);
	assert.equal(isMod(modRole, GUILD), true);
});

test('Manage Channels alone is neither admin nor mod', () => {
	// This is what changed for the hub Prune/Restore buttons: they used to
	// accept this member and now do not.
	const m = member({ permissions: [PermissionFlagsBits.ManageChannels] });
	assert.equal(isAdmin(m, GUILD), false);
	assert.equal(isMod(m, GUILD), false);
});

test('a plain member is neither', () => {
	const m = member();
	assert.equal(isAdmin(m, GUILD), false);
	assert.equal(isMod(m, GUILD), false);
});

test('staff roles do not carry across guilds', () => {
	// The same role id must not grant anything in a guild that never set it.
	const m = member({ roles: ['mod-role'] });
	assert.equal(isMod(m, GUILD), true);
	assert.equal(isMod(m, OTHER_GUILD), false);
});

test('canOverrideVoiceOwner still accepts Manage Channels', () => {
	// Deliberately broader than isMod, and left alone by this change — /vc
	// claim's override rules depend on it.
	const m = member({ permissions: [PermissionFlagsBits.ManageChannels] });
	assert.equal(canOverrideVoiceOwner(m, GUILD), true);
});
