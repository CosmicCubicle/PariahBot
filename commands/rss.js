const { SlashCommandBuilder, ChannelType, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const feedStore = require('../state/rssFeeds');
const { fetchFeed } = require('../lib/rss');
const { MESSAGE_PLACEHOLDERS, postItem } = require('../lib/rssAlerts');
const { MAX_TEMPLATE_LENGTH, unknownPlaceholders } = require('../lib/alertContent');
const { isAdmin, requireAdmin } = require('../lib/permissions');

const EMBED_COLOR = 0x5865f2;
const MAX_FEEDS_PER_GUILD = 25;
const MAX_URL_LENGTH = 500;
const MAX_AUTOCOMPLETE_CHOICES = 25;
// Discord caps autocomplete choice names and values at 100 characters.
const MAX_CHOICE_LENGTH = 100;
const MAX_FIELD_LENGTH = 1024;

// The feed option holds a feed's ID (what autocomplete submits). Looked up
// with this guild's ID, so a typed ID from another server finds nothing.
function requireFeed(interaction) {
	const feed = feedStore.getFeed(interaction.guildId, Number(interaction.options.getString('feed')));
	if (!feed) throw new Error("That isn't one of this server's feeds — pick one from the suggestions.");
	return feed;
}

async function handleAdd(interaction) {
	requireAdmin(interaction);

	const url = interaction.options.getString('url').trim();
	const channel = interaction.options.getChannel('channel');
	const pingRole = interaction.options.getRole('ping_role');
	const message = interaction.options.getString('message')?.trim() || null;

	// Checked up front so a missing permission surfaces now, to the admin,
	// rather than as a silent failure on the first new item.
	const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
	if (!channel.permissionsFor(interaction.guild.members.me).has(needed)) {
		throw new Error(`I can't post embeds in ${channel} — give me View Channel, Send Messages and Embed Links there, then run this again.`);
	}
	if (message) {
		const unknown = unknownPlaceholders(message, MESSAGE_PLACEHOLDERS);
		if (unknown.length) throw new Error(`I don't know ${unknown.join(', ')}. You can use {feed}, {title}, {url} and {role}.`);
	}
	if (feedStore.countFeeds(interaction.guildId) >= MAX_FEEDS_PER_GUILD) {
		throw new Error(`This server already follows ${MAX_FEEDS_PER_GUILD} feeds, the most it can. Remove one with \`/rss remove\` first.`);
	}
	const existing = feedStore.getFeedByUrl(interaction.guildId, url);
	if (existing) {
		throw new Error(`This server already follows that feed (**${existing.title}**, posting in <#${existing.channelId}>). Remove it first to change its settings.`);
	}

	// Fetching is a network round trip that can outlast Discord's 3-second
	// window. It also proves the address really is a feed, now rather than
	// silently never posting.
	await interaction.deferReply({ ephemeral: true });
	let parsed;
	try {
		parsed = await fetchFeed(url);
	} catch (error) {
		throw new Error(`Couldn't add that feed: ${error.message}`);
	}

	// Everything it lists now is recorded as seen, so only items published
	// from here on are posted.
	feedStore.addFeed({
		guildId: interaction.guildId,
		url,
		title: parsed.title,
		channelId: channel.id,
		roleId: pingRole?.id,
		message,
		itemIds: parsed.items.map((item) => item.id),
	});

	const lines = [`Following **${parsed.title}** — new items will post in ${channel}${pingRole ? `, pinging ${pingRole}` : ''}.`];
	lines.push(parsed.items.length
		? `It has ${parsed.items.length} item${parsed.items.length === 1 ? '' : 's'} already; those won't be posted. Use \`/rss test\` to see how a post looks.`
		: "It doesn't list any items yet. The first one will be posted when it appears.");
	lines.push('Feeds are checked every 10 minutes.');
	if (pingRole && !pingRole.mentionable && !interaction.guild.members.me.permissions.has(PermissionFlagsBits.MentionEveryone)) {
		lines.push(`⚠️ ${pingRole} isn't mentionable, so the ping won't notify anyone. Turn on "Allow anyone to @mention this role" in its settings, or give me Mention Everyone.`);
	}
	await interaction.editReply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
}

async function handleRemove(interaction) {
	requireAdmin(interaction);
	const feed = requireFeed(interaction);
	feedStore.removeFeed(interaction.guildId, feed.id);
	await interaction.reply({ content: `Stopped following **${feed.title}**.`, ephemeral: true });
}

async function handleTest(interaction) {
	requireAdmin(interaction);
	const feed = requireFeed(interaction);

	await interaction.deferReply({ ephemeral: true });
	let parsed;
	try {
		parsed = await fetchFeed(feed.url);
	} catch (error) {
		throw new Error(`Couldn't read **${feed.title}**: ${error.message}`);
	}
	const newest = parsed.items.at(-1);
	if (!newest) throw new Error(`**${parsed.title}** doesn't list any items right now, so there's nothing to post.`);

	// Posted for real, ping and all — that's what's being tested. It doesn't
	// change what counts as new.
	try {
		await postItem(interaction.client, feed, parsed, newest);
	} catch (error) {
		throw new Error(`Couldn't post: ${error.message}`);
	}
	await interaction.editReply({ content: `Posted the newest item from **${parsed.title}** in <#${feed.channelId}>.` });
}

function describeFeed(feed) {
	const parts = [`<#${feed.channelId}>`];
	if (feed.roleId) parts.push(`pings <@&${feed.roleId}>`);
	if (feed.message) parts.push('custom message');
	parts.push(feed.lastCheckedAt ? `checked <t:${Math.floor(Date.parse(feed.lastCheckedAt) / 1000)}:R>` : 'not checked yet');
	const status = feed.lastError ? `\n⚠️ ${feed.lastError}` : '';
	return `**${feed.title}** · ${parts.join(' · ')}\n${feed.url}${status}`;
}

async function handleList(interaction) {
	requireAdmin(interaction);
	const feeds = feedStore.listFeedsForGuild(interaction.guildId);

	const embed = new EmbedBuilder()
		.setTitle(`RSS feeds (${feeds.length} of ${MAX_FEEDS_PER_GUILD})`)
		.setColor(EMBED_COLOR);
	if (feeds.length === 0) {
		embed.setDescription('No feeds yet. Add one with `/rss add`.');
	} else {
		// One field per feed, each within Discord's 1,024-character field limit.
		embed.addFields(feeds.map((feed) => ({ name: '​', value: describeFeed(feed).slice(0, MAX_FIELD_LENGTH) })));
	}
	await interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
}

const HANDLERS = {
	add: handleAdd,
	remove: handleRemove,
	test: handleTest,
	list: handleList,
};

function feedOption(option, description) {
	return option
		.setName('feed')
		.setDescription(description)
		.setAutocomplete(true)
		.setRequired(true);
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName('rss')
		.setDescription('Post new items from RSS and Atom feeds into channels.')
		.addSubcommand((sub) => sub
			.setName('add')
			.setDescription('(Admin) Follow a feed. Only items published from now on are posted.')
			.addStringOption((option) => option
				.setName('url')
				.setDescription('The feed address, e.g. https://example.com/feed')
				.setMaxLength(MAX_URL_LENGTH)
				.setRequired(true))
			.addChannelOption((option) => option
				.setName('channel')
				.setDescription('Where new items post')
				.addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
				.setRequired(true))
			.addRoleOption((option) => option
				.setName('ping_role')
				.setDescription('Role to ping with each item (optional)')
				.setRequired(false))
			.addStringOption((option) => option
				.setName('message')
				.setDescription('Custom text (optional). Placeholders: {feed} {title} {url} {role}')
				.setMaxLength(MAX_TEMPLATE_LENGTH)
				.setRequired(false)))
		.addSubcommand((sub) => sub
			.setName('remove')
			.setDescription('(Admin) Stop following a feed.')
			.addStringOption((option) => feedOption(option, 'The feed to remove (pick from the suggestions)')))
		.addSubcommand((sub) => sub
			.setName('test')
			.setDescription("(Admin) Post a feed's newest item now, to check how it looks.")
			.addStringOption((option) => feedOption(option, 'The feed to test (pick from the suggestions)')))
		.addSubcommand((sub) => sub
			.setName('list')
			.setDescription("(Admin) Show this server's feeds, their channels, and any errors.")),
	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();
		const handler = HANDLERS[subcommand];
		if (!handler) throw new Error(`Unknown /rss subcommand: ${subcommand}`);
		await handler(interaction);
	},
	// Suggestions for the feed option — this guild's feeds only, for admins.
	// Not a security boundary on its own, which is why requireFeed also
	// scopes by guild.
	async autocomplete(interaction) {
		if (!isAdmin(interaction.member, interaction.guildId)) {
			await interaction.respond([]);
			return;
		}
		const typed = interaction.options.getFocused().toLowerCase();
		const choices = feedStore.listFeedsForGuild(interaction.guildId)
			.filter((feed) => feed.title.toLowerCase().includes(typed) || feed.url.toLowerCase().includes(typed))
			.slice(0, MAX_AUTOCOMPLETE_CHOICES)
			.map((feed) => ({ name: `${feed.title} — ${feed.url}`.slice(0, MAX_CHOICE_LENGTH), value: String(feed.id) }));
		await interaction.respond(choices);
	},
};
