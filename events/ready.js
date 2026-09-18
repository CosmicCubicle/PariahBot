const { Events } = require('discord.js');
const { ensureDefaultAlertInfra } = require('../lib/defaultAlertInfra');
const { reconcileTempChannels } = require('../lib/tempChannelCleanup');
const { checkAndNotifyDeadHubs } = require('../lib/hubDesync');
const autoDeleteStore = require('../state/autoDeleteChannels');
const autoDelete = require('../lib/autoDelete');
const { scheduleActiveGiveaways } = require('../lib/giveaways');

module.exports = {
	name: Events.ClientReady,
	once: true,
	async execute(client) {
		console.log(`Logged in as ${client.user.tag}.`);

		// GuildCreate doesn't fire for guilds already joined during this initial
		// hydration (only for a new join or a guild recovering from an outage), so
		// every already-joined guild needs its own check here instead.
		for (const guild of client.guilds.cache.values()) {
			// Order matters: the alert destination has to exist before a dead-hub
			// notice might need to be sent to it.
			await ensureDefaultAlertInfra(guild);
			await reconcileTempChannels(guild);
			try {
				await checkAndNotifyDeadHubs(guild);
			} catch (error) {
				console.error(`Failed to check for desynced hubs in guild ${guild.id}:`, error.message);
			}
		}

		// Not per-guild like the loop above — one pass over every configured
		// channel across every guild, seeding tracking (and reaping anything
		// that expired while the bot was offline) before the sweep timer starts.
		await autoDelete.seedAll(client, autoDeleteStore.listAllChannels());
		autoDelete.startSweepTimer();
		scheduleActiveGiveaways(client);
	},
};
