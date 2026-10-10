const { Events } = require('discord.js');
const { handleExecution } = require('../lib/bannedWords');

module.exports = {
	name: Events.AutoModerationActionExecution,
	async execute(execution) {
		await handleExecution(execution).catch((error) => {
			console.error(`BannedWords: failed to report a block in guild ${execution.guild.id}:`, error.message);
		});
	},
};
