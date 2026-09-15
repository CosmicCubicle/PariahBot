const { SlashCommandBuilder, Colors } = require('discord.js');
const guildSettings = require('../state/guildSettings');
const { requireAdmin } = require('../lib/permissions');

// Accepts a hex code (with or without '#') or a named color from discord.js's own
// Colors enum (case-insensitive, e.g. "red", "DarkRed", "blurple").
function resolveRoleColor(raw) {
	const hexMatch = raw.match(/^#?([0-9a-fA-F]{6})$/);
	if (hexMatch) return parseInt(hexMatch[1], 16);

	const key = Object.keys(Colors).find((candidate) => candidate.toLowerCase() === raw.toLowerCase());
	if (key) return Colors[key];

	throw new Error(`"${raw}" isn't a color I recognize — use a hex code like #FF0000 or a name like Red.`);
}

// Each of the three role settings (member/mod/streamer) shares the exact same
// set-existing-role / create-new-role / clear shape, so this is the one handler
// for all of them — only what to do with the resolved role ID differs, via `config`.
async function handleRoleSetup(interaction, config) {
	requireAdmin(interaction);

	const role = interaction.options.getRole('role');
	const name = interaction.options.getString('name');
	const color = interaction.options.getString('color');
	const clear = interaction.options.getBoolean('clear') ?? false;

	const chosen = [role && 'role', name && 'name', clear && 'clear'].filter(Boolean);
	if (chosen.length === 0) {
		throw new Error('Specify an existing role, a name to create one, or clear: true.');
	}
	if (chosen.length > 1) {
		throw new Error(`Choose only one of role, name, or clear — got ${chosen.join(' and ')}.`);
	}
	if (color && !name) {
		throw new Error('color only applies when creating a role with name.');
	}

	if (clear) {
		config.clear(interaction.guildId);
		await interaction.reply({ content: `Cleared the ${config.label}.`, ephemeral: true });
		return;
	}

	let targetRole = role;
	if (!targetRole) {
		targetRole = await interaction.guild.roles.create({
			name,
			...(color ? { color: resolveRoleColor(color) } : {}),
			reason: `Created via /setup by ${interaction.user.tag}`,
		});
	}

	config.set(interaction.guildId, targetRole.id);
	await interaction.reply({
		content: `${targetRole} is now the ${config.label}.${config.note ? ` ${config.note}` : ''}`,
		ephemeral: true,
	});
}

const ROLE_CONFIGS = {
	'member-role': {
		label: 'member role',
		set: guildSettings.setMemberRole,
		clear: guildSettings.clearMemberRole,
		note: 'Used by `/roles apply-channel-defaults` to decide who can view a role-selection channel.',
	},
	'mod-role': {
		label: 'mod role',
		set: guildSettings.setModRole,
		clear: guildSettings.clearModRole,
		note: 'Can override temp channel ownership via `/vc claim` — see lib/permissions.js.',
	},
	'streamer-role': {
		label: 'streamer role',
		set: guildSettings.setStreamerRole,
		clear: guildSettings.clearStreamerRole,
	},
};

// role/name/color/clear are identical across all three subcommands, so the
// SlashCommandBuilder shape is built once and reused by name.
function addRoleSetupOptions(sub) {
	return sub
		.addRoleOption((option) => option
			.setName('role')
			.setDescription('Use this existing role')
			.setRequired(false))
		.addStringOption((option) => option
			.setName('name')
			.setDescription('Create a new role with this name')
			.setMaxLength(100)
			.setRequired(false))
		.addStringOption((option) => option
			.setName('color')
			.setDescription('Color for the new role — hex code (#FF0000) or name (Red)')
			.setRequired(false))
		.addBooleanOption((option) => option
			.setName('clear')
			.setDescription('Clear the currently configured role')
			.setRequired(false));
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName('setup')
		.setDescription("Configure this server's roles for PariahBot.")
		.addSubcommand((sub) => addRoleSetupOptions(sub
			.setName('member-role')
			.setDescription('(Admin) Set, create, or clear the member role.')))
		.addSubcommand((sub) => addRoleSetupOptions(sub
			.setName('mod-role')
			.setDescription('(Admin) Set, create, or clear the mod role.')))
		.addSubcommand((sub) => addRoleSetupOptions(sub
			.setName('streamer-role')
			.setDescription('(Admin) Set, create, or clear the streamer role.'))),
	async execute(interaction) {
		const sub = interaction.options.getSubcommand();
		const config = ROLE_CONFIGS[sub];
		if (!config) throw new Error(`Unknown /setup subcommand: ${sub}`);
		await handleRoleSetup(interaction, config);
	},
};
