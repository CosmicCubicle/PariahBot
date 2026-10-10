const test = require('node:test');
const assert = require('node:assert');

const { startTracking, stopTracking, reapChannel } = require('../lib/autoDelete');
const { mockChannel, pin, message } = require('./helpers/mockChannel');

// Each test uses its own channel id: lib/autoDelete.js keeps one module-level
// Map keyed by channel id, so reusing an id would leak state between tests.
async function track(id, { history, pinPages, config }) {
	const channel = mockChannel({ id, history, pinPages });
	await startTracking(channel, config);
	return channel;
}

test('deletes messages past the age limit', async () => {
	const channel = await track('age', {
		history: [message('old', 7200), message('fresh', 60)],
		config: { maxMessages: 0, liveSeconds: 3600 },
	});

	assert.deepEqual(channel.deleted, ['old']);
	stopTracking('age');
});

test('never deletes a pinned message that is past the age limit', async () => {
	const channel = await track('age-pinned', {
		history: [message('pinned-old', 7200), message('fresh', 60)],
		pinPages: [{ items: [pin('pinned-old')], hasMore: false }],
		config: { maxMessages: 0, liveSeconds: 3600 },
	});

	assert.deepEqual(channel.deleted, []);
	stopTracking('age-pinned');
});

test('count trim removes the oldest messages first', async () => {
	const channel = await track('count', {
		history: [message('m1', 500), message('m2', 400), message('m3', 300), message('m4', 200)],
		config: { maxMessages: 2, liveSeconds: 0 },
	});

	assert.deepEqual(channel.deleted.sort(), ['m1', 'm2']);
	stopTracking('count');
});

test('never deletes a pinned message via the count trim, even as the oldest', async () => {
	// The regression this repo fixed by hand twice: pins were mixed into the
	// survivors list before trimming, so the count limit could delete a pin
	// purely for being oldest.
	const channel = await track('count-pinned', {
		history: [message('pinned-oldest', 500), message('m2', 400), message('m3', 300)],
		pinPages: [{ items: [pin('pinned-oldest')], hasMore: false }],
		config: { maxMessages: 1, liveSeconds: 0 },
	});

	assert.ok(!channel.deleted.includes('pinned-oldest'), 'a pin must never be trimmed by count');
	// The pin doesn't occupy a slot either: of m2/m3, only the newest survives.
	assert.deepEqual(channel.deleted, ['m2']);
	stopTracking('count-pinned');
});

test('walks every page of pins, so a pin on a later page is still protected', async () => {
	const channel = await track('paged', {
		history: [message('page1-pin', 7200), message('page2-pin', 7200), message('unpinned', 7200)],
		pinPages: [
			{ items: [pin('page1-pin', 2000)], hasMore: true },
			{ items: [pin('page2-pin', 1000)], hasMore: false },
		],
		config: { maxMessages: 0, liveSeconds: 3600 },
	});

	assert.deepEqual(channel.deleted, ['unpinned']);
	assert.equal(channel.pinRequests.length, 2, 'should have asked for a second page');
	// The second request pages from the last pin of the first page.
	assert.equal(channel.pinRequests[1].before, 2000);
	stopTracking('paged');
});

test('stops paging when a page comes back empty', async () => {
	const channel = await track('empty-page', {
		history: [message('m1', 7200)],
		pinPages: [{ items: [], hasMore: true }],
		config: { maxMessages: 0, liveSeconds: 3600 },
	});

	assert.equal(channel.pinRequests.length, 1, 'an empty page ends pagination despite hasMore');
	assert.deepEqual(channel.deleted, ['m1']);
	stopTracking('empty-page');
});

test('a failing pin fetch does not throw or stop the reap', async () => {
	// Background work is best-effort (CodeStandards.md § 5). Worth stating the
	// tradeoff: pins can't be identified, so this reap may delete one.
	const channel = mockChannel({ id: 'pin-fail', history: [message('m1', 7200)] });
	channel.messages.fetchPins = async () => { throw new Error('500 Internal Server Error'); };

	await assert.doesNotReject(() => startTracking(channel, { maxMessages: 0, liveSeconds: 3600 }));
	await assert.doesNotReject(() => reapChannel('pin-fail'));
	stopTracking('pin-fail');
});
