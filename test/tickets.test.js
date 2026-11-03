const test = require('node:test');
const assert = require('node:assert');

const { useTempDb } = require('./helpers/tempDb');

useTempDb('tickets');

const ticketStore = require('../state/tickets');
const { formatNumber, threadName, formatTicketList } = require('../lib/tickets');

const GUILD_A = 'guild-a';
const GUILD_B = 'guild-b';

function open(guildId, openerId, subject, threadId, channelId = `${guildId}-panel`) {
	const ticket = ticketStore.createTicket(guildId, channelId, openerId, subject);
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
	const ticket = ticketStore.createTicket(GUILD_A, 'panel', 'u1', 'failed');
	assert.equal(ticket.number, 4);
	assert.equal(ticketStore.discardUnstarted(ticket.id, GUILD_A), true);
	assert.equal(ticketStore.getByNumber(4, GUILD_A), null);
	assert.equal(ticketStore.createTicket(GUILD_A, 'panel', 'u1', 'retry').number, 4);
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

test('discardFailed only removes the attempt it names, in its own guild', () => {
	const ticket = open(GUILD_A, 'u1', 'half-made', 'a-half');
	assert.equal(ticketStore.discardFailed(ticket.id, GUILD_B, 'a-half'), false);
	assert.equal(ticketStore.discardFailed(ticket.id, GUILD_A, 'some-other-thread'), false);
	assert.equal(ticketStore.discardFailed(ticket.id, GUILD_A, 'a-half'), true);
	assert.equal(ticketStore.getByThread('a-half', GUILD_A), null);
});

test('startup discards rows left without a thread, but not one being opened now', () => {
	const stale = ticketStore.createTicket(GUILD_B, 'panel', 'u9', 'crashed mid-create');
	const fresh = ticketStore.createTicket(GUILD_B, 'panel', 'u9', 'opening right now');

	// Only rows created before the cutoff go. A cutoff between the two stands
	// in for "older than a minute" without making the test wait one.
	const db = require('../state/db');
	db.prepare('UPDATE tickets SET created_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', stale.id);

	assert.equal(ticketStore.discardStaleUnstarted('2001-01-01T00:00:00.000Z'), 1);
	assert.equal(ticketStore.getByNumber(stale.number, GUILD_B), null);
	assert.notEqual(ticketStore.getByNumber(fresh.number, GUILD_B), null);
	ticketStore.discardUnstarted(fresh.id, GUILD_B);
});

test('claiming is first come, first served', () => {
	const ticket = open(GUILD_B, 'u1', 'contested', 'b-contested');
	assert.equal(ticketStore.claimTicket(ticket.id, GUILD_B, 'mod-1'), true);
	assert.equal(ticketStore.claimTicket(ticket.id, GUILD_B, 'mod-2'), false, 'a second claim must not take it over');
	assert.equal(ticketStore.getByThread('b-contested', GUILD_B).claimedBy, 'mod-1');
	assert.equal(ticketStore.claimTicket(ticket.id, GUILD_A, 'intruder'), false);
});

test('open tickets are found by the channel their thread lives in', () => {
	open(GUILD_B, 'u1', 'in old channel', 'b-old-1', 'old-panel');
	const closing = open(GUILD_B, 'u2', 'already closed', 'b-old-2', 'old-panel');
	ticketStore.closeTicket(closing.id, GUILD_B, 'mod');

	assert.deepEqual(ticketStore.listOpenInChannel('old-panel', GUILD_B).map((ticket) => ticket.threadId), ['b-old-1']);
	assert.deepEqual(ticketStore.listOpenInChannel('old-panel', GUILD_A), [], 'scoped to the guild');
});

test('clearing the log channel keeps the panel', () => {
	ticketStore.setConfig(GUILD_B, { panelChannelId: 'p', panelMessageId: 'm', logChannelId: 'l' });
	assert.equal(ticketStore.clearLogChannel(GUILD_B), true);
	assert.equal(ticketStore.clearLogChannel(GUILD_B), false);
	assert.deepEqual(ticketStore.getConfig(GUILD_B), { panelChannelId: 'p', panelMessageId: 'm', logChannelId: null });
});

// --- /ticket list --------------------------------------------------------------

// Real snowflakes are 17–20 digits; 20 is the worst case for length.
const SNOWFLAKE = '12345678901234567890';

function claimedTicket(number) {
	return {
		number: 10_000 + number,
		threadId: SNOWFLAKE,
		subject: 'x'.repeat(80),
		openerId: SNOWFLAKE,
		claimedBy: SNOWFLAKE,
		status: 'open',
	};
}

test('25 maximum-length claimed tickets stay inside the embed description limit', () => {
	const body = formatTicketList(Array.from({ length: 25 }, (_, index) => claimedTicket(index)));
	assert.ok(body.length <= 4096, `was ${body.length} characters`);
});

test('a list that would overflow says how many it left out', () => {
	const rows = Array.from({ length: 60 }, (_, index) => claimedTicket(index));
	const body = formatTicketList(rows);
	assert.ok(body.length <= 4096, `was ${body.length} characters`);

	const lines = body.split('\n');
	const shown = lines.length - 1;
	assert.match(lines.at(-1), new RegExp(`^…and ${rows.length - shown} more`));
});

test('an empty list says so, and long subjects are shortened', () => {
	assert.equal(formatTicketList([]), 'None.');
	const body = formatTicketList([claimedTicket(1)]);
	assert.ok(body.includes(`${'x'.repeat(59)}…`));
	assert.ok(!body.includes('x'.repeat(61)));
});

test('/ticket is not gated as a whole, so staff can manage open tickets while it is off', () => {
	// CodeStandards.md § 16: off stops new tickets. The gate lives in setup
	// and open instead (lib/tickets.js requireCanOpen).
	const command = require('../commands/ticket');
	assert.equal(command.feature, undefined);
});
