const { Events } = require('discord.js');
const { handleThreadDelete } = require('../lib/tickets');

module.exports = {
	name: Events.ThreadDelete,
	async execute(thread) {
		await handleThreadDelete(thread).catch((error) => {
			console.error(`Tickets: thread delete handling failed for ${thread.id}:`, error.message);
		});
	},
};
