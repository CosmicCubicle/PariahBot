const { SlashCommandBuilder, EmbedBuilder, ApplicationCommandOptionType, ApplicationCommandType } = require('discord.js');
const features = require('../lib/features');

function formatOption(option) {
	const required = option.required ? '*' : '';
	return `<${option.name}${required}>`;
}

// Subcommand groups nest actual subcommands one level deeper (group -> subcommand
// -> options) instead of carrying options themselves, so they're walked down to
// the leaves first; `prefix` accumulates the group name(s) seen along the way.
function flattenSubcommands(options, prefix = '') {
	if (!options?.length) return [];
	return options.flatMap((option) => {
		if (option.type === ApplicationCommandOptionType.SubcommandGroup) {
			return flattenSubcommands(option.options, `${prefix}${option.name} `);
		}
		if (option.type === ApplicationCommandOptionType.Subcommand) {
			return [{ path: `${prefix}${option.name}`, options: option.options }];
		}
		return [];
	});
}

function formatCommand(command) {
	const definition = command.data.toJSON();
	const subcommands = flattenSubcommands(definition.options);

	if (subcommands.length > 0) {
		return subcommands.map(({ path, options }) => {
			const formattedOptions = options?.map(formatOption).join(' ') ?? '';
			return `/${definition.name} ${path} ${formattedOptions}`.trim();
		}).join('\n');
	}

	const options = definition.options?.map(formatOption).join(' ') ?? '';
	return `/${definition.name} ${options}`.trim();
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName('help')
		.setDescription('Shows all available bot commands and their options.'),
	async execute(interaction) {
		// Right-click commands (see commands/kickMember.js) have no options or
		// description to list, so they get one field of their own below.
		const isRightClick = (command) => command.data.toJSON().type === ApplicationCommandType.User;
		const all = [...interaction.client.commands.values()]
			.sort((first, second) => first.data.name.localeCompare(second.data.name));
		const commands = all.filter((command) => command.data.name !== 'help' && !isRightClick(command));
		const rightClick = all.filter(isRightClick);

		const embed = new EmbedBuilder()
			.setTitle('PariahBot commands')
			.setColor(0x5865f2)
			.setDescription('`*` marks a required option.')
			.setTimestamp();

		// A command belonging to a switched-off feature set (#69) is listed, not
		// hidden. Hiding it would leave the command still in Discord's picker —
		// registration is global, so the bot can't remove it per server — and a
		// command that appears but isn't in /help reads as a bug. Listing it
		// marked, with the command that turns it back on, is the honest version.
		const disabledFeatures = [];

		for (const command of commands) {
			const off = command.feature && !features.isEnabled(interaction.guildId, command.feature);
			if (off) disabledFeatures.push(command.feature);

			// The usage list goes in the field's value, not its name: Discord caps a
			// field name at 256 characters but a value at 1024, and a command with
			// several subcommands (like /voice) easily produces a usage list longer
			// than 256 chars on its own — putting it in the name broke /help outright
			// once /voice grew past ~5 subcommands.
			embed.addFields({
				name: off ? `/${command.data.name} — ⛔ switched off` : `/${command.data.name}`,
				value: off
					? `${command.data.description}\n*Switched off for this server. An admin can turn it back on with* \`/setup feature enable feature:${command.feature}\`.`
					: `${command.data.description}\n${formatCommand(command)}`,
			});
		}

		if (rightClick.length) {
			const moderationOff = !features.isEnabled(interaction.guildId, 'moderation');
			embed.addFields({
				name: moderationOff ? 'Right-click a member → Apps — ⛔ switched off' : 'Right-click a member → Apps',
				value: moderationOff
					? `${rightClick.map((command) => `**${command.data.name}**`).join(', ')} — switched off with the rest of moderation. \`/setup feature enable feature:moderation\` turns it back on.`
					: `${rightClick.map((command) => `**${command.data.name}**`).join(', ')} — staff only, same as /mod.`,
			});
		}

		// One summary line, so an admin reading a server with several features off
		// sees the whole picture without scrolling every field.
		if (disabledFeatures.length) {
			const labels = [...new Set(disabledFeatures)].map((key) => features.FEATURES[key].label);
			embed.addFields({
				name: `Switched off in this server (${labels.length})`,
				value: `${labels.join(', ')}\nAn admin can see and change all of them with \`/setup feature list\`.`,
			});
		}

		await interaction.reply({ embeds: [embed], ephemeral: true });
	},
};
