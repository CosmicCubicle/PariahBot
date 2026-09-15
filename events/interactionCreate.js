const { Events } = require('discord.js');
const commandLogger = require('../logging/commandLogger');
const { handleHubButtonInteraction } = require('../lib/hubDesync');
const { handleWizardInteraction } = require('../lib/hubCreateWizard');

async function reportComponentError(interaction, error) {
	console.error('Component interaction failed:', error);
	const errorReply = { content: `Something went wrong: ${error.message}`, ephemeral: true };
	if (interaction.replied || interaction.deferred) {
		await interaction.followUp(errorReply).catch(() => null);
	} else {
		await interaction.reply(errorReply).catch(() => null);
	}
}

module.exports = {
	name: Events.InteractionCreate,
	async execute(interaction) {
		// Not run through the audit logger like slash commands are — these are
		// Prune/Restore clicks on a hub-desync notice, not a /command invocation,
		// and handleHubButtonInteraction reports its own outcome directly to the
		// clicker either way.
		if (interaction.isButton()) {
			try {
				await handleHubButtonInteraction(interaction);
			} catch (error) {
				await reportComponentError(interaction, error);
			}
			return;
		}

		// The /voice create and /voice edit hub-config modal is opened directly as
		// the command's own response, so its submission is the only interaction
		// this feature ever generates.
		if (interaction.isModalSubmit()) {
			try {
				await handleWizardInteraction(interaction);
			} catch (error) {
				await reportComponentError(interaction, error);
			}
			return;
		}

		if (interaction.isAutocomplete()) {
			// Fires on every keystroke while typing an autocompleted option, so this
			// intentionally skips the audit log (would be pure noise) and fails silently
			// on error — there's no user-facing way to surface an error here beyond an
			// empty suggestion list, unlike a real command's ephemeral error reply.
			const command = interaction.client.commands.get(interaction.commandName);
			if (!command?.autocomplete) return;
			try {
				await command.autocomplete(interaction);
			} catch (error) {
				console.error(`Autocomplete error for /${interaction.commandName}:`, error);
			}
			return;
		}

		if (!interaction.isChatInputCommand()) return;

		const command = interaction.client.commands.get(interaction.commandName);
		if (!command) return;

		const start = Date.now();
		try {
			await command.execute(interaction);
			await commandLogger.logCommand(commandLogger.buildEntry(interaction, 'success', Date.now() - start), interaction.client);
		} catch (error) {
			console.error(error);
			await commandLogger.logCommand(commandLogger.buildEntry(interaction, 'error', Date.now() - start, error), interaction.client);
			const errorReply = { content: `There was an error executing this command: ${error.message}`, ephemeral: true };
			if (interaction.replied || interaction.deferred) {
				await interaction.editReply(errorReply).catch(() => interaction.followUp(errorReply));
			} else {
				await interaction.reply(errorReply);
			}
		}
	},
};
