const test = require('node:test');
const assert = require('node:assert');

const { parseDuration, formatDuration, compactDuration } = require('../lib/duration');

test('parseDuration sums every chunk', () => {
	assert.equal(parseDuration('30s'), 30);
	assert.equal(parseDuration('30m'), 1800);
	assert.equal(parseDuration('24h'), 86400);
	assert.equal(parseDuration('7d'), 604800);
	assert.equal(parseDuration('1h30m'), 5400);
	assert.equal(parseDuration('1d12h'), 129600);
});

test('parseDuration is forgiving about spacing and case', () => {
	assert.equal(parseDuration(' 1H 30M '), 5400);
});

test('parseDuration rejects anything it cannot sum, with an actionable message', () => {
	for (const bad of ['', 'soon', '10', 'h', '10x', '1h30', '-5m', '1.5h']) {
		assert.throws(() => parseDuration(bad), /valid duration/, `expected "${bad}" to be rejected`);
	}
});

test('parseDuration rejects a zero total', () => {
	// Syntactically valid, so this is a separate guard from the pattern above.
	assert.throws(() => parseDuration('0m'), /greater than zero/);
});

test('formatDuration spells out units and pluralises', () => {
	assert.equal(formatDuration(604800), '7 days');
	assert.equal(formatDuration(86400), '1 day');
	assert.equal(formatDuration(5400), '1 hour 30 minutes');
	assert.equal(formatDuration(1), '1 second');
	assert.equal(formatDuration(0), '0 seconds');
});

test('compactDuration round-trips through parseDuration', () => {
	// The dashboard shows compactDuration output for editing, so it has to
	// parse back to the same number of seconds.
	for (const seconds of [1, 59, 60, 3600, 5400, 86400, 129600, 604800, 93784]) {
		assert.equal(parseDuration(compactDuration(seconds)), seconds);
	}
	assert.equal(compactDuration(0), '0s');
});
