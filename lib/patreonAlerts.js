const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const patreonStore = require('../state/patreon');
const features = require('./features');
const guildSettings = require('../state/guildSettings');
const patreon = require('./patreon');
const { renderAlertContent, pingMentions } = require('./alertContent');

const PATREON_COLOR = 0xff424d;

// Polled, like Instagram (see lib/instagramAlerts.js): posts aren't
// time-critical, and each followed creator is one request to Patreon per poll.
const POLL_INTERVAL_MS = 10 * 60 * 1000;

// Only posts this recent are announced. Bounds what a newly working poll can
// dump into the channel at once, and is why announcements can be forgotten
// after 30 days (see state/patreon.js).
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Discord's limit for an embed title is 256; the teaser is cut well short of
// the 4096 description limit so one post doesn't fill the channel.
const MAX_TITLE_LENGTH = 256;
const MAX_TEASER_LENGTH = 500;

// What a custom message (/patreon message) can fill in. See
// lib/alertContent.js for {role}.
const MESSAGE_PLACEHOLDERS = ['name', 'title', 'url', 'platform'];

function truncate(text, max) {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Everything here comes from lib/patreon.js's mapPost, which only ever holds
// a post's public preview — see the top of that file. Don't add fields to the
// embed that it doesn't provide.
function buildPostMessage(campaign, post, pingRoleId, customMessage) {
	const embed = new EmbedBuilder()
		.setColor(PATREON_COLOR)
		.setAuthor({ name: campaign.name, url: campaign.url, iconURL: campaign.avatarUrl ?? undefined })
		.setURL(post.url)
		.setTitle(truncate(post.title, MAX_TITLE_LENGTH))
		.addFields({ name: 'Access', value: post.isPublic ? 'Public — anyone can read it' : '🔒 Patrons only — this is the public preview', inline: true })
		.setFooter({ text: 'Patreon' })
		.setTimestamp(new Date(post.publishedAt));
	if (post.teaser) embed.setDescription(truncate(post.teaser, MAX_TEASER_LENGTH));
	if (post.imageUrl) embed.setImage(post.imageUrl);

	const row = new ActionRowBuilder().addComponents(
		new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('View on Patreon').setURL(post.url),
	);

	return {
		content: renderAlertContent(customMessage, {
			name: campaign.name,
			title: post.title,
			url: post.url,
			platform: 'Patreon',
		}, pingRoleId),
		embeds: [embed],
		components: [row],
		// Only the configured role is ever pinged — a post title, or a custom
		// message, can contain @everyone or mentions that must not notify.
		allowedMentions: pingMentions(pingRoleId),
	};
}

async function announce(client, followed, campaign, post) {
	const guild = client.guilds.cache.get(followed.guildId);
	if (!guild) return;

	const { patreonChannelId, patreonRoleId, patreonMessage } = guildSettings.getGuildSettings(followed.guildId);
	if (!patreonChannelId) return;

	const channel = guild.channels.cache.get(patreonChannelId)
		?? await guild.channels.fetch(patreonChannelId).catch(() => null);

	// Recorded before sending, so a deleted channel or missing permission
	// doesn't retry (and log) the same post every poll for a week.
	patreonStore.markAnnounced(followed.guildId, post.id);

	if (!channel?.isTextBased()) {
		console.error(`PatreonAlerts: channel ${patreonChannelId} in guild ${followed.guildId} is missing — run /patreon channel again.`);
		return;
	}
	// A creator Patreon marks as adult only posts into an age-restricted
	// channel, even though the preview is public.
	if (campaign.isNsfw && !channel.nsfw) {
		console.error(`PatreonAlerts: ${campaign.name} is marked 18+ on Patreon, so its post wasn't shared in non-age-restricted channel ${patreonChannelId} (guild ${followed.guildId}).`);
		return;
	}
	await channel.send(buildPostMessage(campaign, post, patreonRoleId, patreonMessage));
}

async function poll(client) {
	// Guilds with the feature switched off (#69) are dropped before any
	// external request.
	const followed = patreonStore.listAllCreators()
		.filter((row) => features.isEnabled(row.guildId, 'patreon'));
	if (followed.length === 0) return;

	// The same creator can be on several guilds' lists; ask Patreon once.
	const byCampaignId = new Map();
	for (const row of followed) {
		if (!byCampaignId.has(row.campaignId)) byCampaignId.set(row.campaignId, []);
		byCampaignId.get(row.campaignId).push(row);
	}

	const cutoff = Date.now() - LOOKBACK_MS;
	for (const [campaignId, rows] of byCampaignId) {
		const label = rows[0].name;
		const result = await patreon.getRecentPosts(campaignId).catch((error) => {
			console.error(`PatreonAlerts: ${label}: ${error.message}`);
			return null;
		});
		if (!result) continue;
		const campaign = result.campaign ?? { name: label, url: `https://www.patreon.com/${rows[0].vanity ?? ''}`, avatarUrl: null, isNsfw: false };

		// Oldest first, so several new posts land in the channel in order.
		const posts = [...result.posts].reverse();
		for (const row of rows) {
			const since = Math.max(cutoff, Date.parse(row.addedAt));
			for (const post of posts) {
				if (Date.parse(post.publishedAt) < since) continue;
				if (patreonStore.isAnnounced(row.guildId, post.id)) continue;

				await announce(client, row, campaign, post).catch((error) => {
					console.error(`PatreonAlerts: failed to announce ${post.id} in guild ${row.guildId}:`, error.message);
				});
			}
		}
	}
}

let started = false;

// Called once from events/ready.js. Needs no credentials, so it always runs;
// with nobody following a creator, a poll makes no requests at all.
function startPoller(client) {
	if (started) return;
	started = true;

	const prune = () => {
		try {
			patreonStore.pruneAnnouncements();
		} catch (error) {
			console.error('PatreonAlerts: failed to prune old announcements:', error.message);
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
			console.error('PatreonAlerts: poll failed:', error.message);
		} finally {
			polling = false;
		}
	};
	run();
	setInterval(run, POLL_INTERVAL_MS);
}

module.exports = { MESSAGE_PLACEHOLDERS, startPoller, buildPostMessage };
