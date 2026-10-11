const { ContextMenuCommandBuilder, ApplicationCommandType } = require('discord.js');
const { openActionModal } = require('../lib/moderation');

// Right-click a member → Apps → Ban member. Opens a short form for the reason,
// then does the same as /mod ban — see lib/moderation.js.
module.exports = {
	// Switchable feature set this command belongs to (lib/features.js).
	// events/interactionCreate.js refuses it when the guild has it off.
	feature: 'moderation',
	data: new ContextMenuCommandBuilder()
		.setName('Ban member')
		.setType(ApplicationCommandType.User),
	async execute(interaction) {
		await openActionModal(interaction, 'ban');
	},
};
