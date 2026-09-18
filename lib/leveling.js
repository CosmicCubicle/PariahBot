const { randomInt } = require('node:crypto');
const levelStore = require('../state/levels');

const XP_COOLDOWN_SECONDS = 60;
const XP_MIN = 15;
const XP_MAX = 25;

// MEE6-style curve: total XP needed to reach `level` grows roughly quadratically,
// so each successive level takes noticeably longer than the last.
function xpForLevel(level) {
	return 5 * (level ** 2) + (50 * level) + 100;
}

function levelFromXp(xp) {
	let level = 0;
	while (xp >= xpForLevel(level + 1)) level += 1;
	return level;
}

function randomXpGain() {
	return randomInt(XP_MIN, XP_MAX + 1);
}

// Called from events/messageCreate.js for every non-bot guild message. Returns
// null if the cooldown is still active, otherwise the updated standing plus
// whether this message pushed the member to a new level.
function grantMessageXp(guildId, userId) {
	const existing = levelStore.getUser(guildId, userId);
	const now = Date.now();

	if (existing?.lastXpAt && now - Date.parse(existing.lastXpAt) < XP_COOLDOWN_SECONDS * 1000) {
		return null;
	}

	const previousLevel = existing?.level ?? 0;
	const xp = (existing?.xp ?? 0) + randomXpGain();
	const level = levelFromXp(xp);

	levelStore.setUser({ guildId, userId, xp, level, lastXpAt: new Date(now).toISOString() });

	return { xp, level, leveledUp: level > previousLevel };
}

function getStanding(guildId, userId) {
	const row = levelStore.getUser(guildId, userId) ?? { xp: 0, level: 0 };
	return {
		xp: row.xp,
		level: row.level,
		xpForCurrentLevel: xpForLevel(row.level),
		xpForNextLevel: xpForLevel(row.level + 1),
	};
}

module.exports = {
	xpForLevel,
	levelFromXp,
	grantMessageXp,
	getStanding,
};
