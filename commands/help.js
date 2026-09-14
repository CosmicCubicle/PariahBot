const { SlashCommandBuilder, EmbedBuilder, ApplicationCommandOptionType } = require('discord.js');

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
		const commands = [...interaction.client.commands.values()]
			.filter((command) => command.data.name !== 'help')
			.sort((first, second) => first.data.name.localeCompare(second.data.name));

		const embed = new EmbedBuilder()
			.setTitle('PariahBot commands')
			.setColor(0x5865f2)
			.setDescription('`*` marks a required option.')
			.setTimestamp();

		for (const command of commands) {
			embed.addFields({
				name: formatCommand(command),
				value: command.data.description,
			});
		}

		await interaction.reply({ embeds: [embed], ephemeral: true });
	},
};
