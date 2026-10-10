// Durations typed by admins: one or more <number><unit> chunks, summed —
// "24h", "30m", "1h30m", "7d", "1d12h". Shared by /autodelete and /mod. No
// dependency: a few lines cover it (see CodeStandards.md § 1).

const UNIT_SECONDS = { d: 24 * 60 * 60, h: 60 * 60, m: 60, s: 1 };

// Returns the total in seconds, or throws a message the admin can act on.
function parseDuration(raw) {
	const compact = raw.replace(/\s+/g, '').toLowerCase();
	if (!/^(\d+[dhms])+$/.test(compact)) {
		throw new Error(`"${raw}" isn't a valid duration — use a combination like 7d, 24h, 30m, 1h30m, or 90s.`);
	}

	let totalSeconds = 0;
	for (const [, value, unit] of compact.matchAll(/(\d+)([dhms])/g)) {
		totalSeconds += Number(value) * UNIT_SECONDS[unit];
	}

	if (totalSeconds <= 0) {
		throw new Error('Duration must be greater than zero.');
	}
	return totalSeconds;
}

// "7 days", "1 day 12 hours", "30 minutes" — for replies and alerts.
function formatDuration(totalSeconds) {
	const parts = [];
	let remaining = totalSeconds;
	for (const [unit, label] of [['d', 'day'], ['h', 'hour'], ['m', 'minute'], ['s', 'second']]) {
		const count = Math.floor(remaining / UNIT_SECONDS[unit]);
		remaining -= count * UNIT_SECONDS[unit];
		if (count) parts.push(`${count} ${label}${count === 1 ? '' : 's'}`);
	}
	return parts.join(' ') || '0 seconds';
}

// "7d", "1d12h", "30m" — the typed form, so a value shown for editing (in the
// admin dashboard) parses back to the same number of seconds.
function compactDuration(totalSeconds) {
	let remaining = totalSeconds;
	let text = '';
	for (const unit of ['d', 'h', 'm', 's']) {
		const count = Math.floor(remaining / UNIT_SECONDS[unit]);
		remaining -= count * UNIT_SECONDS[unit];
		if (count) text += `${count}${unit}`;
	}
	return text || '0s';
}

module.exports = { parseDuration, formatDuration, compactDuration };
