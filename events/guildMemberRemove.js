const { Events } = require('discord.js');
const { handleMemberRemove } = require('../lib/serverLog');

module.exports = {
	name: Events.GuildMemberRemove,
	// The server log's leaves (#81). Kicked and banned members arrive here too;
	// the Kicks and bans section is what says why.
	async execute(member) {
		await handleMemberRemove(member).catch((error) => {
			console.error(`ServerLog: failed to log a leave in guild ${member.guild.id}:`, error.message);
		});
	},
};
