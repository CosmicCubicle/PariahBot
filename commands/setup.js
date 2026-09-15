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

// Shared by mod-role add and the single-role settings below: resolves `role`
// (use as-is) or `name`/`color` (create a new one) to one Role object.
async function resolveOrCreateRole(interaction, { role, name, color }) {
	if (color && !name) {
		throw new Error('color only applies when creating a role with name.');
	}
	if (role) return role;

	return interaction.guild.roles.create({
		name,
		...(color ? { color: resolveRoleColor(color) } : {}),
		reason: `Created via /setup by ${interaction.user.tag}`,
	});
}

// member-role and streamer-role share the exact same set-existing-role /
// create-new-role / clear shape, so this is the one handler for both — only
// what to do with the resolved role ID differs, via `config`. mod-role can't
// use this: it holds any number of roles, not one to set-or-clear.
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

	if (clear) {
		config.clear(interaction.guildId);
		await interaction.reply({ content: `Cleared the ${config.label}.`, ephemeral: true });
		return;
	}

	const targetRole = await resolveOrCreateRole(interaction, { role, name, color });

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
	'streamer-role': {
		label: 'streamer role',
		set: guildSettings.setStreamerRole,
		clear: guildSettings.clearStreamerRole,
	},
};

// role/name/color/clear are identical across member-role and streamer-role, so
// the SlashCommandBuilder shape is built once and reused by name.
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

async function handleModRoleAdd(interaction) {
	requireAdmin(interaction);

	const role = interaction.options.getRole('role');
	const name = interaction.options.getString('name');
	const color = interaction.options.getString('color');

	const chosen = [role && 'role', name && 'name'].filter(Boolean);
	if (chosen.length === 0) {
		throw new Error('Specify an existing role or a name to create one.');
	}
	if (chosen.length > 1) {
		throw new Error('Choose only one of role or name.');
	}

	const targetRole = await resolveOrCreateRole(interaction, { role, name, color });

	guildSettings.addModRole(interaction.guildId, targetRole.id);
	await interaction.reply({
		content: `${targetRole} is now a mod role — can override temp channel ownership via \`/vc claim\` and use PariahBot's admin commands.`,
		ephemeral: true,
	});
}

async function handleModRoleRemove(interaction) {
	requireAdmin(interaction);

	const role = interaction.options.getRole('role');
	const removed = guildSettings.removeModRole(interaction.guildId, role.id);
	if (!removed) {
		throw new Error(`${role} isn't a mod role.`);
	}

	await interaction.reply({ content: `Removed ${role} as a mod role.`, ephemeral: true });
}

async function handleModRoleList(interaction) {
	requireAdmin(interaction);

	const roleIds = guildSettings.listModRoles(interaction.guildId);
	await interaction.reply({
		content: roleIds.length
			? `Mod roles: ${roleIds.map((id) => `<@&${id}>`).join(', ')}`
			: 'No mod roles configured yet — use `/setup mod-role add`.',
		ephemeral: true,
	});
}

const MOD_ROLE_HANDLERS = {
	add: handleModRoleAdd,
	remove: handleModRoleRemove,
	list: handleModRoleList,
};

module.exports = {
	data: new SlashCommandBuilder()
		.setName('setup')
		.setDescription("Configure this server's roles for PariahBot.")
		.addSubcommand((sub) => addRoleSetupOptions(sub
			.setName('member-role')
			.setDescription('(Admin) Set, create, or clear the member role.')))
		.addSubcommandGroup((group) => group
			.setName('mod-role')
			.setDescription('Roles that count as mods for PariahBot — any number can be configured.')
			.addSubcommand((sub) => sub
				.setName('add')
				.setDescription('(Admin) Add an existing or newly-created role as a mod role.')
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
					.setRequired(false)))
			.addSubcommand((sub) => sub
				.setName('remove')
				.setDescription('(Admin) Remove a mod role.')
				.addRoleOption((option) => option
					.setName('role')
					.setDescription('Mod role to remove')
					.setRequired(true)))
			.addSubcommand((sub) => sub
				.setName('list')
				.setDescription('(Admin) List the configured mod roles.')))
		.addSubcommand((sub) => addRoleSetupOptions(sub
			.setName('streamer-role')
			.setDescription('(Admin) Set, create, or clear the streamer role.'))),
	async execute(interaction) {
		const group = interaction.options.getSubcommandGroup(false);
		const sub = interaction.options.getSubcommand();

		if (group === 'mod-role') {
			const handler = MOD_ROLE_HANDLERS[sub];
			if (!handler) throw new Error(`Unknown /setup mod-role subcommand: ${sub}`);
			await handler(interaction);
			return;
		}

		const config = ROLE_CONFIGS[sub];
		if (!config) throw new Error(`Unknown /setup subcommand: ${sub}`);
		await handleRoleSetup(interaction, config);
	},
};
