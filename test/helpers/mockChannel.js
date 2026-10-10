// A channel just real enough for lib/autoDelete.js: it fetches backlog,
// fetches pins (paginated), and deletes by id.
function mockChannel({ id, history = [], pinPages = [{ items: [], hasMore: false } ] }) {
	const deleted = [];
	const pinRequests = [];
	const pages = [...pinPages];

	return {
		id,
		deleted,
		pinRequests,
		messages: {
			async fetch() {
				return new Map(history.map((message) => [message.id, message]));
			},
			async fetchPins(options) {
				pinRequests.push(options);
				// Mirrors the real API running out of pages rather than erroring.
				return pages.shift() ?? { items: [], hasMore: false };
			},
			async delete(messageId) {
				deleted.push(messageId);
			},
		},
	};
}

// Discord's shape: { message, pinnedTimestamp }, not a bare message.
function pin(messageId, pinnedTimestamp = 0) {
	return { message: { id: messageId }, pinnedTimestamp };
}

function message(id, ageSeconds) {
	return { id, createdTimestamp: Date.now() - ageSeconds * 1000 };
}

module.exports = { mockChannel, pin, message };
