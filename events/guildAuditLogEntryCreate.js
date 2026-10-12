const { Events } = require('discord.js');
const { handleAuditEntry } = require('../lib/serverLog');

module.exports = {
	name: Events.GuildAuditLogEntryCreate,
	// Kicks, bans and server changes for the server log (#81). Only arrives
	// where the bot has View Audit Log. lib/serverLog.js checks whether the
	// feature and the section are on.
	async execute(entry, guild) {
		await handleAuditEntry(entry, guild).catch((error) => {
			console.error(`ServerLog: failed to log audit entry ${entry.id} in guild ${guild.id}:`, error.message);
		});
	},
};
