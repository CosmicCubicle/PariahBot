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

// Shared by admin-role/mod-role add and the single-role settings below: resolves `role`
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
// what to do with the resolved role ID differs, via `config`. admin-role and
// mod-role can't use this: they hold any number of roles, not one to set-or-clear.
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
	await interaction.reply({ content: `${targetRole} is now the ${config.label}.`, ephemeral: true });
}

const ROLE_CONFIGS = {
	'member-role': {
		label: 'member role',
		set: guildSettings.setMemberRole,
		clear: guildSettings.clearMemberRole,
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

// Admin roles and mod roles are both "any number of roles" lists with the
// same add/remove/list/clear shape, so one set of handlers serves both, told
// apart by `kind`. See lib/permissions.js for what each level can do.
const STAFF_ROLE_KINDS = {
	'admin-role': {
		label: 'admin role',
		meaning: 'Admins can use every staff command, plus /setup, /security, the admin dashboard and the moderation and banned-words policy settings.',
		add: guildSettings.addAdminRole,
		remove: guildSettings.removeAdminRole,
		list: guildSettings.listAdminRoles,
		clear: guildSettings.clearAdminRoles,
	},
	'mod-role': {
		label: 'mod role',
		meaning: 'Mods can use the staff commands except /setup, /security, the admin dashboard and the policy settings.',
		add: guildSettings.addModRole,
		remove: guildSettings.removeModRole,
		list: guildSettings.listModRoles,
		clear: guildSettings.clearModRoles,
	},
};

async function handleStaffRoleAdd(interaction, kind) {
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
	kind.add(interaction.guildId, targetRole.id);
	await interaction.reply({ content: `${targetRole} is now ${kind.label === 'admin role' ? 'an' : 'a'} ${kind.label}. ${kind.meaning}`, ephemeral: true });
}

async function handleStaffRoleRemove(interaction, kind) {
	requireAdmin(interaction);

	const role = interaction.options.getRole('role');
	if (!kind.remove(interaction.guildId, role.id)) {
		throw new Error(`${role} isn't ${kind.label === 'admin role' ? 'an' : 'a'} ${kind.label}.`);
	}
	await interaction.reply({ content: `Removed ${role} as ${kind.label === 'admin role' ? 'an' : 'a'} ${kind.label}.`, ephemeral: true });
}

async function handleStaffRoleList(interaction, kind, group) {
	requireAdmin(interaction);

	const roleIds = kind.list(interaction.guildId);
	await interaction.reply({
		content: roleIds.length
			? `${kind.label[0].toUpperCase()}${kind.label.slice(1)}s: ${roleIds.map((id) => `<@&${id}>`).join(', ')}`
			: `No ${kind.label}s configured yet — use \`/setup ${group} add\`.`,
		ephemeral: true,
		allowedMentions: { parse: [] },
	});
}

async function handleStaffRoleClear(interaction, kind) {
	requireAdmin(interaction);

	const count = kind.clear(interaction.guildId);
	await interaction.reply({
		content: count > 0 ? `Cleared all ${count} ${kind.label}${count === 1 ? '' : 's'}.` : `No ${kind.label}s were configured.`,
		ephemeral: true,
	});
}

const STAFF_ROLE_HANDLERS = {
	add: handleStaffRoleAdd,
	remove: handleStaffRoleRemove,
	list: handleStaffRoleList,
	clear: handleStaffRoleClear,
};

function addStaffRoleGroup(builder, group, description) {
	const label = STAFF_ROLE_KINDS[group].label;
	return builder.addSubcommandGroup((g) => g
		.setName(group)
		.setDescription(description)
		.addSubcommand((sub) => sub
			.setName('add')
			.setDescription(`(Admin) Add an existing or newly-created role as ${label === 'admin role' ? 'an' : 'a'} ${label}.`)
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
			.setDescription(`(Admin) Remove ${label === 'admin role' ? 'an' : 'a'} ${label}.`)
			.addRoleOption((option) => option
				.setName('role')
				.setDescription(`The ${label} to remove`)
				.setRequired(true)))
		.addSubcommand((sub) => sub
			.setName('list')
			.setDescription(`(Admin) List the configured ${label}s.`))
		.addSubcommand((sub) => sub
			.setName('clear')
			.setDescription(`(Admin) Remove all configured ${label}s.`)));
}

module.exports = {
	data: addStaffRoleGroup(addStaffRoleGroup(new SlashCommandBuilder()
		.setName('setup')
		.setDescription("Configure this server's roles for PariahBot.")
		.addSubcommand((sub) => addRoleSetupOptions(sub
			.setName('member-role')
			.setDescription('(Admin) Set, create, or clear the member role.'))),
	'admin-role', 'Roles that count as admins for PariahBot — any number can be configured.'),
	'mod-role', 'Roles that count as mods for PariahBot — any number can be configured.')
		.addSubcommand((sub) => addRoleSetupOptions(sub
			.setName('streamer-role')
			.setDescription('(Admin) Set, create, or clear the streamer role.'))),
	async execute(interaction) {
		const group = interaction.options.getSubcommandGroup(false);
		const sub = interaction.options.getSubcommand();

		if (STAFF_ROLE_KINDS[group]) {
			const handler = STAFF_ROLE_HANDLERS[sub];
			if (!handler) throw new Error(`Unknown /setup ${group} subcommand: ${sub}`);
			await handler(interaction, STAFF_ROLE_KINDS[group], group);
			return;
		}

		const config = ROLE_CONFIGS[sub];
		if (!config) throw new Error(`Unknown /setup subcommand: ${sub}`);
		await handleRoleSetup(interaction, config);
	},
};
