const { Events } = require('discord.js');
const { handleExecution } = require('../lib/bannedWords');
const features = require('../lib/features');

module.exports = {
	name: Events.AutoModerationActionExecution,
	async execute(execution) {
		// The rules themselves are switched off in Discord when the feature is
		// (lib/bannedWords.js syncGuild), so this should not fire while off — but a
		// rule an admin re-enabled by hand in Server Settings still would, and the
		// bot should not report on a feature the server has switched off.
		if (!features.isEnabled(execution.guild.id, 'bannedWords')) return;

		await handleExecution(execution).catch((error) => {
			console.error(`BannedWords: failed to report a block in guild ${execution.guild.id}:`, error.message);
		});
	},
};
