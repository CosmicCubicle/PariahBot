const test = require('node:test');
const assert = require('node:assert');

const { useTempDb } = require('./helpers/tempDb');

useTempDb('channelGuide');

// Required only after the temp database is set, or these would read the real one.
const guildSettings = require('../state/guildSettings');
const features = require('../lib/features');
const { OWNER_CONTROLS, buildChannelGuide, postChannelGuide } = require('../lib/tempVoice');

const ALL_ON = Object.fromEntries(Object.keys(OWNER_CONTROLS).map((control) => [control, true]));
const ALL_OFF = Object.fromEntries(Object.keys(OWNER_CONTROLS).map((control) => [control, false]));

function guide(overrides = {}) {
	const embed = buildChannelGuide({ ownerId: 'owner-1', ownerControls: ALL_ON, minLimit: 0, maxLimit: 99, ...overrides });
	const { description, fields } = embed.toJSON();
	return { description, owner: fields[0].value, anyone: fields[1].value };
}

// A channel just real enough for postChannelGuide: a guild id and send().
function fakeChannel(guildId) {
	const sent = [];
	return { sent, guild: { id: guildId }, async send(payload) { sent.push(payload); } };
}

test('names the owner and says where the commands work', () => {
	const { description } = guide();
	assert.match(description, /<@owner-1>/);
	assert.match(description, /this channel's chat/);
});

test('lists every owner command when all are allowed', () => {
	const { owner } = guide();
	for (const command of ['/vc name', '/vc limit', '/vc lock', '/vc unlock', '/vc kick', '/vc transfer']) {
		assert.ok(owner.includes(`\`${command}\``), `${command} missing from the guide`);
	}
});

test('leaves out owner commands an admin has turned off', () => {
	const { owner } = guide({ ownerControls: { ...ALL_ON, kick: false, lock: false } });
	assert.ok(!owner.includes('/vc kick'));
	assert.ok(!owner.includes('/vc lock'));
	assert.ok(!owner.includes('/vc unlock'));
	assert.ok(owner.includes('/vc name'));
});

test('says so when every owner command is off, and still offers /vc claim', () => {
	const { owner, anyone } = guide({ ownerControls: ALL_OFF });
	assert.match(owner, /turned off/);
	assert.ok(anyone.includes('/vc claim'));
});

test("shows the hub's limit range, and 0 only when the hub allows it", () => {
	assert.match(guide().owner, /0–99, 0 for no limit/);
	const { owner } = guide({ minLimit: 2, maxLimit: 10 });
	assert.match(owner, /2–10\)/);
	assert.ok(!owner.includes('no limit'));
});

test('posts the guide without pinging anyone, using the server\'s settings', async () => {
	guildSettings.setOwnerControlAllowed('guild-post', 'transfer', false);
	const channel = fakeChannel('guild-post');

	await postChannelGuide(channel, { ownerId: 'owner-1', minLimit: 0, maxLimit: 99 });

	assert.equal(channel.sent.length, 1);
	assert.deepEqual(channel.sent[0].allowedMentions, { parse: [] });
	const owner = channel.sent[0].embeds[0].toJSON().fields[0].value;
	assert.ok(!owner.includes('/vc transfer'));
	assert.ok(owner.includes('/vc name'));
});

test('posts nothing when the server has temporary voice switched off', async () => {
	features.setEnabled('guild-off', 'tempVoice', false);
	const channel = fakeChannel('guild-off');

	await postChannelGuide(channel, { ownerId: 'owner-1', minLimit: 0, maxLimit: 99 });

	assert.equal(channel.sent.length, 0);
});
