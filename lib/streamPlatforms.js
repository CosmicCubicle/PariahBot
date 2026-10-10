const twitch = require('./twitch');
const youtube = require('./youtube');

// Everything that differs per platform, in one place, so adding a third
// platform is a new entry here plus a client in lib/ and a poller in
// lib/streamAlerts.js. Shared by /streamers and the admin dashboard.
const PLATFORMS = {
	twitch: {
		label: 'Twitch',
		envVars: 'TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET',
		client: twitch,
		describe: (name) => `twitch.tv/${name}`,
		link: (name) => `https://www.twitch.tv/${name}`,
		// Returns { id, name } or throws a message the user can act on.
		async resolve(raw) {
			const login = raw.trim().replace(/^@/, '');
			if (!twitch.isValidLogin(login)) {
				throw new Error(`"${login}" isn't a valid Twitch username — it should be 4–25 letters, numbers or underscores, as it appears in twitch.tv/<username>.`);
			}
			const account = await twitch.getUserByLogin(login);
			if (!account) {
				throw new Error(`Couldn't find a Twitch account called "${login}". Check the spelling against the twitch.tv/<username> link.`);
			}
			return { id: account.id, name: account.login };
		},
	},
	youtube: {
		label: 'YouTube',
		envVars: 'YOUTUBE_API_KEY',
		client: youtube,
		describe: (name) => `${name} (YouTube)`,
		link: (name, id) => `https://www.youtube.com/channel/${id}`,
		async resolve(raw) {
			if (!youtube.parseChannelInput(raw)) {
				throw new Error(`"${raw}" doesn't look like a YouTube channel — use its @handle, its youtube.com/@handle link, or its UC… channel ID.`);
			}
			const channel = await youtube.resolveChannel(raw);
			if (!channel) {
				throw new Error(`Couldn't find a YouTube channel for "${raw}". Copy the @handle from the channel's page and try again.`);
			}
			return channel;
		},
	},
};

// Throws a message the user can act on when a platform has no credentials.
function requireConfigured(platform) {
	const { label, envVars, client } = PLATFORMS[platform];
	if (!client.isConfigured()) {
		throw new Error(`${label} isn't set up on this bot's host yet — the bot owner needs to add ${envVars} to hom.env and restart it.`);
	}
}

module.exports = { PLATFORMS, requireConfigured };
