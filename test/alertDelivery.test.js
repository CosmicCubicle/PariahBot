const test = require('node:test');
const assert = require('node:assert');

const { useTempDb } = require('./helpers/tempDb');

useTempDb('alert-delivery');

const { ChannelType } = require('discord.js');
const guildSettings = require('../state/guildSettings');
const { sendAlert } = require('../lib/alertDelivery');
const { createDefaultAlertInfra } = require('../lib/defaultAlertInfra');

// Enough guild for sendAlert: an id and name for the log line, a channel cache
// to deliver into, and a client to fetch DM recipients from.
function mockGuild(id, { channels = [], dmFails = false } = {}) {
	const sent = [];
	const dmed = [];
	return {
		id,
		name: `guild-${id}`,
		sent,
		dmed,
		channels: {
			cache: new Map(channels.map((channelId) => [channelId, {
				id: channelId,
				async send(payload) { sent.push({ channelId, payload }); },
			}])),
			async fetch(channelId) { throw new Error(`no such channel ${channelId}`); },
		},
		client: {
			users: {
				async fetch(userId) {
					return {
						async send() {
							if (dmFails) throw new Error('Cannot send messages to this user');
							dmed.push(userId);
						},
					};
				},
			},
		},
	};
}

test('an alert with nowhere to go is reported, not swallowed', () => {
	// Before #92 this was impossible: every guild got a #bot-alerts channel it
	// never asked for. Now a guild can genuinely have no destination, and the
	// callers were written assuming delivery happened.
	const warnings = [];
	const original = console.warn;
	console.warn = (message) => warnings.push(message);

	try {
		const guild = mockGuild('g-empty');
		return sendAlert(guild, { content: 'hi' }).then((result) => {
			assert.equal(result.undelivered, true);
			assert.equal(result.channel, null);
			assert.deepEqual(result.dms, []);
			assert.equal(warnings.length, 1);
			assert.match(warnings[0], /no alert destination/);
			assert.match(warnings[0], /\/alerts channel/, 'the warning has to say how to fix it');
		});
	} finally {
		console.warn = original;
	}
});

test('a configured channel still receives the alert', async () => {
	guildSettings.setAlertChannel('g-channel', 'chan-1');
	const guild = mockGuild('g-channel', { channels: ['chan-1'] });

	const result = await sendAlert(guild, { content: 'hi' });

	assert.equal(result.undelivered, undefined);
	assert.deepEqual(result.channel, { id: 'chan-1', ok: true });
	assert.equal(guild.sent.length, 1);
});

test('DM recipients alone count as a destination', async () => {
	// No channel set, but someone is being DMed — that is not "nowhere to go".
	guildSettings.addAlertRecipient('g-dm', 'user-1');
	const guild = mockGuild('g-dm');

	const result = await sendAlert(guild, { content: 'hi' });

	assert.equal(result.undelivered, undefined);
	assert.deepEqual(result.dms, [{ id: 'user-1', ok: true }]);
});

test('a failed DM is reported per recipient, not treated as no destination', async () => {
	guildSettings.addAlertRecipient('g-dmfail', 'user-2');
	const guild = mockGuild('g-dmfail', { dmFails: true });

	const result = await sendAlert(guild, { content: 'hi' });

	assert.equal(result.undelivered, undefined);
	assert.equal(result.dms[0].ok, false);
	assert.match(result.dms[0].error, /Cannot send messages/);
});

// --- createDefaultAlertInfra ---------------------------------------------------

function mockCreatingGuild(id) {
	const created = [];
	return {
		id,
		created,
		channels: {
			async create(options) {
				created.push(options);
				return { id: `made-${created.length}`, name: options.name };
			},
		},
	};
}

test('the alert channel is created in a category when one is given', async () => {
	const guild = mockCreatingGuild('g-cat');
	const category = { id: 'cat-1', name: 'Bots', type: ChannelType.GuildCategory };

	const channel = await createDefaultAlertInfra(guild, category);

	assert.equal(guild.created.length, 1, 'exactly one channel — the category is never created (#92)');
	assert.equal(guild.created[0].parent, 'cat-1');
	assert.equal(guildSettings.getGuildSettings('g-cat').defaultChannelId, channel.id);
	assert.equal(guildSettings.getGuildSettings('g-cat').defaultCategoryId, 'cat-1');
});

test('with no category the channel is created at the top level', async () => {
	const guild = mockCreatingGuild('g-nocat');

	await createDefaultAlertInfra(guild);

	// The old code made a "PariahBot" category to hold it. Creating a category
	// to put a channel in is the same thing #92 forbids, one level up.
	assert.equal(guild.created.length, 1);
	assert.equal(guild.created[0].parent, undefined);
	assert.equal(guildSettings.getGuildSettings('g-nocat').defaultCategoryId, null);
});

test('a non-category is refused rather than used as a parent', async () => {
	const guild = mockCreatingGuild('g-bad');
	const notACategory = { id: 'text-1', name: 'general', type: ChannelType.GuildText };

	await assert.rejects(() => createDefaultAlertInfra(guild, notACategory), /has to be a category/);
	assert.equal(guild.created.length, 0, 'nothing is created when the input is wrong');
});
