const { Events } = require('discord.js');
const { handleMemberAdd } = require('../lib/serverLog');

module.exports = {
	name: Events.GuildMemberAdd,
	// The server log's joins (#81). Needs the privileged Guild Members intent
	// (lib/intents.js). The captcha still doesn't use this event: it predates
	// the intent, and its button works without it.
	async execute(member) {
		await handleMemberAdd(member).catch((error) => {
			console.error(`ServerLog: failed to log a join in guild ${member.guild.id}:`, error.message);
		});
	},
};
