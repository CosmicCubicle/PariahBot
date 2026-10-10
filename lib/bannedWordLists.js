const { AutoModerationRuleKeywordPresetType } = require('discord.js');

// The ready-made lists /bannedwords offers. Two kinds:
// - preset: one of Discord's own AutoMod lists. Discord maintains them and
//   doesn't publish their contents, so there's nothing to keep up to date
//   here — and no reason to write a worse copy of a slur list.
// - words: shipped with the bot, for what Discord's lists don't cover. They
//   go into the bot's keyword rule alongside the server's custom words.
//
// Discord matches keywords as whole words, case-insensitively. A * at either
// end widens that: "free*" also matches "freebie", "*cord*" matches anywhere
// inside a word — which is what catches look-alike scam domains in links.
//
// Keep the shipped lists short and unambiguous: every entry blocks real
// messages in every server that picks the list, and a false positive (a
// name, a game term) is worse than a miss an admin can add as a custom word.
// The total across all of them counts against Discord's 1,000-keyword limit
// — see MAX_CUSTOM_WORDS in lib/bannedWords.js.
const LISTS = {
	profanity: {
		label: 'Profanity',
		description: "Swearing — Discord's built-in list",
		preset: AutoModerationRuleKeywordPresetType.Profanity,
	},
	sexual: {
		label: 'Sexual content',
		description: "Sexual terms — Discord's built-in list",
		preset: AutoModerationRuleKeywordPresetType.SexualContent,
	},
	slurs: {
		label: 'Slurs',
		description: "Racist, homophobic and other slurs — Discord's built-in list",
		preset: AutoModerationRuleKeywordPresetType.Slurs,
	},
	scams: {
		label: 'Scams',
		description: 'Free Nitro, gift and crypto scams, and look-alike Discord/Steam links',
		words: [
			'free nitro',
			'free discord nitro',
			'nitro for free',
			'nitro giveaway',
			'claim your nitro',
			'free steam gift',
			'steam gift giveaway',
			'free robux',
			'robux generator',
			'free vbucks',
			'free v-bucks',
			'crypto giveaway',
			'double your crypto',
			'claim your airdrop',
			'guaranteed profit',
			'accidentally reported your account',
			'i accidentally reported you',
			'*dlscord*',
			'*discrod*',
			'*disc0rd*',
			'*dicsord*',
			'*steamcommunlty*',
			'*stearncommunity*',
			'*steamcomrnunity*',
		],
	},
	harassment: {
		label: 'Harassment',
		description: 'Telling people to harm themselves, and direct threats',
		words: [
			'kys',
			'kill yourself',
			'kill urself',
			'killyourself',
			'go kill yourself',
			'neck yourself',
			'unalive yourself',
			'end yourself',
			'drink bleach',
			'hope you die',
			'i will kill you',
			'im going to kill you',
			"i'm going to kill you",
			'i know where you live',
		],
	},
	drugs: {
		label: 'Drugs',
		description: 'Hard drugs, and buying or selling drugs',
		words: [
			'cocaine',
			'heroin',
			'meth',
			'methamphetamine',
			'fentanyl',
			'mdma',
			'ketamine',
			'crack cocaine',
			'oxycodone',
			'percocet',
			'xanax',
			'buy weed',
			'selling weed',
			'weed for sale',
			'buy drugs',
			'selling drugs',
			'drugs for sale',
		],
	},
};

module.exports = { LISTS };
