const { ContextMenuCommandBuilder, ApplicationCommandType } = require('discord.js');
const { openActionModal } = require('../lib/moderation');

// Right-click a member → Apps → Kick member. Opens a short form for the reason,
// then does the same as /mod kick — see lib/moderation.js.
module.exports = {
	// Switchable feature set this command belongs to (lib/features.js).
	// events/interactionCreate.js refuses it when the guild has it off.
	feature: 'moderation',
	data: new ContextMenuCommandBuilder()
		.setName('Kick member')
		.setType(ApplicationCommandType.User),
	async execute(interaction) {
		await openActionModal(interaction, 'kick');
	},
};
