const {
	AutoModerationActionType,
	AutoModerationRuleEventType,
	AutoModerationRuleTriggerType,
	EmbedBuilder,
	PermissionFlagsBits,
	RESTJSONErrorCodes,
} = require('discord.js');
const bannedWordStore = require('../state/bannedWords');
const { sendAlert } = require('./alertDelivery');
const { LISTS } = require('./bannedWordLists');
const features = require('./features');

// /bannedwords is built on Discord's own AutoMod rather than the bot reading
// messages: reading message text needs the privileged Message Content intent
// (see ProjectContext.md § 5). The bot turns a guild's configuration into at
// most two AutoMod rules and keeps them in step:
// - one keyword preset rule for the Discord-maintained lists (a guild may
//   only have one), and
// - one keyword rule for the shipped lists plus the guild's custom words
//   (a guild may have six, so this leaves five for its admins).
// Discord then blocks matching messages itself — before anyone sees them,
// and even while the bot is offline — and tells the bot, which reports it
// through the guild's admin alerts.

const ALERT_COLOR = 0xed4245;

// Shown to the member whose message was blocked. Discord's limit is 150.
const BLOCKED_NOTICE = 'Your message was blocked because it contains a word this server has banned.';

const RULE_NAMES = {
	[AutoModerationRuleTriggerType.KeywordPreset]: 'PariahBot: banned words (Discord lists)',
	[AutoModerationRuleTriggerType.Keyword]: 'PariahBot: banned words',
};

// Discord's limits for a keyword rule: 1,000 keywords, each up to 60
// characters. Custom words get whatever the shipped lists can't use, so a
// guild that picks every list can never be pushed over the limit.
const MAX_KEYWORDS = 1000;
const MAX_WORD_LENGTH = 60;
const SHIPPED_WORD_COUNT = Object.values(LISTS).reduce((total, list) => total + (list.words?.length ?? 0), 0);
const MAX_CUSTOM_WORDS = MAX_KEYWORDS - SHIPPED_WORD_COUNT;

// Lower-cased, trimmed, inner spaces collapsed. Discord matches
// case-insensitively, so storing one form is what lets "Badword" and
// "badword" be one entry. Returns null for anything Discord would refuse.
function normalizeWord(raw) {
	const word = raw.trim().toLowerCase().replace(/\s+/g, ' ');
	if (!word || word.length > MAX_WORD_LENGTH) return null;
	if (!/[^*]/.test(word)) return null;
	return word;
}

// Adds comma-separated words to a guild's custom list. Returns a summary, or
// throws when none can be used or the list would pass its limit. Shared by
// /bannedwords word add and the admin dashboard; the caller re-syncs.
function addCustomWords(guildId, rawText) {
	const raw = rawText.split(',').filter((part) => part.trim());
	const words = [...new Set(raw.map(normalizeWord).filter(Boolean))];
	const rejected = raw.filter((part) => !normalizeWord(part));
	if (words.length === 0) {
		throw new Error('None of those can be used. Each word or phrase must be 1–60 characters and not only `*`. Separate several with commas.');
	}

	const existing = new Set(bannedWordStore.listWords(guildId));
	const newCount = words.filter((word) => !existing.has(word)).length;
	if (existing.size + newCount > MAX_CUSTOM_WORDS) {
		throw new Error(`That would make ${existing.size + newCount} custom words, and the limit is ${MAX_CUSTOM_WORDS} (Discord allows 1,000 per rule, shared with the ready-made lists). Remove some first.`);
	}

	const added = bannedWordStore.addWords(guildId, words);
	const parts = [`Added ${added} word${added === 1 ? '' : 's'}.`];
	if (added < words.length) parts.push(`${words.length - added} ${words.length - added === 1 ? 'was' : 'were'} already on the list.`);
	if (rejected.length) parts.push(`Skipped ${rejected.length} that ${rejected.length === 1 ? 'was' : 'were'} empty, only \`*\`, or over 60 characters.`);
	return parts.join(' ');
}

function requireManageGuild(guild) {
	if (!guild.members.me.permissions.has(PermissionFlagsBits.ManageGuild)) {
		throw new Error('I need the **Manage Server** permission to manage AutoMod rules. Add it to my PariahBot role in Server Settings → Roles, then run this again.');
	}
}

// What the guild's rules should contain, from its stored configuration.
function desiredRules(guildId) {
	const lists = bannedWordStore.listLists(guildId).map((key) => LISTS[key]).filter(Boolean);
	const presets = lists.filter((list) => list.preset).map((list) => list.preset);
	const keywords = [...new Set([
		...lists.flatMap((list) => list.words ?? []),
		...bannedWordStore.listWords(guildId),
	])];
	return {
		[AutoModerationRuleTriggerType.KeywordPreset]: presets.length ? { presets } : null,
		[AutoModerationRuleTriggerType.Keyword]: keywords.length ? { keywordFilter: keywords } : null,
	};
}

const BLOCK_ACTION = { type: AutoModerationActionType.BlockMessage, metadata: { customMessage: BLOCKED_NOTICE } };

