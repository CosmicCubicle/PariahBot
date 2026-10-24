const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// #92: the bot never creates a channel nobody asked for. That is an easy thing
// to undo by accident — one convenient guild.channels.create() in a startup
// sweep or an event handler and the bot is making channels again, with nothing
// failing to say so.
//
// So this test pins the call sites. Every entry below is a path where a person
// explicitly asked for the channel, with the ask named. A new call site fails
// this test until someone adds it here, which forces the question to be
// answered rather than assumed.
const ALLOWED = {
	'lib/defaultAlertInfra.js': 'only from /alerts restore-default, which requires a name: or an existing channel:',
	'lib/voiceHubs.js': 'createHub from /voice create, and restoreHub from the dead-hub Restore button',
	'commands/security.js': 'from /security ... setup — running setup is the ask, and the reply always says what was created',
	'events/voiceStateUpdate.js': 'a temporary channel, from a member joining a hub an admin created',
	'lib/memberCounters.js': 'from /membercount add — the admin asked for a counter, and the reply names the channel it made',
};

const ROOT = path.resolve(__dirname, '..');
const SEARCH_DIRS = ['commands', 'events', 'lib', 'lib/dashboard', 'state', 'logging'];

function sourceFiles() {
	const files = [];
	for (const dir of SEARCH_DIRS) {
		const full = path.join(ROOT, dir);
		if (!fs.existsSync(full)) continue;
		for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.endsWith('.js')) files.push(`${dir}/${entry.name}`);
		}
	}
	return files;
}

test('no channel is created outside the paths a person explicitly asked for', () => {
	const found = sourceFiles().filter((file) => /channels\.create\s*\(/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));

	const unexpected = found.filter((file) => !Object.hasOwn(ALLOWED, file));
	assert.deepEqual(unexpected, [], 'new channel creation — if a person asked for it, add it to ALLOWED with the ask named');
});

test('every allowed creation site still exists', () => {
	// The other direction: a path that stopped creating channels should be taken
	// off the list, so the list keeps meaning something.
	const found = new Set(sourceFiles().filter((file) => /channels\.create\s*\(/.test(fs.readFileSync(path.join(ROOT, file), 'utf8'))));

	for (const file of Object.keys(ALLOWED)) {
		assert.ok(found.has(file), `${file} no longer creates a channel — remove it from ALLOWED`);
	}
});

test('nothing creates a channel from a startup or join sweep', () => {
	// The specific shape #92 removed: creation reached from events/ready.js or a
	// GuildCreate handler, where no one is present to ask.
	assert.ok(!fs.existsSync(path.join(ROOT, 'events', 'guildCreate.js')),
		'a GuildCreate handler is where auto-provisioning lived — reintroducing one needs a fresh look at #92');

	const ready = fs.readFileSync(path.join(ROOT, 'events', 'ready.js'), 'utf8');
	assert.ok(!/channels\.create\s*\(/.test(ready), 'events/ready.js must not create channels');
	assert.ok(!/ensureDefaultAlertInfra/.test(ready), 'the startup alert-channel provisioner was removed in #92');
});

test('the alert-channel provisioner no longer exposes an automatic entry point', () => {
	const infra = require('../lib/defaultAlertInfra');
	assert.equal(typeof infra.createDefaultAlertInfra, 'function');
	assert.equal(infra.ensureDefaultAlertInfra, undefined,
		'ensureDefaultAlertInfra was the no-consent path; it must stay gone');
});
