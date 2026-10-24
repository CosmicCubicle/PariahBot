const { Events } = require('discord.js');
const { reconcileTempChannels } = require('../lib/tempChannelCleanup');
const { checkAndNotifyDeadHubs } = require('../lib/hubDesync');
const autoDeleteStore = require('../state/autoDeleteChannels');
const autoDelete = require('../lib/autoDelete');
const { scheduleActiveGiveaways } = require('../lib/giveaways');
const { startPoller: startStreamAlerts } = require('../lib/streamAlerts');
const { startPoller: startInstagramAlerts } = require('../lib/instagramAlerts');
const { syncAll: syncBannedWords } = require('../lib/bannedWords');
const { scheduleAllTempBans } = require('../lib/moderation');
const { startPoller: startRssAlerts } = require('../lib/rssAlerts');
const { startDashboard } = require('../lib/dashboard/server');
const { startRefreshTimer: startMemberCounters } = require('../lib/memberCounters');

module.exports = {
	name: Events.ClientReady,
	once: true,
	async execute(client) {
		console.log(`Logged in as ${client.user.tag}.`);

		// GuildCreate doesn't fire for guilds already joined during this initial
		// hydration (only for a new join or a guild recovering from an outage), so
		// every already-joined guild needs its own check here instead.
		for (const guild of client.guilds.cache.values()) {
			// No alert channel is created here any more (#92): the bot never makes a
			// channel nobody asked for. A dead-hub notice below simply has nowhere to
			// go until an admin sets a destination with /alerts channel, and
			// lib/alertDelivery.js logs that rather than failing silently.
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
		scheduleAllTempBans(client);
		startStreamAlerts(client);
		startInstagramAlerts(client);
		startRssAlerts(client);
		startDashboard(client);
		// Sweeps once now so counters are right after a restart, then every 20
		// minutes — Discord rate-limits channel renames (lib/memberCounters.js).
		startMemberCounters(client);
		await syncBannedWords(client);
	},
};
