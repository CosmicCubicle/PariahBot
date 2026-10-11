const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const instagramStore = require('../state/instagram');
const features = require('./features');
const guildSettings = require('../state/guildSettings');
const instagram = require('./instagram');
const { renderAlertContent } = require('./alertContent');

const INSTAGRAM_COLOR = 0xe1306c;

// Polled for the same reason as stream alerts (see lib/streamAlerts.js):
// Instagram's webhooks need a public HTTPS endpoint. Posts aren't
// time-critical the way a live stream is, and each followed account costs
// one API call per poll against the app's rate limit, so this is slower.
const POLL_INTERVAL_MS = 10 * 60 * 1000;

// Only posts this recent are announced. Bounds what a newly working poll
// (after an outage or a token fix) can dump into the channel at once, and is
// why announcements can be forgotten after 30 days (see state/instagram.js).
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

// Once a day is plenty — the retention window is 30 days.
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Long captions are cut down so one post doesn't fill the channel. Discord's
// own limit for an embed description is 4096.
const MAX_CAPTION_LENGTH = 500;

function truncate(text, max) {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// What a custom message (/instagram message) can fill in. See
// lib/alertContent.js for {role}.
const MESSAGE_PLACEHOLDERS = ['name', 'title', 'url', 'platform'];

// {title} is the caption's first line: a whole caption, hashtags and all,
// would swamp a one-line message.
const MAX_MESSAGE_TITLE_LENGTH = 200;

function buildPostMessage(account, post, pingRoleId, customMessage) {
	const action = post.isReel ? 'shared a new reel' : 'shared a new post';

	const embed = new EmbedBuilder()
		.setColor(INSTAGRAM_COLOR)
		.setAuthor({
			name: `${account.name} (@${account.username})`,
			url: `https://www.instagram.com/${account.username}/`,
			iconURL: account.profilePictureUrl ?? undefined,
		})
		.setURL(post.url)
		.setTitle(`@${account.username} ${action} on Instagram`)
		.setTimestamp(new Date(post.publishedAt));
	if (post.caption) embed.setDescription(truncate(post.caption, MAX_CAPTION_LENGTH));
	if (post.imageUrl) embed.setImage(post.imageUrl);

	const row = new ActionRowBuilder().addComponents(
		new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('View on Instagram').setURL(post.url),
	);

	return {
		content: renderAlertContent(customMessage, {
			name: `@${account.username}`,
			title: truncate(post.caption.split('\n')[0].trim(), MAX_MESSAGE_TITLE_LENGTH),
			url: post.url,
			platform: 'Instagram',
		}, pingRoleId),
		embeds: [embed],
		components: [row],
		// Only the configured role is ever pinged — a caption, or a custom
		// message, can contain @everyone or mentions that must not notify.
		allowedMentions: { parse: [], roles: pingRoleId ? [pingRoleId] : [] },
	};
}

async function announce(client, followed, account, post) {
	const guild = client.guilds.cache.get(followed.guildId);
	if (!guild) return;

	const { instagramChannelId, instagramRoleId, instagramMessage } = guildSettings.getGuildSettings(followed.guildId);
	if (!instagramChannelId) return;

	const channel = guild.channels.cache.get(instagramChannelId)
		?? await guild.channels.fetch(instagramChannelId).catch(() => null);

	// Recorded before sending, so a deleted channel or missing permission
	// doesn't retry (and log) the same post every poll for a week.
	instagramStore.markAnnounced(followed.guildId, post.id);

	if (!channel?.isTextBased()) {
		console.error(`InstagramAlerts: channel ${instagramChannelId} in guild ${followed.guildId} is missing — run /instagram channel again.`);
		return;
	}
	await channel.send(buildPostMessage(account, post, instagramRoleId, instagramMessage));
}

async function poll(client) {
	// Guilds with the feature switched off (#69) are dropped before any
	// external request, so they cost no API quota — not just no message.
	const followed = instagramStore.listAllAccounts()
		.filter((row) => features.isEnabled(row.guildId, 'instagram'));
	if (followed.length === 0) return;

	// The same account can be on several guilds' lists; ask Instagram once.
	const byAccountId = new Map();
	for (const row of followed) {
		if (!byAccountId.has(row.accountId)) byAccountId.set(row.accountId, []);
		byAccountId.get(row.accountId).push(row);
	}

	const cutoff = Date.now() - LOOKBACK_MS;
	for (const [accountId, rows] of byAccountId) {
		const { username } = rows[0];
		const result = await instagram.getRecentMedia(username).catch((error) => {
			console.error(`InstagramAlerts: @${username}: ${error.message}`);
			return null;
		});
		if (!result) continue;

		// Business Discovery only looks up by username. If the account renamed
		// and someone else took the name, this would announce a stranger's
		// posts — the stored ID is what catches it.
		if (result.account.id !== accountId) {
			console.error(`InstagramAlerts: @${username} now belongs to a different account — remove and re-add it with /instagram.`);
			continue;
		}

		// Oldest first, so several new posts land in the channel in order.
		const posts = [...result.media].reverse();
		for (const row of rows) {
			const since = Math.max(cutoff, Date.parse(row.addedAt));
			for (const post of posts) {
				if (Date.parse(post.publishedAt) < since) continue;
				if (instagramStore.isAnnounced(row.guildId, post.id)) continue;

				await announce(client, row, result.account, post).catch((error) => {
					console.error(`InstagramAlerts: failed to announce ${post.id} in guild ${row.guildId}:`, error.message);
				});
			}
		}
	}
}

let started = false;

// Called once from events/ready.js. With no credentials the feature stays off
// rather than failing every poll; /instagram explains what's missing.
function startPoller(client) {
	if (started) return;
	started = true;

	if (!instagram.isConfigured()) {
		console.log('InstagramAlerts: INSTAGRAM_ACCESS_TOKEN/INSTAGRAM_BUSINESS_ACCOUNT_ID not set — Instagram alerts are disabled.');
		return;
	}

	const prune = () => {
		try {
			instagramStore.pruneAnnouncements();
		} catch (error) {
			console.error('InstagramAlerts: failed to prune old announcements:', error.message);
		}
	};
	prune();
	setInterval(prune, PRUNE_INTERVAL_MS);

	// In-flight guard, as in lib/streamAlerts.js: overlapping polls would both
	// see the same unannounced post and send it twice.
	let polling = false;
	const run = async () => {
		if (polling) return;
		polling = true;
		try {
			await poll(client);
		} catch (error) {
			console.error('InstagramAlerts: poll failed:', error.message);
		} finally {
			polling = false;
		}
	};
	run();
	setInterval(run, POLL_INTERVAL_MS);
}

module.exports = { MESSAGE_PLACEHOLDERS, startPoller, buildPostMessage };
