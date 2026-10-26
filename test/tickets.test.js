const test = require('node:test');
const assert = require('node:assert');

const { useTempDb } = require('./helpers/tempDb');

useTempDb('tickets');

const ticketStore = require('../state/tickets');
const { formatNumber, threadName } = require('../lib/tickets');

const GUILD_A = 'guild-a';
const GUILD_B = 'guild-b';

function open(guildId, openerId, subject, threadId) {
	const ticket = ticketStore.createTicket(guildId, openerId, subject);
	ticketStore.attachThread(ticket.id, guildId, threadId);
	return { ...ticket, threadId };
}

test('ticket numbers count up per guild, independently', () => {
	assert.equal(open(GUILD_A, 'u1', 'first', 'a-1').number, 1);
	assert.equal(open(GUILD_A, 'u2', 'second', 'a-2').number, 2);
	// Another server starts at 1, not 3.
	assert.equal(open(GUILD_B, 'u1', 'elsewhere', 'b-1').number, 1);
	assert.equal(open(GUILD_A, 'u3', 'third', 'a-3').number, 3);
});

test('a ticket whose thread was never created leaves no row and frees its number', () => {
	const ticket = ticketStore.createTicket(GUILD_A, 'u1', 'failed');
	assert.equal(ticket.number, 4);
	assert.equal(ticketStore.discardUnstarted(ticket.id, GUILD_A), true);
	assert.equal(ticketStore.getByNumber(4, GUILD_A), null);
	assert.equal(ticketStore.createTicket(GUILD_A, 'u1', 'retry').number, 4);
});

test('discardUnstarted never removes a ticket that has a thread', () => {
	const ticket = open(GUILD_A, 'u1', 'real', 'a-real');
	assert.equal(ticketStore.discardUnstarted(ticket.id, GUILD_A), false);
	assert.notEqual(ticketStore.getByThread('a-real', GUILD_A), null);
});

test('a ticket number typed in another guild finds nothing', () => {
	// WorkingAgreements.md § 2: /ticket reopen number:1 in guild B must not
	// reach guild A's ticket #1.
	const ticketA = ticketStore.getByNumber(1, GUILD_A);
	const ticketB = ticketStore.getByNumber(1, GUILD_B);
	assert.equal(ticketA.threadId, 'a-1');
	assert.equal(ticketB.threadId, 'b-1');
	assert.equal(ticketStore.getByThread('a-1', GUILD_B), null);
});

test('closing and reopening are one-time claims, scoped to the guild', () => {
	const ticket = ticketStore.getByNumber(2, GUILD_A);

	assert.equal(ticketStore.closeTicket(ticket.id, GUILD_B, 'intruder'), false, 'another guild cannot close it');
	assert.equal(ticketStore.closeTicket(ticket.id, GUILD_A, 'mod'), true);
	assert.equal(ticketStore.closeTicket(ticket.id, GUILD_A, 'mod'), false, 'a racing second close must lose');

	const closed = ticketStore.getByNumber(2, GUILD_A);
	assert.equal(closed.status, 'closed');
	assert.equal(closed.closedBy, 'mod');
	assert.ok(closed.closedAt);

	assert.equal(ticketStore.reopenTicket(ticket.id, GUILD_B), false);
	assert.equal(ticketStore.reopenTicket(ticket.id, GUILD_A), true);
	assert.equal(ticketStore.reopenTicket(ticket.id, GUILD_A), false);
	const reopened = ticketStore.getByNumber(2, GUILD_A);
	assert.equal(reopened.status, 'open');
	assert.equal(reopened.closedBy, null);
});

test('claiming sets and clears who is handling a ticket', () => {
	const ticket = ticketStore.getByNumber(3, GUILD_A);
	assert.equal(ticketStore.setClaim(ticket.id, GUILD_B, 'intruder'), false);
	assert.equal(ticketStore.setClaim(ticket.id, GUILD_A, 'mod-1'), true);
	assert.equal(ticketStore.getByNumber(3, GUILD_A).claimedBy, 'mod-1');
	ticketStore.setClaim(ticket.id, GUILD_A, null);
	assert.equal(ticketStore.getByNumber(3, GUILD_A).claimedBy, null);
});

test('listing filters by status, newest first, within the guild', () => {
	ticketStore.closeTicket(ticketStore.getByNumber(1, GUILD_A).id, GUILD_A, 'mod');

	const openNumbers = ticketStore.listTickets(GUILD_A, 'open', 25).map((ticket) => ticket.number);
	assert.ok(!openNumbers.includes(1));
	assert.deepEqual(openNumbers, [...openNumbers].sort((a, b) => b - a));
	assert.deepEqual(ticketStore.listTickets(GUILD_A, 'closed', 25).map((ticket) => ticket.number), [1]);
	assert.deepEqual(ticketStore.listTickets(GUILD_B, null, 25).map((ticket) => ticket.number), [1]);
	assert.equal(ticketStore.listTickets(GUILD_A, null, 2).length, 2, 'the limit is honoured');
	assert.equal(ticketStore.countOpen(GUILD_B), 1);
});

test('turning tickets off keeps the log channel and is idempotent', () => {
	ticketStore.setConfig(GUILD_A, { panelChannelId: 'panel', panelMessageId: 'msg', logChannelId: 'log' });
	assert.deepEqual(ticketStore.getConfig(GUILD_A), { panelChannelId: 'panel', panelMessageId: 'msg', logChannelId: 'log' });
	assert.equal(ticketStore.getConfig(GUILD_B).panelChannelId, null, 'config does not leak between guilds');

	assert.equal(ticketStore.clearConfig(GUILD_A), true);
	assert.equal(ticketStore.clearConfig(GUILD_A), false, 'nothing left to turn off');
	assert.deepEqual(ticketStore.getConfig(GUILD_A), { panelChannelId: null, panelMessageId: null, logChannelId: 'log' });
});

test('numbers are zero-padded and thread names fit Discord\'s 100-character limit', () => {
	assert.equal(formatNumber(7), '#0007');
	assert.equal(formatNumber(12345), '#12345');
	assert.equal(threadName({ number: 7, subject: 'Help' }), '#0007 · Help');
	assert.equal(threadName({ number: 1, subject: 'x'.repeat(200) }).length, 100);
});
