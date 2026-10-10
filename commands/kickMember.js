const { ContextMenuCommandBuilder, ApplicationCommandType } = require('discord.js');
const { openActionModal } = require('../lib/moderation');

// Right-click a member → Apps → Kick member. Opens a short form for the reason,
// then does the same as /mod kick — see lib/moderation.js.
module.exports = {
	data: new ContextMenuCommandBuilder()
		.setName('Kick member')
		.setType(ApplicationCommandType.User),
	async execute(interaction) {
		await openActionModal(interaction, 'kick');
	},
};
