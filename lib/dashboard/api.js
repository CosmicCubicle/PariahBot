const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { ChannelType, OverwriteType, PermissionFlagsBits } = require('discord.js');
const guildSettings = require('../../state/guildSettings');
const bannedWordStore = require('../../state/bannedWords');
const streamerStore = require('../../state/streamers');
const instagramStore = require('../../state/instagram');
const feedStore = require('../../state/rssFeeds');
const autoDeleteStore = require('../../state/autoDeleteChannels');
const caseStore = require('../../state/modCases');
const tempBanStore = require('../../state/tempBans');
const giveawayStore = require('../../state/giveaways');
const voiceStore = require('../../state/voiceChannels');
const levelStore = require('../../state/levels');
const commandLogger = require('../../logging/commandLogger');
const bannedWords = require('../bannedWords');
const { LISTS } = require('../bannedWordLists');
const features = require('../features');
const invitePermissions = require('../invitePermissions');
const { PLATFORMS, requireConfigured } = require('../streamPlatforms');
const streamAlerts = require('../streamAlerts');
const instagram = require('../instagram');
const instagramAlerts = require('../instagramAlerts');
const rssAlerts = require('../rssAlerts');
const autoDelete = require('../autoDelete');
const serverLog = require('../serverLog');
const { messageContentEnabled } = require('../intents');
const logStore = require('../../state/serverLog');
const moderation = require('../moderation');
const giveaways = require('../giveaways');
const voiceHubs = require('../voiceHubs');
const { OWNER_CONTROLS, listTempChannels, closeTempChannel, transferTempChannel } = require('../tempVoice');
const { MAX_TEMPLATE_LENGTH, unknownPlaceholders } = require('../alertContent');
const { parseDuration, formatDuration, compactDuration } = require('../duration');
const permissionTools = require('../permissionTools');

// The admin dashboard's JSON API: a status snapshot, one server's settings,
// and the actions that change them. lib/dashboard/server.js has already
// checked the session, and that the caller may manage the server in question
// (lib/dashboard/access.js), before anything here runs. The status snapshot
// covers every server, so it's for the bot's owner only.
//
// Every ID the page sends — channel, role, user, feed, case — is untrusted
// input, exactly like a slash command's string option, and is checked against
// the server it's meant for before it's used (WorkingAgreements.md § 2).

const RECENT_CASES = 25;
const LEADERBOARD_SIZE = 10;
const MAX_APPEAL_NOTE_LENGTH = 300;

const SNOWFLAKE = /^\d{17,20}$/;
const TEXT_CHANNEL_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const POST_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

