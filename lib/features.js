const store = require('../state/featureToggles');

// The canonical list of switchable feature sets (#69).
//
// `enabled` is the default for a guild that has never touched the switch, and
// it is ON for everything except banned words. That isn't a style choice: a
// default of OFF would silently disable every feature in every existing server
// the moment this shipped. Banned words keeps its original opt-in default,
// since turning it on creates real Discord AutoMod rules in the server.
//
// Not listed here, and deliberately never switchable:
//   /setup  — it hosts these switches; disabling it would lock an admin out
//   /help, /ping — infrastructure, not features
//   alerts  — other features report their failures through it
//   the dashboard — already has a host-level switch (DASHBOARD_PORT)
//
// `key` is stored in guild_feature_toggles.feature. Renaming one orphans
// every stored row, so treat these as permanent identifiers.
const FEATURES = {
	tempVoice: { label: 'Temporary voice channels', enabled: true, commands: ['/voice', '/vc'] },
	roleMenus: { label: 'Self-service role menus', enabled: true, commands: ['/roles'] },
	autoDelete: { label: 'Message auto-deletion', enabled: true, commands: ['/autodelete'] },
	captcha: { label: 'Member verification (captcha)', enabled: true, commands: ['/security captcha'] },
	honeypot: { label: 'Honeypot trap channel', enabled: true, commands: ['/security honeypot'] },
	leveling: { label: 'Activity levels', enabled: true, commands: ['/level'] },
	giveaways: { label: 'Giveaways', enabled: true, commands: ['/giveaway'] },
	bannedWords: { label: 'Banned words', enabled: false, commands: ['/bannedwords'] },
	moderation: { label: 'Moderation', enabled: true, commands: ['/mod'] },
	streamers: { label: 'Streamer alerts', enabled: true, commands: ['/streamers'] },
	rss: { label: 'RSS and Atom feeds', enabled: true, commands: ['/rss'] },
	instagram: { label: 'Instagram alerts', enabled: true, commands: ['/instagram'] },
};

const FEATURE_KEYS = Object.keys(FEATURES);

function isFeature(feature) {
	return Object.hasOwn(FEATURES, feature);
}

// The one question every gate asks. A stored row wins; otherwise the default.
// An unknown key returns true rather than false on purpose: a typo in a gate
// must not silently switch a working feature off.
function isEnabled(guildId, feature) {
	if (!isFeature(feature)) return true;
	const stored = store.getEnabled(guildId, feature);
	return stored === null ? FEATURES[feature].enabled : stored;
}

function setEnabled(guildId, feature, enabled) {
	if (!isFeature(feature)) throw new Error(`Unknown feature: ${feature}`);
	store.setEnabled(guildId, feature, enabled);
}

function reset(guildId, feature) {
	if (!isFeature(feature)) throw new Error(`Unknown feature: ${feature}`);
	return store.clear(guildId, feature);
}

// Every feature with its current state, in declaration order, from one query.
function list(guildId) {
	const stored = store.getAllForGuild(guildId);
	return FEATURE_KEYS.map((key) => ({
		key,
		label: FEATURES[key].label,
		commands: FEATURES[key].commands,
		enabled: stored.has(key) ? stored.get(key) : FEATURES[key].enabled,
		isDefault: !stored.has(key),
	}));
}

// The message a member sees when they use something that's switched off. It
// names the exact command to turn it back on, because the slash command stays
// registered with Discord either way — a disabled feature's command still
// appears in the picker, and without this it reads as a bug rather than a
// deliberate setting.
function disabledMessage(feature) {
	const label = FEATURES[feature]?.label ?? feature;
	return `**${label}** is switched off in this server. An admin can turn it back on with \`/setup feature enable feature:${feature}\`.`;
}

function requireEnabled(interaction, feature) {
	if (!isEnabled(interaction.guildId, feature)) {
		throw new Error(disabledMessage(feature));
	}
}

// Only for a feature whose default is off, where an explicit row is the whole
// answer. Guarded so a default-on feature can never silently get a wrong,
// short list of guilds.
function listGuildsExplicitlyEnabled(feature) {
	if (FEATURES[feature]?.enabled !== false) {
		throw new Error(`listGuildsExplicitlyEnabled is only valid for a default-off feature, not ${feature}`);
	}
	return store.listGuildsExplicitlyEnabled(feature);
}

module.exports = {
	FEATURES,
	listGuildsExplicitlyEnabled,
	FEATURE_KEYS,
	isFeature,
	isEnabled,
	setEnabled,
	reset,
	list,
	disabledMessage,
	requireEnabled,
};
