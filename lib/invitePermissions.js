const { PermissionFlagsBits } = require('discord.js');

// What to ask Discord for when inviting the bot to a server (#91), worked out
// from the features the inviter actually wants.
//
// Kept apart from lib/features.js on purpose: that module is about switching a
// feature off in a server that already has the bot, and is loaded by every
// command and event. This one is about an invite link, is read only by the
// dashboard, and covers two features that have no switch at all. The keys are
// shared, and test/invitePermissions.test.js fails if the two ever drift.
//
// The source of truth for these is the wiki's Permissions page. Change one,
// change the other.

// What the bot needs before any feature does anything: read a channel, reply,
// render an embed, and find a message it posted earlier. An invite with only
// these gets a bot that answers commands and little else, which is exactly
// what the Minimum preset is for.
const BASE = [
	PermissionFlagsBits.ViewChannel,
	PermissionFlagsBits.SendMessages,
	PermissionFlagsBits.EmbedLinks,
	PermissionFlagsBits.ReadMessageHistory,
];

// Features with no switch (lib/features.js explains why), listed here anyway
// because an invite still has to carry what they need.
const ALWAYS_ON = ['setup', 'alerts'];

const FEATURE_PERMISSIONS = {
	setup: {
		label: 'Server roles',
		note: 'Only needed to create a role for you; setting an existing one needs nothing.',
		permissions: [PermissionFlagsBits.ManageRoles],
	},
	alerts: {
		label: 'Admin alerts',
		note: 'Only needed for /alerts restore-default to make the channel.',
		permissions: [PermissionFlagsBits.ManageChannels],
	},
	tempVoice: {
		label: 'Temporary voice channels',
		permissions: [
			PermissionFlagsBits.ManageChannels,
			PermissionFlagsBits.MoveMembers,
			PermissionFlagsBits.Connect,
			PermissionFlagsBits.ManageRoles,
		],
	},
	roleMenus: {
		label: 'Self-service role menus',
		note: "The bot's role must sit above every role in a menu.",
		permissions: [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ReadMessageHistory],
	},
	autoDelete: {
		label: 'Message auto-deletion',
		permissions: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory],
	},
	captcha: {
		label: 'Member verification (captcha)',
		note: "The bot's role must sit above the member role.",
		permissions: [
			PermissionFlagsBits.ManageRoles,
			PermissionFlagsBits.ManageChannels,
			PermissionFlagsBits.ReadMessageHistory,
		],
	},
	honeypot: {
		label: 'Honeypot trap channel',
		note: 'Ban Members is needed even for the default "remove", which is a softban.',
		permissions: [
			PermissionFlagsBits.BanMembers,
			PermissionFlagsBits.ManageChannels,
			PermissionFlagsBits.ManageRoles,
		],
	},
	leveling: {
		label: 'Activity levels',
		permissions: [PermissionFlagsBits.SendMessages],
	},
	giveaways: {
		label: 'Giveaways',
		permissions: [
			PermissionFlagsBits.SendMessages,
			PermissionFlagsBits.EmbedLinks,
			PermissionFlagsBits.ReadMessageHistory,
		],
	},
	bannedWords: {
		label: 'Banned words',
		note: 'Manage Server is what Discord requires to manage AutoMod rules.',
		permissions: [PermissionFlagsBits.ManageGuild],
	},
	moderation: {
		label: 'Moderation',
		note: "The bot's role must sit above anyone it acts on.",
		permissions: [
			PermissionFlagsBits.KickMembers,
			PermissionFlagsBits.BanMembers,
			PermissionFlagsBits.ModerateMembers,
		],
	},
	// Mention Everyone is deliberately left out of these three. The wiki lists
	// it as "Mention Everyone, or a mentionable ping role" — the second costs
	// nothing, so the invite doesn't ask for a server-wide mention privilege
	// that most servers won't want. The dashboard says so next to them.
	streamers: {
		label: 'Streamer alerts',
		note: 'To ping a role, make that role mentionable rather than granting Mention Everyone.',
		permissions: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks],
	},
	rss: {
		label: 'RSS and Atom feeds',
		note: 'To ping a role, make that role mentionable rather than granting Mention Everyone.',
		permissions: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks],
	},
	instagram: {
		label: 'Instagram alerts',
		note: 'To ping a role, make that role mentionable rather than granting Mention Everyone.',
		permissions: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks],
	},
	permissionTools: {
		label: 'Permission tools',
		note: "The bot can only set permissions it holds itself, and only edit roles below its own.",
		permissions: [PermissionFlagsBits.ManageRoles],
	},
	memberCount: {
		label: 'Member count channels',
		note: 'Connect is needed to deny it to @everyone, which is what makes the channel a locked label rather than one to join.',
		permissions: [
			PermissionFlagsBits.ManageChannels,
			PermissionFlagsBits.ManageRoles,
			PermissionFlagsBits.Connect,
		],
	},
	logging: {
		label: 'Server log',
		note: 'Also needs the Server Members intent, which is a Developer Portal setting rather than a permission.',
		permissions: [
			PermissionFlagsBits.ViewAuditLog,
			PermissionFlagsBits.ViewChannel,
			PermissionFlagsBits.SendMessages,
			PermissionFlagsBits.EmbedLinks,
		],
	},
};

