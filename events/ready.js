const { Events } = require('discord.js');
const { ensureDefaultAlertInfra } = require('../lib/defaultAlertInfra');

module.exports = {
	name: Events.ClientReady,
	once: true,
	async execute(client) {
		console.log(`Logged in as ${client.user.tag}.`);

		// GuildCreate doesn't fire for guilds already joined during this initial
		// hydration (only for a new join or a guild recovering from an outage), so
		// every already-joined guild needs its own check here instead.
		for (const guild of client.guilds.cache.values()) {
			await ensureDefaultAlertInfra(guild);
		}
	},
};
