const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const guildSettings = require('../state/guildSettings');

function requireManageChannels(interaction) {
	if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageChannels)) {
		throw new Error('You need the Manage Channels permission to change security settings.');
	}
}

async function handleMemberRoleSet(interaction) {
	requireManageChannels(interaction);

	const role = interaction.options.getRole('role');
	guildSettings.setMemberRole(interaction.guildId, role.id);

	await interaction.reply({
		content: `${role} is now the member role — used by things like \`/roles apply-channel-defaults\` to decide who can view a role-selection channel.`,
		ephemeral: true,
	});
}

async function handleMemberRoleClear(interaction) {
	requireManageChannels(interaction);

	guildSettings.clearMemberRole(interaction.guildId);

	await interaction.reply({
		content: 'Cleared the member role — @everyone will be treated as the member role until a new one is set.',
		ephemeral: true,
	});
}

const HANDLERS = {
	'member-role.set': handleMemberRoleSet,
	'member-role.clear': handleMemberRoleClear,
};

module.exports = {
	data: new SlashCommandBuilder()
		.setName('security')
		.setDescription("Configure this server's security settings.")
		.addSubcommandGroup((group) => group
			.setName('member-role')
			.setDescription('The role that identifies a regular member.')
			.addSubcommand((sub) => sub
				.setName('set')
				.setDescription('(Manage Channels) Set the member role.')
				.addRoleOption((option) => option
					.setName('role')
					.setDescription('Role that identifies a member')
					.setRequired(true)))
			.addSubcommand((sub) => sub
				.setName('clear')
				.setDescription('(Manage Channels) Clear the member role (falls back to @everyone).'))),
	async execute(interaction) {
		const group = interaction.options.getSubcommandGroup(false);
		const sub = interaction.options.getSubcommand();
		const key = group ? `${group}.${sub}` : sub;

		const handler = HANDLERS[key];
		if (!handler) throw new Error(`Unknown /security subcommand: ${key}`);
		await handler(interaction);
	},
};
