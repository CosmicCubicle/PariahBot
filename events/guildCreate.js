const { Events } = require('discord.js');
const { ensureDefaultAlertInfra } = require('../lib/defaultAlertInfra');

module.exports = {
	name: Events.GuildCreate,
	// Fires when the bot is newly added to a guild, or a guild becomes available
	// again after being unavailable (e.g. recovering from a Discord outage) — NOT
	// for guilds already joined during the initial startup hydration. See
	// events/ready.js for the sweep that covers those instead.
	async execute(guild) {
		await ensureDefaultAlertInfra(guild);
	},
};