// Creates, updates or switches off each of the bot's rules to match the
// configuration. Rules are found by who created them, not by a stored ID:
// Discord is the source of truth, and a rule an admin deleted in Server
// Settings is simply created again.
//
// Only the trigger and the on/off state are ever sent on an update. Exempt
// roles and channels, an allow list, or extra actions (an alert channel, a
// timeout) that an admin adds in Server Settings → AutoMod are left alone.
async function syncGuild(guild) {
	requireManageGuild(guild);

	const enabled = features.isEnabled(guild.id, 'bannedWords');
	const desired = desiredRules(guild.id);
	const rules = await guild.autoModerationRules.fetch();
	const reason = 'PariahBot /bannedwords';

	for (const [triggerType, name] of Object.entries(RULE_NAMES).map(([type, ruleName]) => [Number(type), ruleName])) {
		const trigger = desired[triggerType];
		const existing = rules.find((rule) => rule.creatorId === guild.client.user.id && rule.triggerType === triggerType);

		try {
			if (!enabled || !trigger) {
				// Switched off, not deleted, so an admin's exemptions survive
				// the next /bannedwords enable. The stale trigger is harmless
				// while it's off and is replaced when it's switched back on.
				if (existing?.enabled) await existing.edit({ enabled: false, reason });
				continue;
			}

			if (!existing) {
				await guild.autoModerationRules.create({
					name,
					eventType: AutoModerationRuleEventType.MessageSend,
					triggerType,
					triggerMetadata: trigger,
					actions: [BLOCK_ACTION],
					enabled: true,
					reason,
				});
				continue;
			}

			await existing.edit({
				// triggerMetadata is replaced as a whole, so carry over what an
				// admin may have set on it in Server Settings.
				triggerMetadata: {
					...trigger,
					regexPatterns: existing.triggerMetadata.regexPatterns,
					allowList: existing.triggerMetadata.allowList,
				},
				// Only touched if the block itself was removed in Server
				// Settings — otherwise the admin's other actions are kept as is.
				actions: existing.actions.some((action) => action.type === AutoModerationActionType.BlockMessage)
					? undefined
					: [BLOCK_ACTION, ...existing.actions.map((action) => ({
						type: action.type,
						metadata: {
							channel: action.metadata.channelId ?? undefined,
							durationSeconds: action.metadata.durationSeconds ?? undefined,
							customMessage: action.metadata.customMessage ?? undefined,
						},
					}))],
				enabled: true,
				reason,
			});
		} catch (error) {
			if (error.code === RESTJSONErrorCodes.MissingPermissions) {
				throw new Error('Discord refused to change the AutoMod rules — I need the **Manage Server** permission. Add it to my PariahBot role in Server Settings → Roles, then run this again.');
			}
			throw new Error(`Discord refused to set up the "${name}" AutoMod rule: ${error.message}. If it says the maximum number of rules was reached, delete an unused keyword rule in Server Settings → AutoMod and try again.`);
		}
	}
}

// Called once from events/ready.js. Brings back rules deleted, or edited out
// of shape, in Server Settings while the bot was offline.
async function syncAll(client) {
	// Only guilds that switched it on: banned words defaults to off, so an
	// explicit enabled row is exactly the set that has rules to re-sync.
	for (const guildId of features.listGuildsExplicitlyEnabled('bannedWords')) {
		const guild = client.guilds.cache.get(guildId);
		if (!guild) continue;
		await syncGuild(guild).catch((error) => {
			console.error(`BannedWords: sync failed for guild ${guildId}:`, error.message);
		});
	}
}

// Which of the guild's lists a matched keyword came from. Several can
// contain the same word.
function sourcesFor(guildId, keyword) {
	const sources = bannedWordStore.listLists(guildId)
		.filter((key) => LISTS[key]?.words?.includes(keyword))
		.map((key) => LISTS[key].label);
	if (bannedWordStore.listWords(guildId).includes(keyword)) sources.push('Custom words');
	return sources;
}

function describeSource(guildId, ruleTriggerType, keyword) {
	if (ruleTriggerType === AutoModerationRuleTriggerType.KeywordPreset) {
		const presets = bannedWordStore.listLists(guildId).filter((key) => LISTS[key]?.preset).map((key) => LISTS[key].label);
		return `Discord's lists (${presets.join(', ') || 'none selected'})`;
	}
	const sources = keyword ? sourcesFor(guildId, keyword) : [];
	return sources.length ? sources.join(', ') : 'Custom words or a shipped list';
}

// Discord sends one execution per action taken. Only the block is reported,
// and only for the bot's own rules — an admin's own AutoMod rules are none of
// this feature's business.
async function handleExecution(execution) {
	if (execution.action.type !== AutoModerationActionType.BlockMessage) return;

	const { guild } = execution;
	const rule = execution.autoModerationRule
		?? await guild.autoModerationRules.fetch({ autoModerationRule: execution.ruleId }).catch(() => null);
	if (rule?.creatorId !== guild.client.user.id) return;

	// The message text itself would need the Message Content intent; the
	// matched keyword doesn't. Spoilered so the alert doesn't repeat the word
	// to everyone reading the alert channel.
	const keyword = execution.matchedKeyword;
	const embed = new EmbedBuilder()
		.setColor(ALERT_COLOR)
		.setTitle('Blocked a message with a banned word')
		.addFields(
			{ name: 'Member', value: `<@${execution.userId}> (${execution.userId})`, inline: true },
			{ name: 'Channel', value: execution.channelId ? `<#${execution.channelId}>` : 'Unknown', inline: true },
			{ name: 'Matched', value: keyword ? `||${keyword}||` : 'Not given by Discord', inline: true },
			{ name: 'List', value: describeSource(guild.id, execution.ruleTriggerType, keyword) },
		)
		.setTimestamp();

	await sendAlert(guild, { embeds: [embed], allowedMentions: { parse: [] } });
}

module.exports = {
	MAX_CUSTOM_WORDS,
	normalizeWord,
	addCustomWords,
	requireManageGuild,
	syncGuild,
	syncAll,
	handleExecution,
};