const FEATURE_KEYS = Object.keys(FEATURE_PERMISSIONS);

// Conveniences no feature strictly needs, but that a bot in a busy server
// usually wants: replying in a thread, reacting, attaching a file, speaking in
// a voice channel. This is the difference between the wiki's **Required** and
// **Recommended** invites, and the two numbers on its Bot Setup page are
// pinned by test/invitePermissions.test.js so these can't drift apart.
//
// Not attached to any feature on purpose: a feature asks for what it cannot
// work without, and the invite builder's checkboxes mean exactly that. These
// are a separate, opt-in layer.
const RECOMMENDED_EXTRAS = [
	PermissionFlagsBits.AddReactions,
	PermissionFlagsBits.AttachFiles,
	PermissionFlagsBits.BypassSlowmode,
	PermissionFlagsBits.ChangeNickname,
	PermissionFlagsBits.CreateInstantInvite,
	PermissionFlagsBits.CreatePrivateThreads,
	PermissionFlagsBits.CreatePublicThreads,
	PermissionFlagsBits.DeafenMembers,
	PermissionFlagsBits.ManageNicknames,
	PermissionFlagsBits.ManageThreads,
	PermissionFlagsBits.MentionEveryone,
	PermissionFlagsBits.MuteMembers,
	PermissionFlagsBits.PinMessages,
	PermissionFlagsBits.SendMessagesInThreads,
	PermissionFlagsBits.SendPolls,
	PermissionFlagsBits.SendVoiceMessages,
	PermissionFlagsBits.SetVoiceChannelStatus,
	PermissionFlagsBits.Speak,
	PermissionFlagsBits.UseApplicationCommands,
	PermissionFlagsBits.UseEmbeddedActivities,
];

// Discord permissions are a bitfield, and the invite URL carries it as a
// decimal string. BigInt throughout: the field is past 2^53 and would quietly
// lose bits as a Number.
function bitsFor(featureKeys = [], { extras = false } = {}) {
	const flags = new Set(BASE);
	for (const key of featureKeys) {
		for (const flag of FEATURE_PERMISSIONS[key]?.permissions ?? []) flags.add(flag);
	}
	if (extras) for (const flag of RECOMMENDED_EXTRAS) flags.add(flag);
	return [...flags].reduce((total, flag) => total | flag, 0n);
}

// The three the dashboard offers, matching the names the wiki already uses so
// the page and the docs can't mean different things by the same word.
const PRESETS = {
	minimum: { label: 'Minimum', features: [], extras: false },
	required: { label: 'Required', features: FEATURE_KEYS, extras: false },
	recommended: { label: 'Recommended', features: FEATURE_KEYS, extras: true },
};

// scope=bot alone would invite the bot without its slash commands, which is a
// confusing half-working state — applications.commands is always included.
function inviteUrl(clientId, featureKeys = [], options = {}) {
	if (!clientId) throw new Error('CLIENT_ID is not set, so an invite link cannot be built.');

	const params = new URLSearchParams({
		client_id: clientId,
		scope: 'bot applications.commands',
		permissions: bitsFor(featureKeys, options).toString(),
	});
	return `https://discord.com/oauth2/authorize?${params}`;
}

// Readable names for whatever a set of features adds up to, for the dashboard
// to list beside the link — a bare number tells the person nothing about what
// they are about to grant.
function permissionNames(featureKeys = [], options = {}) {
	const bits = bitsFor(featureKeys, options);
	return Object.entries(PermissionFlagsBits)
		.filter(([, flag]) => (bits & flag) === flag)
		.map(([name]) => name.replace(/([a-z])([A-Z])/g, '$1 $2'))
		.sort();
}

// What the dashboard renders: every feature, its label, any caveat, and
// whether it is one of the always-on ones.
function catalogue() {
	return FEATURE_KEYS.map((key) => ({
		key,
		label: FEATURE_PERMISSIONS[key].label,
		note: FEATURE_PERMISSIONS[key].note ?? null,
		alwaysOn: ALWAYS_ON.includes(key),
		permissions: FEATURE_PERMISSIONS[key].permissions.map((flag) => Object.entries(PermissionFlagsBits)
			.find(([, value]) => value === flag)[0]
			.replace(/([a-z])([A-Z])/g, '$1 $2')),
	}));
}

module.exports = {
	BASE,
	RECOMMENDED_EXTRAS,
	PRESETS,
	ALWAYS_ON,
	FEATURE_PERMISSIONS,
	FEATURE_KEYS,
	bitsFor,
	inviteUrl,
	permissionNames,
	catalogue,
};
