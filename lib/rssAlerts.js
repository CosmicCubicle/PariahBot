const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const feedStore = require('../state/rssFeeds');
const { fetchFeed } = require('./rss');
const { renderAlertContent } = require('./alertContent');

const RSS_COLOR = 0xf26522;

// Polled, like every other alert source here. Feeds rarely update more than
// a few times an hour, and many ask readers not to poll faster than this.
const POLL_INTERVAL_MS = 10 * 60 * 1000;

// Once a day is plenty — items are kept 30 days after leaving their feed.
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// A feed that suddenly lists dozens of new items (a site migration, a feed
// that rewrote its IDs) would otherwise flood the channel. The rest are
// still marked seen, and the last post says how many were skipped.
const MAX_POSTS_PER_CHECK = 5;

const MAX_SUMMARY_LENGTH = 300;

// What a custom message (/rss add message:) can fill in. See
// lib/alertContent.js for {role}.
const MESSAGE_PLACEHOLDERS = ['feed', 'title', 'url'];

function truncate(text, max) {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function buildItemMessage(feed, feedTitle, feedLink, item, skipped = 0) {
	const embed = new EmbedBuilder()
		.setColor(RSS_COLOR)
		.setAuthor({ name: truncate(feedTitle, 256), url: feedLink ?? undefined })
		.setTitle(truncate(item.title || 'Untitled', 256));
	if (item.link) embed.setURL(item.link);
	if (item.summary) embed.setDescription(truncate(item.summary, MAX_SUMMARY_LENGTH));
	if (item.imageUrl) embed.setImage(item.imageUrl);
	if (item.publishedAt) embed.setTimestamp(new Date(item.publishedAt));
	if (skipped) embed.setFooter({ text: `${skipped} older new item${skipped === 1 ? ' was' : 's were'} skipped to avoid flooding the channel.` });

	const message = {
		content: renderAlertContent(feed.message, { feed: feedTitle, title: item.title, url: item.link ?? '' }, feed.roleId),
		embeds: [embed],
		// Only the feed's ping role ever notifies anyone — a feed's titles, or
		// a custom message, can contain @everyone.
		allowedMentions: { parse: [], roles: feed.roleId ? [feed.roleId] : [] },
	};
	// Discord rejects link buttons longer than 512 characters.
	if (item.link && item.link.length <= 512) {
		message.components = [new ActionRowBuilder().addComponents(
			new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Read more').setURL(item.link),
		)];
	}
	return message;
}

async function resolveChannel(client, feed) {
	const guild = client.guilds.cache.get(feed.guildId);
	if (!guild) return null;
	const channel = guild.channels.cache.get(feed.channelId) ?? await guild.channels.fetch(feed.channelId).catch(() => null);
	return channel?.isTextBased() ? channel : null;
}

// Also used by /rss test.
async function postItem(client, feed, parsed, item, skipped = 0) {
	const channel = await resolveChannel(client, feed);
	if (!channel) throw new Error(`its channel <#${feed.channelId}> is gone, or I can't see it — remove the feed and add it again with a channel I can post in.`);
	await channel.send(buildItemMessage(feed, parsed.title, parsed.link, item, skipped));
}

// Logged when a feed's error changes, not on every check, so a dead feed
// doesn't fill the log every 10 minutes.
function recordError(feed, error) {
	if (feed.lastError !== error) {
		console.error(`RssAlerts: feed ${feed.id} (${feed.url}) in guild ${feed.guildId}: ${error}`);
	}
	feedStore.setFeedStatus(feed.id, { error });
}

async function checkFeed(client, feed, parsed) {
	const seen = feedStore.listSeenItemIds(feed.id);
	const fresh = parsed.items.filter((item) => !seen.has(item.id));

	// Recorded before posting, as stream alerts do: a broken channel must not
	// make every check try the same items again.
	feedStore.markItemsSeen(feed.id, parsed.items.map((item) => item.id));

	const toPost = fresh.slice(-MAX_POSTS_PER_CHECK);
	const skipped = fresh.length - toPost.length;
	for (const [index, item] of toPost.entries()) {
		await postItem(client, feed, parsed, item, index === toPost.length - 1 ? skipped : 0);
	}
}

async function poll(client) {
	const feeds = feedStore.listAllFeeds();
	const byUrl = new Map();
	for (const feed of feeds) {
		if (!byUrl.has(feed.url)) byUrl.set(feed.url, []);
		byUrl.get(feed.url).push(feed);
	}

	for (const [url, group] of byUrl) {
		let parsed;
		try {
			parsed = await fetchFeed(url);
		} catch (error) {
			for (const feed of group) recordError(feed, `Couldn't read the feed: ${error.message}`);
			continue;
		}

		for (const feed of group) {
			try {
				await checkFeed(client, feed, parsed);
				feedStore.setFeedStatus(feed.id, { title: parsed.title });
			} catch (error) {
				recordError(feed, `Couldn't post: ${error.message}`);
			}
		}
	}
}

let started = false;

// Called once from events/ready.js. Needs no credentials, so it always runs.
function startPoller(client) {
	if (started) return;
	started = true;

	const prune = () => {
		try {
			feedStore.pruneItems();
		} catch (error) {
			console.error('RssAlerts: failed to prune old items:', error.message);
		}
	};
	prune();
	setInterval(prune, PRUNE_INTERVAL_MS);

	// In-flight guard, as in lib/streamAlerts.js: overlapping polls would both
	// see the same new item and post it twice.
	let polling = false;
	const run = async () => {
		if (polling) return;
		polling = true;
		try {
			await poll(client);
		} catch (error) {
			console.error('RssAlerts: poll failed:', error.message);
		} finally {
			polling = false;
		}
	};
	run();
	setInterval(run, POLL_INTERVAL_MS);
}

module.exports = { MESSAGE_PLACEHOLDERS, startPoller, postItem, buildItemMessage };
