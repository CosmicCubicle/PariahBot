const test = require('node:test');
const assert = require('node:assert');
const { GatewayIntentBits } = require('discord.js');

const { messageContentEnabled, gatewayIntents, disallowedIntentsHelp } = require('../lib/intents');

test('Guild Members and Guild Moderation are always requested', () => {
	const intents = gatewayIntents({});
	assert.ok(intents.includes(GatewayIntentBits.GuildMembers), 'joins and leaves (#81)');
	assert.ok(intents.includes(GatewayIntentBits.GuildModeration), 'audit log entries and bans');
	assert.ok(intents.includes(GatewayIntentBits.Guilds));
});

test('Message Content is requested only when the host opts in', () => {
	// Off unless switched on: the bot doesn't read what members write.
	assert.ok(!gatewayIntents({}).includes(GatewayIntentBits.MessageContent));
	assert.ok(!gatewayIntents({ SERVER_LOG_MESSAGE_CONTENT: '' }).includes(GatewayIntentBits.MessageContent));
	assert.ok(!gatewayIntents({ SERVER_LOG_MESSAGE_CONTENT: 'false' }).includes(GatewayIntentBits.MessageContent));
	assert.ok(gatewayIntents({ SERVER_LOG_MESSAGE_CONTENT: 'true' }).includes(GatewayIntentBits.MessageContent));
});

test('the opt-in accepts the usual ways of saying yes', () => {
	for (const value of ['true', 'TRUE', '1', 'yes', 'on', ' true ']) {
		assert.equal(messageContentEnabled({ SERVER_LOG_MESSAGE_CONTENT: value }), true, value);
	}
	for (const value of [undefined, '', '0', 'false', 'no', 'off', 'maybe']) {
		assert.equal(messageContentEnabled({ SERVER_LOG_MESSAGE_CONTENT: value }), false, String(value));
	}
});

test('the disallowed-intents message names exactly the switches to turn on', () => {
	const plain = disallowedIntentsHelp({});
	assert.match(plain, /Server Members Intent/);
	assert.doesNotMatch(plain, /Message Content/);

	const withText = disallowedIntentsHelp({ SERVER_LOG_MESSAGE_CONTENT: 'true' });
	assert.match(withText, /Server Members Intent/);
	assert.match(withText, /Message Content Intent/);
});