// Read once: the deployed commit doesn't change while the process runs.
let commit = null;
try {
	commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {
	commit = null;
}

// --- Checking what the page sent -------------------------------------------

function requireGuild(client, guildId) {
	const guild = SNOWFLAKE.test(guildId ?? '') ? client.guilds.cache.get(guildId) : null;
	if (!guild) throw new Error("PariahBot isn't in that server.");
	return guild;
}

function requireChannel(guild, channelId) {
	const channel = SNOWFLAKE.test(channelId ?? '') ? guild.channels.cache.get(channelId) : null;
	if (!channel || !TEXT_CHANNEL_TYPES.has(channel.type)) throw new Error("That channel isn't a text channel in this server.");
	return channel;
}

function optionalChannel(guild, channelId) {
	return channelId ? requireChannel(guild, channelId) : null;
}

function requirePostableChannel(guild, channelId) {
	const channel = requireChannel(guild, channelId);
	if (!channel.permissionsFor(guild.members.me).has(POST_PERMISSIONS)) {
		throw new Error(`I can't post embeds in #${channel.name} — give me View Channel, Send Messages and Embed Links there.`);
	}
	return channel;
}

function requireCategory(guild, categoryId) {
	const category = SNOWFLAKE.test(categoryId ?? '') ? guild.channels.cache.get(categoryId) : null;
	if (!category || category.type !== ChannelType.GuildCategory) throw new Error("That category isn't in this server.");
	return category;
}

function requireRole(guild, roleId) {
	const role = SNOWFLAKE.test(roleId ?? '') ? guild.roles.cache.get(roleId) : null;
	if (!role || role.id === guild.id) throw new Error("That role isn't in this server.");
	return role;
}

// /perms (#100): any channel type it works on, including categories and
// voice, unlike requireChannel's text-only check.
function requirePermsChannel(guild, channelId) {
	const channel = SNOWFLAKE.test(channelId ?? '') ? guild.channels.cache.get(channelId) : null;
	if (!channel || !permissionTools.PERMS_CHANNEL_TYPES.includes(channel.type)) throw new Error("That channel isn't in this server.");
	return channel;
}

// The dashboard targets roles, including @everyone (whose ID is the
// server's). Picking members would need the member list, which the page
// doesn't have; /perms in Discord covers them.
function requirePermsTarget(guild, roleId) {
	const role = roleId === guild.id ? guild.roles.everyone : requireRole(guild, roleId);
	return { id: role.id, type: OverwriteType.Role, role, label: role.id === guild.id ? '@everyone' : `@${role.name}` };
}

// Who is acting, as a member of this server, for the same checks /perms
// makes: seeing the channel, and outranking a role being copied onto. Null
// for the bot's owner when they aren't in the server, who the dashboard
// already lets manage it (lib/dashboard/access.js).
async function permsInvoker(guild, user) {
	return guild.members.fetch(user.id).catch(() => null);
}

function requireInvokerSees(member, channel) {
	if (member && !channel.permissionsFor(member).has(PermissionFlagsBits.ViewChannel)) {
		throw new Error(`You can't see #${channel.name} yourself, so the dashboard won't act on it for you.`);
	}
}

// The warning /streamers, /instagram and /rss give for a ping role that won't
// notify anyone, for the dashboard's replies. Empty when the ping will work.
function mentionNote(guild, role) {
	if (!role || role.mentionable || guild.members.me.permissions.has(PermissionFlagsBits.MentionEveryone)) return '';
	return ` @${role.name} isn't mentionable, so the ping won't notify anyone: turn on "Allow anyone to @mention this role" in its settings, or give the bot Mention Everyone.`;
}

function optionalRole(guild, roleId) {
	return roleId ? requireRole(guild, roleId) : null;
}

function requireString(value, label, max) {
	if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
	if (value.length > max) throw new Error(`${label} can be at most ${max} characters.`);
	return value.trim();
}

function optionalString(value, label, max) {
	return value == null || value === '' ? null : requireString(value, label, max);
}

function requireMessage(text, placeholders, names) {
	const message = optionalString(text, 'The message', MAX_TEMPLATE_LENGTH);
	if (message) {
		const unknown = unknownPlaceholders(message, placeholders);
		if (unknown.length) throw new Error(`Unknown placeholder ${unknown.join(', ')}. You can use ${names}.`);
	}
	return message;
}

// --- Snapshots ---------------------------------------------------------------

function userName(client, guild, userId) {
	return guild.members.cache.get(userId)?.displayName ?? client.users.cache.get(userId)?.username ?? null;
}

function status(client) {
	const feeds = feedStore.listAllFeeds();
	return {
		bot: { id: client.user.id, tag: client.user.tag, avatar: client.user.displayAvatarURL({ size: 64 }) },
		readySince: client.readyAt?.toISOString() ?? null,
		uptimeSeconds: Math.floor(process.uptime()),
		pingMs: client.ws.ping,
		memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
		node: process.version,
		commit,
		guilds: client.guilds.cache.size,
		integrations: {
			twitch: PLATFORMS.twitch.client.isConfigured(),
			youtube: PLATFORMS.youtube.client.isConfigured(),
			instagram: instagram.isConfigured(),
			logChannel: Boolean(process.env.LOG_CHANNEL_ID || process.env.LOG_CHANNEL_SUCCESS_ID || process.env.LOG_CHANNEL_ERROR_ID),
			serverLogMessageText: messageContentEnabled(),
		},
		feedErrors: feeds.filter((feed) => feed.lastError).map((feed) => ({
			guild: client.guilds.cache.get(feed.guildId)?.name ?? feed.guildId,
			title: feed.title,
			error: feed.lastError,
		})),
		pendingTempBans: tempBanStore.listTempBans().length,
		// Everything the invite builder needs (#91), so the page can rebuild the
		// link as features are ticked without a round trip each time. Bitfields
		// go as strings: they are past 2^53 and JSON would round them.
		invite: {
			clientId: client.user.id,
			base: invitePermissions.bitsFor([]).toString(),
			// The opt-in conveniences layer, sent as its own bitfield so the page
			// can add or drop it without re-deriving anything.
			extras: invitePermissions.RECOMMENDED_EXTRAS.reduce((total, flag) => total | flag, 0n).toString(),
			features: invitePermissions.catalogue().map((entry) => ({
				...entry,
				bits: invitePermissions.bitsFor([entry.key]).toString(),
			})),
		},
	};
}

// The guilds passed in are the ones this user may manage — see
// lib/dashboard/access.js.
function guildList(guilds) {
	return guilds.map((guild) => ({ id: guild.id, name: guild.name, icon: guild.iconURL({ size: 64 }), memberCount: guild.memberCount }));
}

function guildSnapshot(client, guild) {
	const settings = guildSettings.getGuildSettings(guild.id);
	const me = guild.members.me;
	const name = (userId) => userName(client, guild, userId);

	return {
		id: guild.id,
		name: guild.name,
		icon: guild.iconURL({ size: 64 }),
		memberCount: guild.memberCount,
		// Every switchable feature set and its current state (#69), from one
		// query. The page needs the whole list, not just the off ones, to render
		// a switch per feature.
		features: features.list(guild.id),
		permissions: {
			manageGuild: me.permissions.has(PermissionFlagsBits.ManageGuild),
			manageChannels: me.permissions.has(PermissionFlagsBits.ManageChannels),
			manageRoles: me.permissions.has(PermissionFlagsBits.ManageRoles),
			manageMessages: me.permissions.has(PermissionFlagsBits.ManageMessages),
			kickMembers: me.permissions.has(PermissionFlagsBits.KickMembers),
			banMembers: me.permissions.has(PermissionFlagsBits.BanMembers),
			moderateMembers: me.permissions.has(PermissionFlagsBits.ModerateMembers),
			mentionEveryone: me.permissions.has(PermissionFlagsBits.MentionEveryone),
			viewAuditLog: me.permissions.has(PermissionFlagsBits.ViewAuditLog),
		},
		channels: [...guild.channels.cache.values()]
			.filter((channel) => TEXT_CHANNEL_TYPES.has(channel.type))
			.sort((a, b) => a.rawPosition - b.rawPosition)
			.map((channel) => ({ id: channel.id, name: channel.name, canPost: channel.permissionsFor(me).has(POST_PERMISSIONS) })),
		// Managed roles (a bot's own, or an integration's like Twitch
		// Subscriber) are sent too, flagged: the page leaves them out of pickers
		// that grant a role, which the bot can't do with them, but they can be
		// pinged and given channel overrides (#102).
		roles: [...guild.roles.cache.values()]
			.filter((role) => role.id !== guild.id)
			.sort((a, b) => b.position - a.position)
			.map((role) => ({
				id: role.id,
				name: role.name,
				color: role.hexColor,
				belowBot: role.position < me.roles.highest.position,
				managed: role.managed,
				mentionable: role.mentionable,
			})),
		// Every channel and category /perms can act on, in server order.
		permissionTools: {
			channels: [...guild.channels.cache.values()]
				.filter((channel) => permissionTools.PERMS_CHANNEL_TYPES.includes(channel.type))
				.sort((a, b) => a.rawPosition - b.rawPosition)
				.map((channel) => ({ id: channel.id, name: channel.name, category: channel.type === ChannelType.GuildCategory })),
			copyModes: permissionTools.COPY_MODES,
		},
		alerts: {
			channelId: settings.alertChannelId,
			defaultChannelId: settings.defaultChannelId,
			recipients: guildSettings.listAlertRecipients(guild.id).map((id) => ({ id, name: name(id) })),
		},
		serverRoles: {
			memberRoleId: settings.memberRoleId,
			streamerRoleId: settings.streamerRoleId,
			adminRoleIds: guildSettings.listAdminRoles(guild.id),
			modRoleIds: guildSettings.listModRoles(guild.id),
		},
		bannedWords: {
			enabled: features.isEnabled(guild.id, 'bannedWords'),
			lists: bannedWordStore.listLists(guild.id),
			available: Object.entries(LISTS).map(([key, list]) => ({ key, label: list.label, description: list.description, discord: Boolean(list.preset) })),
			words: bannedWordStore.listWords(guild.id),
			maxWords: bannedWords.MAX_CUSTOM_WORDS,
		},
		streams: {
			channelId: settings.streamAlertChannelId,
			roleIds: guildSettings.listStreamPingRoles(guild.id),
			maxRoles: streamAlerts.MAX_STREAM_PING_ROLES,
			message: settings.streamAlertMessage,
			platforms: Object.entries(PLATFORMS).map(([key, platform]) => ({ key, label: platform.label, configured: platform.client.isConfigured() })),
			links: streamerStore.listLinksForGuild(guild.id).map((link) => ({ ...link, memberName: link.userId ? name(link.userId) : null })),
		},
		instagram: {
			configured: instagram.isConfigured(),
			channelId: settings.instagramChannelId,
			roleId: settings.instagramRoleId,
			message: settings.instagramMessage,
			accounts: instagramStore.listAccountsForGuild(guild.id),
		},
		rss: { max: rssAlerts.MAX_FEEDS_PER_GUILD, feeds: feedStore.listFeedsForGuild(guild.id) },
		autoDelete: autoDeleteStore.listChannelsForGuild(guild.id).map((entry) => ({
			...entry,
			duration: entry.liveSeconds ? formatDuration(entry.liveSeconds) : null,
		})),
		moderation: {
			escalation: settings.warnEscalation
				? {
					...settings.warnEscalation,
					within: compactDuration(settings.warnEscalation.windowSeconds),
					timeout: compactDuration(settings.warnEscalation.timeoutSeconds),
					description: `${settings.warnEscalation.count} warnings within ${formatDuration(settings.warnEscalation.windowSeconds)} → timed out for ${formatDuration(settings.warnEscalation.timeoutSeconds)}`,
				}
				: null,
			appealNote: settings.banAppealNote,
			recentCases: caseStore.listRecentCasesForGuild(guild.id, RECENT_CASES).map((entry) => ({
				...entry,
				label: moderation.CASE_LABELS[entry.action] ?? entry.action,
				userName: name(entry.userId),
				moderatorName: entry.moderatorId ? name(entry.moderatorId) : 'PariahBot',
				duration: entry.durationSeconds ? formatDuration(entry.durationSeconds) : null,
			})),
			tempBans: tempBanStore.listTempBans().filter((ban) => ban.guildId === guild.id).map((ban) => ({ ...ban, userName: name(ban.userId) })),
		},
		giveaways: giveawayStore.listActiveGiveaways().filter((giveaway) => giveaway.guildId === guild.id).map((giveaway) => ({
			...giveaway,
			entries: giveawayStore.getEntries(giveaway.id).length,
		})),
		voice: {
			ownerControls: Object.entries(OWNER_CONTROLS).map(([key, control]) => ({ key, ...control, allowed: settings.ownerControls[key] })),
			hubs: voiceStore.listHubs(guild.id).map((hub) => {
				const channel = guild.channels.cache.get(hub.channelId);
				return {
					...hub,
					name: channel?.name ?? null,
					exists: Boolean(channel),
					categoryName: hub.categoryId ? guild.channels.cache.get(hub.categoryId)?.name ?? null : null,
				};
			}),
			tempChannels: listTempChannels(guild),
			voiceChannels: [...guild.channels.cache.values()]
				.filter((channel) => channel.type === ChannelType.GuildVoice)
				.sort((a, b) => a.rawPosition - b.rawPosition)
				.map((channel) => ({ id: channel.id, name: channel.name })),
			categories: [...guild.channels.cache.values()]
				.filter((channel) => channel.type === ChannelType.GuildCategory)
				.sort((a, b) => a.rawPosition - b.rawPosition)
				.map((channel) => ({ id: channel.id, name: channel.name })),
			maxLimit: voiceHubs.MAX_LIMIT,
		},
		security: {
			screeningChannelId: settings.screeningChannelId,
			honeypotChannelId: settings.honeypotChannelId,
			honeypotAction: settings.honeypotAction,
		},
		levels: levelStore.listTopForGuild(guild.id, LEADERBOARD_SIZE).map((row) => ({ ...row, name: name(row.userId) })),
		// The server log (#81): each section with its switch, channel and
		// anything stopping it, worded as fixes.
		logging: { messageContent: messageContentEnabled(), sections: serverLog.describeSections(guild) },
	};
}

// --- Actions -------------------------------------------------------------------

async function resyncBannedWords(guild) {
	if (features.isEnabled(guild.id, 'bannedWords')) await bannedWords.syncGuild(guild);
}

// Each takes ({ client, guild, body, user }) and returns a short message for
// the page. Throwing sends the message back as an error.
const ACTIONS = {
	// Feature switches (#69)
	'features.set': async ({ guild, body }) => {
		const key = String(body.feature ?? '');
		if (!features.isFeature(key)) throw new Error('Unknown feature.');

		const enabled = Boolean(body.enabled);
		const { label } = features.FEATURES[key];
		if (features.isEnabled(guild.id, key) === enabled) {
			return `${label} was already ${enabled ? 'on' : 'off'}.`;
		}

		features.setEnabled(guild.id, key, enabled);

		// Banned words is the one feature whose switch has an effect outside the
		// bot: its AutoMod rules live in the server, so Discord has to be told.
		// syncGuild reads the switch itself and enables or disables the rules to
		// match — the same call serves both directions.
		if (key === 'bannedWords') {
			await bannedWords.syncGuild(guild).catch((error) => {
				throw new Error(`Saved, but I couldn't update the AutoMod rules: ${error.message}`);
			});
		}

		return enabled
			? `${label} is on.`
			: `${label} is off. Its settings are kept, and anything already running finishes.`;
	},

	// Alerts
	'alerts.setChannel': ({ guild, body }) => {
		const channel = optionalChannel(guild, body.channelId);
		guildSettings.setAlertChannel(guild.id, channel?.id ?? null);
		return channel ? `Admin alerts go to #${channel.name}.` : 'Admin alerts go to the default channel again.';
	},
	'alerts.addRecipient': async ({ guild, body }) => {
		if (!SNOWFLAKE.test(body.userId ?? '')) throw new Error('Enter a Discord user ID (17–20 digits).');
		const member = await guild.members.fetch(body.userId).catch(() => null);
		if (!member) throw new Error("That user isn't in this server.");
		guildSettings.addAlertRecipient(guild.id, member.id);
		return `${member.displayName} will be DMed admin alerts.`;
	},
	'alerts.removeRecipient': ({ guild, body }) => {
		const removed = guildSettings.removeAlertRecipient(guild.id, String(body.userId));
		return removed ? 'Removed from DM alerts.' : "They weren't on the DM list.";
	},

	// Server roles
	'roles.setMember': ({ guild, body }) => {
		const role = optionalRole(guild, body.roleId);
		if (role) guildSettings.setMemberRole(guild.id, role.id);
		else guildSettings.clearMemberRole(guild.id);
		return role ? `Member role set to @${role.name}.` : 'Member role cleared.';
	},
	'roles.setStreamer': ({ guild, body }) => {
		const role = optionalRole(guild, body.roleId);
		if (role) guildSettings.setStreamerRole(guild.id, role.id);
		else guildSettings.clearStreamerRole(guild.id);
		return role ? `Streamer role set to @${role.name}.` : 'Streamer role cleared.';
	},
	'roles.addAdmin': ({ guild, body }) => {
		const role = requireRole(guild, body.roleId);
		guildSettings.addAdminRole(guild.id, role.id);
		return `@${role.name} is now an admin role.`;
	},
	'roles.removeAdmin': ({ guild, body }) => {
		const removed = guildSettings.removeAdminRole(guild.id, String(body.roleId));
		return removed ? 'Admin role removed.' : "That wasn't an admin role.";
	},
	'roles.addMod': ({ guild, body }) => {
		const role = requireRole(guild, body.roleId);
		guildSettings.addModRole(guild.id, role.id);
		return `@${role.name} is now a mod role.`;
	},
	'roles.removeMod': ({ guild, body }) => {
		const removed = guildSettings.removeModRole(guild.id, String(body.roleId));
		return removed ? 'Mod role removed.' : "That wasn't a mod role.";
	},

	// Banned words
	'bannedWords.setEnabled': async ({ guild, body }) => {
		if (body.enabled) {
			bannedWords.requireManageGuild(guild);
			if (!bannedWordStore.listLists(guild.id).length && !bannedWordStore.countWords(guild.id)) {
				throw new Error('Pick at least one list, or add a word, first.');
			}
			features.setEnabled(guild.id, 'bannedWords', true);
			try {
				await bannedWords.syncGuild(guild);
			} catch (error) {
				features.setEnabled(guild.id, 'bannedWords', false);
				throw error;
			}
			return 'Banned words are on. Discord AutoMod now blocks matching messages.';
		}
		features.setEnabled(guild.id, 'bannedWords', false);
		await bannedWords.syncGuild(guild).catch((error) => {
			throw new Error(`Turned off in my settings, but I couldn't switch off the AutoMod rules: ${error.message}`);
		});
		return 'Banned words are off. The lists and words are kept.';
	},
	'bannedWords.setList': async ({ guild, body }) => {
		const list = LISTS[body.key];
		if (!list) throw new Error('Unknown list.');
		if (body.enabled) bannedWordStore.addList(guild.id, body.key);
		else bannedWordStore.removeList(guild.id, body.key);
		await resyncBannedWords(guild);
		return `${list.label} ${body.enabled ? 'on' : 'off'}.`;
	},
	'bannedWords.addWords': async ({ guild, body }) => {
		const summary = bannedWords.addCustomWords(guild.id, requireString(body.words, 'Words', 1000));
		await resyncBannedWords(guild);
		return summary;
	},
	'bannedWords.removeWord': async ({ guild, body }) => {
		const word = bannedWords.normalizeWord(String(body.word ?? '')) ?? '';
		if (!bannedWordStore.removeWord(guild.id, word)) throw new Error("That word isn't on the list.");
		await resyncBannedWords(guild);
		return 'Word removed.';
	},

	// Stream alerts
	'streams.setChannel': ({ guild, body }) => {
		if (!body.channelId) {
			guildSettings.clearStreamAlerts(guild.id);
			return 'Stream alerts are off. The streamer list is kept.';
		}
		const channel = requirePostableChannel(guild, body.channelId);
		guildSettings.setStreamAlerts(guild.id, channel.id);
		return `Stream alerts post in #${channel.name}.`;
	},
	'streams.addPingRole': ({ guild, body }) => {
		const role = requireRole(guild, body.roleId);
		const added = streamAlerts.addPingRole(guild.id, role.id);
		return added ? `Stream alerts will also ping @${role.name}.${mentionNote(guild, role)}` : `@${role.name} is already pinged.`;
	},
	// Scoped by guild_id in the query, so a typed-in ID can only ever remove
	// from this server's list. Not checked against the server's roles, so a
	// role deleted since it was added can still be taken off.
	'streams.removePingRole': ({ guild, body }) => {
		const removed = guildSettings.removeStreamPingRole(guild.id, String(body.roleId));
		return removed ? 'Ping role removed.' : "That wasn't a ping role.";
	},
	'streams.setMessage': ({ guild, body }) => {
		const message = requireMessage(body.message, streamAlerts.MESSAGE_PLACEHOLDERS, '{name}, {title}, {url}, {platform} and {role}');
		guildSettings.setStreamAlertMessage(guild.id, message);
		return message ? 'Custom message saved.' : 'Custom message cleared.';
	},
	'streams.add': async ({ guild, body }) => {
		if (!PLATFORMS[body.platform]) throw new Error('Unknown platform.');
		requireConfigured(body.platform);
		const account = await PLATFORMS[body.platform].resolve(requireString(body.account, 'The account', 100));
		streamerStore.addManual(guild.id, body.platform, account.id, account.name, null);
		return `Added ${PLATFORMS[body.platform].describe(account.name)}.`;
	},
	'streams.remove': ({ guild, body }) => {
		if (!PLATFORMS[body.platform]) throw new Error('Unknown platform.');
		const removed = streamerStore.removeByAccount(guild.id, body.platform, String(body.accountId));
		if (!removed) throw new Error("That channel isn't on this server's list.");
		return 'Removed.';
	},

	// Instagram
	'instagram.setChannel': ({ guild, body }) => {
		if (!body.channelId) {
			guildSettings.clearInstagramAlerts(guild.id);
			return 'Instagram alerts are off. The account list is kept.';
		}
		const channel = requirePostableChannel(guild, body.channelId);
		const role = optionalRole(guild, body.roleId);
		guildSettings.setInstagramAlerts(guild.id, channel.id, role?.id);
		return `Instagram posts go to #${channel.name}${role ? `, pinging @${role.name}` : ''}.${mentionNote(guild, role)}`;
	},
	'instagram.setMessage': ({ guild, body }) => {
		const message = requireMessage(body.message, instagramAlerts.MESSAGE_PLACEHOLDERS, '{name}, {title}, {url}, {platform} and {role}');
		guildSettings.setInstagramMessage(guild.id, message);
		return message ? 'Custom message saved.' : 'Custom message cleared.';
	},
	'instagram.add': async ({ guild, body }) => {
		if (!instagram.isConfigured()) throw new Error("Instagram isn't set up on this host — see the wiki's Instagram Alerts page.");
		const account = await instagram.resolveAccount(requireString(body.account, 'The account', 100));
		instagramStore.addAccount(guild.id, account.id, account.username);
		return `Following @${account.username}. Only posts from now on are shared.`;
	},
	'instagram.remove': ({ guild, body }) => {
		if (!instagramStore.removeAccount(guild.id, String(body.accountId))) throw new Error("That account isn't on this server's list.");
		return 'Removed.';
	},

	// RSS
	'rss.add': async ({ guild, body }) => {
		const pingRole = optionalRole(guild, body.roleId);
		const parsed = await rssAlerts.followFeed(guild, {
			url: requireString(body.url, 'The feed address', 500),
			channel: requireChannel(guild, body.channelId),
			roleId: pingRole?.id ?? null,
			message: optionalString(body.message, 'The message', MAX_TEMPLATE_LENGTH),
		});
		return `Following ${parsed.title}. Its ${parsed.items.length} current item${parsed.items.length === 1 ? '' : 's'} won't be posted; new ones will.${mentionNote(guild, pingRole)}`;
	},
	'rss.remove': ({ guild, body }) => {
		const feed = feedStore.getFeed(guild.id, Number(body.feedId));
		if (!feed) throw new Error("That isn't one of this server's feeds.");
		feedStore.removeFeed(guild.id, feed.id);
		return `Stopped following ${feed.title}.`;
	},

	// Auto-delete
	'autoDelete.set': async ({ guild, body }) => {
		const channel = requireChannel(guild, body.channelId);
		const maxMessages = body.count ? Number(body.count) : 0;
		if (!Number.isInteger(maxMessages) || maxMessages < 0) throw new Error('The count must be a whole number.');
		const liveSeconds = body.duration ? parseDuration(String(body.duration)) : 0;
		if (!maxMessages && !liveSeconds) throw new Error('Give a count, a duration, or both.');

		autoDeleteStore.setChannel(channel.id, guild.id, maxMessages, liveSeconds);
		const config = { maxMessages, liveSeconds };
		if (autoDelete.isTracked(channel.id)) {
			autoDelete.updateConfig(channel.id, config);
			await autoDelete.reapChannel(channel.id);
		} else {
			await autoDelete.startTracking(channel, config);
		}
		return `Auto-delete is on in #${channel.name}.`;
	},
	'autoDelete.remove': ({ guild, body }) => {
		const entry = autoDeleteStore.getChannel(String(body.channelId));
		if (!entry || entry.guildId !== guild.id) throw new Error("Auto-delete isn't on in that channel.");
		autoDeleteStore.removeChannel(entry.channelId);
		autoDelete.stopTracking(entry.channelId);
		return 'Auto-delete turned off for that channel.';
	},

	// Moderation
	'moderation.setEscalation': ({ guild, body }) => {
		if (body.off) {
			guildSettings.setWarnEscalation(guild.id, null);
			return 'Automatic timeouts are off. Warnings are still recorded.';
		}
		const escalation = moderation.parseEscalation({ count: Number(body.count), within: String(body.within ?? ''), timeout: String(body.timeout ?? '') });
		guildSettings.setWarnEscalation(guild.id, escalation);
		return `${escalation.count} warnings within ${formatDuration(escalation.windowSeconds)} now time a member out for ${formatDuration(escalation.timeoutSeconds)}.`;
	},
	'moderation.setAppealNote': ({ guild, body }) => {
		const note = optionalString(body.note, 'The appeal note', MAX_APPEAL_NOTE_LENGTH);
		guildSettings.setBanAppealNote(guild.id, note);
		return note ? 'Appeal note saved.' : 'Appeal note cleared.';
	},
	'moderation.removeCase': ({ guild, body, user }) => moderation.removeCaseRecord(guild, Number(body.caseId), `${user.username} (dashboard)`),

	// Giveaways
	'giveaways.end': async ({ client, guild, body }) => {
		const giveaway = giveawayStore.get(String(body.giveawayId), guild.id);
		if (!giveaway || giveaway.status !== 'active') throw new Error("That giveaway has already ended, or isn't in this server.");
		await giveaways.finishGiveaway(client, giveaway.id, true);
		return 'Giveaway ended and winners announced.';
	},

	// Voice — the rules are in lib/voiceHubs.js and lib/tempVoice.js, shared
	// with /voice and /vc.
	'voice.setOwnerControl': ({ guild, body }) => {
		const control = OWNER_CONTROLS[body.control];
		if (!control) throw new Error('Unknown owner control.');
		guildSettings.setOwnerControlAllowed(guild.id, body.control, Boolean(body.allowed));
		return `Channel owners ${body.allowed ? 'can' : 'can no longer'} use ${control.command}.`;
	},
	'voice.editHub': ({ guild, body }) => {
		const changes = {
			nameTemplate: body.nameTemplate,
			defaultLimit: Number(body.defaultLimit),
			minLimit: Number(body.minLimit),
			maxLimit: Number(body.maxLimit),
			category: body.categoryId ? requireCategory(guild, body.categoryId) : null,
		};
		voiceHubs.editHub(guild, String(body.hubId), changes);
		return 'Hub saved. New temp channels use these settings; open ones keep theirs.';
	},
	'voice.addHub': ({ guild, body }) => {
		const channel = SNOWFLAKE.test(body.channelId ?? '') ? guild.channels.cache.get(body.channelId) : null;
		if (!channel) throw new Error("That voice channel isn't in this server.");
		voiceHubs.addExistingHub(guild, channel, body.categoryId ? requireCategory(guild, body.categoryId) : null);
		return `#${channel.name} is now a hub.`;
	},
	'voice.createHub': async ({ guild, body }) => {
		const name = optionalString(body.name, 'The hub name', 100);
		const channel = await voiceHubs.createHub(guild, name, body.categoryId ? requireCategory(guild, body.categoryId) : null);
		return `Created the hub #${channel.name}.`;
	},
	'voice.removeHub': async ({ guild, body }) => {
		const result = await voiceHubs.removeHub(guild, String(body.hubId));
		if (!result) throw new Error("That isn't one of this server's hubs.");
		if (!result.name) return 'Hub removed (its channel was already gone).';
		return result.channelDeleted ? `Removed the hub and deleted #${result.name}.` : `Removed the hub, but couldn't delete #${result.name}: ${result.error}`;
	},
	'voice.pruneHub': ({ guild, body }) => {
		if (!voiceHubs.pruneHub(guild, String(body.hubId))) throw new Error('That hub was already resolved.');
		return 'Hub forgotten.';
	},
	'voice.restoreHub': async ({ guild, body }) => {
		const channel = await voiceHubs.restoreHub(guild, String(body.hubId));
		if (!channel) throw new Error('That hub was already resolved.');
		return `Restored the hub as #${channel.name}.`;
	},
	'voice.closeTemp': async ({ guild, body, user }) => {
		const name = await closeTempChannel(guild, body.channelId, `Closed from the admin dashboard by ${user.username}`);
		return `Closed #${name}.`;
	},
	'voice.transferTemp': async ({ guild, body }) => {
		const { channel, member } = await transferTempChannel(guild, body.channelId, body.userId);
		return `${member.displayName} now owns #${channel.name}.`;
	},

	// Server log (#81). One action per section: its switch, and optionally a new
	// channel. Picking a channel switches the section on, as /logging set does.
	'logging.setSection': ({ guild, body }) => {
		const section = String(body.section ?? '');
		if (!serverLog.isSection(section)) throw new Error('Unknown log section.');
		const { label } = serverLog.SECTIONS[section];

		if (body.channelId) {
			const channel = requirePostableChannel(guild, body.channelId);
			logStore.setChannel(guild.id, section, channel.id);
			return `${label} is on, posting to #${channel.name}.`;
		}

		const enabled = Boolean(body.enabled);
		if (enabled && !logStore.getSection(guild.id, section).channelId) throw new Error(`Pick a channel for ${label} first.`);
		logStore.setEnabled(guild.id, section, enabled);
		return enabled ? `${label} is on.` : `${label} is off. Its channel is kept.`;
	},

	// Security
	'security.disableCaptcha': ({ guild }) => {
		guildSettings.clearScreening(guild.id);
		return 'Captcha disabled. The screening channel and message were left in place.';
	},
	'security.disableHoneypot': ({ guild }) => {
		guildSettings.clearHoneypot(guild.id);
		return 'Honeypot disabled. The channel was left in place.';
	},

	// Permission tools (#100). Dashboard users are admins (or the bot's
	// owner), so the mod-on-staff check /perms makes doesn't apply; the rest
	// is the same code as the command, in lib/permissionTools.js.
	'perms.change': async ({ guild, body, user }) => {
		const change = permissionTools.ACCESS_CHANGES[body.change];
		if (!change) throw new Error('Unknown change.');
		const channel = requirePermsChannel(guild, body.channelId);
		requireInvokerSees(await permsInvoker(guild, user), channel);
		const target = requirePermsTarget(guild, body.roleId);
		const by = `${user.username} (dashboard)`;

		const { changed, skipped, protectBot } = await permissionTools.applyAccessChange(channel, {
			change,
			target,
			includeChannels: Boolean(body.includeChannels),
			reason: `${change.verb} via the dashboard by ${by}`,
		});
		const lines = [
			`${change.verb} for ${target.label} in ${changed.length === 1 ? `#${changed[0].name}` : `${changed.length} channels`}.`,
			skipped.length ? `Skipped ${skipped.length}: ${skipped.map(({ channel: each, why }) => `#${each.name} (${why})`).join('; ')}` : null,
			protectBot ? 'I kept my own access with an override for myself.' : null,
		].filter(Boolean);
		if (changed.length) await permissionTools.alertPermsChange(guild, by, `Channel permissions: ${change.verb.toLowerCase()}`, lines);
		return lines.join(' ');
	},
	// Recomputed from scratch, like the Confirm button in Discord: the preview
	// the page showed is never trusted.
	'perms.copy': async ({ guild, body, user }) => {
		if (!permissionTools.COPY_MODES.includes(body.mode)) throw new Error('Pick add or replace.');
		const prepared = permissionTools.prepareCopy(guild, await permsInvoker(guild, user), String(body.fromRoleId), String(body.toRoleId), body.mode);
		if (!permissionTools.copyHasChanges(prepared)) return `@${prepared.target.name} already has everything that copy would give it.`;
		const by = `${user.username} (dashboard)`;
		const { done, failed } = await permissionTools.applyCopy(prepared, by);
		const lines = [
			`Copied @${prepared.source.name} → @${prepared.target.name} (${prepared.mode}).`,
			`Channel overrides changed: ${done}.`,
			prepared.skipped.length ? `Skipped, missing my permissions: ${prepared.skipped.length}.` : null,
			failed.length ? `Failed: ${failed.length}.` : null,
		].filter(Boolean);
		await permissionTools.alertPermsChange(guild, by, 'Role permissions copied', [...lines, ...failed]);
		return lines.join(' ');
	},
};

// --- /perms reads (#100) ---------------------------------------------------------

// Read-only, so GET routes rather than actions: nothing to audit, and the page
// needs the data back, not a message.
async function permsReport(guild, user, channelId) {
	const channel = requirePermsChannel(guild, channelId);
	requireInvokerSees(await permsInvoker(guild, user), channel);
	return permissionTools.buildReport(channel);
}

async function permsCopyPreview(guild, user, query) {
	const mode = query.get('mode');
	if (!permissionTools.COPY_MODES.includes(mode)) throw new Error('Pick add or replace.');
	const prepared = permissionTools.prepareCopy(guild, await permsInvoker(guild, user), String(query.get('from')), String(query.get('to')), mode);
	return permissionTools.copySummary(prepared);
}

// Every change made in the dashboard goes in the same audit log as slash
// commands, under the signed-in user's name.
async function audit(client, user, guild, action, body, startedAt, error) {
	const options = Object.entries(body ?? {}).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(', ').slice(0, 500);
	await commandLogger.logCommand({
		timestamp: new Date().toISOString(),
		command: `dashboard ${action}`,
		options,
		user: `${user.username} (${user.id})`,
		guild: `${guild.name} (${guild.id})`,
		channel: 'dashboard',
		status: error ? 'error' : 'success',
		durationMs: Date.now() - startedAt,
		error: error?.message,
	}, client).catch(() => null);
}

async function runAction(client, user, guildId, action, body) {
	const guild = requireGuild(client, guildId);
	const handler = ACTIONS[action];
	if (!handler) throw new Error('Unknown action.');

	const startedAt = Date.now();
	try {
		const message = await handler({ client, guild, body: body ?? {}, user });
		await audit(client, user, guild, action, body, startedAt, null);
		return message;
	} catch (error) {
		await audit(client, user, guild, action, body, startedAt, error);
		throw error;
	}
}

module.exports = { status, guildList, guildSnapshot, requireGuild, runAction, ACTIONS, permsReport, permsCopyPreview };
