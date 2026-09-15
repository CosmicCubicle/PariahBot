const { SlashCommandBuilder, ChannelType, EmbedBuilder } = require('discord.js');
const roleMenuStore = require('../state/roleMenus');
const { applyChannelDefaults } = require('../lib/roleAssignmentChannel');
const { buildDropdownAnchorEmbed, refreshMenuEmbed, buildOpenButtonRow } = require('../lib/roleMenus');
const { requireAdmin } = require('../lib/permissions');

// Shared by add-role/remove-role: resolves the `message` option (populated by
// autocomplete, but not guaranteed to have come from it — see the same caveat
// in commands/voice.js's handleRemove) to a menu in this guild.
function requireMenu(interaction) {
	const messageId = interaction.options.getString('message');
	const menu = roleMenuStore.getMenu(messageId);
	if (!menu || menu.guildId !== interaction.guildId) {
		throw new Error("Couldn't find a matching role menu with that message — pick one from the autocomplete list.");
	}
	return menu;
}

function requireRoleBelowBot(interaction, role) {
	const botMember = interaction.guild.members.me;
	if (botMember.roles.highest.position <= role.position) {
		throw new Error(`My highest role isn't above ${role} — I can't grant it. Move my role above it in Server Settings → Roles.`);
	}
}

async function fetchMenuMessage(interaction, menu) {
	const channel = interaction.guild.channels.cache.get(menu.channelId)
		?? await interaction.guild.channels.fetch(menu.channelId).catch(() => null);
	if (!channel) return null;
	return channel.messages.fetch(menu.messageId).catch(() => null);
}

// Shared by `dropdown create` (seeding the first role) and `dropdown add-role`
// (adding one more later) — one role per command call.
function addRoleToMenu(interaction, menu, role, descriptor) {
	if (roleMenuStore.getOptionByRole(menu.messageId, role.id)) {
		throw new Error(`${role} is already on this message.`);
	}

	const existingOptions = roleMenuStore.getOptions(menu.messageId);
	if (existingOptions.length >= 25) {
		throw new Error('This message already has the maximum of 25 roles a dropdown can hold.');
	}

	requireRoleBelowBot(interaction, role);

	roleMenuStore.addOption({ messageId: menu.messageId, roleId: role.id, descriptor: descriptor ?? null });
}

async function handleDropdownCreate(interaction) {
	requireAdmin(interaction);

	const channel = interaction.options.getChannel('channel');
	const existingMessageId = interaction.options.getString('message_id');
	const title = interaction.options.getString('title');
	const description = interaction.options.getString('description');
	const applyDefaults = interaction.options.getBoolean('apply_channel_defaults') ?? false;
	const role = interaction.options.getRole('role');
	const descriptor = interaction.options.getString('descriptor');

	let message;
	let menu;

	if (existingMessageId) {
		message = await channel.messages.fetch(existingMessageId).catch(() => null);
		if (!message) {
			throw new Error("Couldn't find that message in this channel.");
		}
		if (message.author.id !== interaction.client.user.id) {
			throw new Error('I can only attach a role dropdown to a message I posted myself.');
		}

		const existingMenu = roleMenuStore.getMenu(existingMessageId);
		menu = existingMenu ?? { messageId: message.id, guildId: interaction.guildId, channelId: channel.id };
		if (!existingMenu) {
			roleMenuStore.createMenu(menu);
		}
	} else {
		message = await channel.send({ embeds: [buildDropdownAnchorEmbed(title ?? 'Pick your roles', description, [])] });
		menu = { messageId: message.id, guildId: interaction.guildId, channelId: channel.id };
		roleMenuStore.createMenu(menu);
	}

	addRoleToMenu(interaction, menu, role, descriptor);

	const existingEmbed = message.embeds[0];
	const finalTitle = title ?? existingEmbed?.title ?? 'Pick your roles';
	const finalDescription = description ?? existingEmbed?.description ?? null;

	await message.edit({
		embeds: [buildDropdownAnchorEmbed(finalTitle, finalDescription, roleMenuStore.getOptions(menu.messageId))],
		components: [buildOpenButtonRow(menu.messageId)],
	});

	let note = '';
	if (applyDefaults) {
		await applyChannelDefaults(channel, interaction.guildId);
		note = ' Channel defaults applied.';
	}

	await interaction.reply({
		content: `${existingMessageId ? 'Attached a role dropdown to' : 'Created a dropdown role message:'} ${message.url}${note}`,
		ephemeral: true,
	});
}

async function handleDropdownAddRole(interaction) {
	requireAdmin(interaction);

	const menu = requireMenu(interaction);
	const role = interaction.options.getRole('role');
	const descriptor = interaction.options.getString('descriptor');

	addRoleToMenu(interaction, menu, role, descriptor);

	const message = await fetchMenuMessage(interaction, menu);
	if (message) {
		await refreshMenuEmbed(message, roleMenuStore.getOptions(menu.messageId), buildDropdownAnchorEmbed);
	}

	await interaction.reply({ content: `Added ${role} to that dropdown.`, ephemeral: true });
}

async function handleDropdownRemoveRole(interaction) {
	requireAdmin(interaction);

	const menu = requireMenu(interaction);
	const role = interaction.options.getRole('role');

	const removed = roleMenuStore.removeOption(menu.messageId, role.id);
	if (!removed) {
		throw new Error(`${role} isn't on this message.`);
	}

	const message = await fetchMenuMessage(interaction, menu);
	if (message) {
		await refreshMenuEmbed(message, roleMenuStore.getOptions(menu.messageId), buildDropdownAnchorEmbed);
	}

	await interaction.reply({
		content: `Removed ${role} from that dropdown. Anyone who already has it from this menu keeps it — this only changes what's offered going forward.`,
		ephemeral: true,
	});
}

async function handleList(interaction) {
	requireAdmin(interaction);

	const menus = roleMenuStore.listMenusForGuild(interaction.guildId);
	const embed = new EmbedBuilder().setTitle('Role menus').setColor(0x5865f2);

	if (menus.length === 0) {
		embed.setDescription('No role menus are configured for this server yet. Use `/roles dropdown create` to make one.');
	} else {
		for (const menu of menus) {
			const options = roleMenuStore.getOptions(menu.messageId);
			const channel = interaction.guild.channels.cache.get(menu.channelId);
			embed.addFields({
				name: `Dropdown menu in ${channel ? `#${channel.name}` : 'an unknown channel'}`,
				value: `${options.length} role${options.length === 1 ? '' : 's'} — https://discord.com/channels/${interaction.guildId}/${menu.channelId}/${menu.messageId}`,
			});
		}
	}

	await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleApplyChannelDefaults(interaction) {
	requireAdmin(interaction);

	const channel = interaction.options.getChannel('channel');
	const targetRoleId = await applyChannelDefaults(channel, interaction.guildId);
	const targetRoleLabel = targetRoleId === interaction.guildId ? '@everyone' : `<@&${targetRoleId}>`;

	await interaction.reply({
		content: `Applied role assignment channel defaults to ${channel}: only ${targetRoleLabel} can view it, and only admins and I can post in it.`,
		ephemeral: true,
	});
}

async function handleMessageAutocomplete(interaction) {
	const focusedValue = interaction.options.getFocused().toLowerCase();

	const menus = roleMenuStore.listMenusForGuild(interaction.guildId);
	const choices = menus
		.map((menu) => {
			const channel = interaction.guild.channels.cache.get(menu.channelId);
			return { name: `#${channel ? channel.name : 'unknown-channel'} — ${menu.messageId}`, value: menu.messageId };
		})
		.filter((choice) => choice.name.toLowerCase().includes(focusedValue))
		.slice(0, 25);

	await interaction.respond(choices);
}

const HANDLERS = {
	'dropdown.create': handleDropdownCreate,
	'dropdown.add-role': handleDropdownAddRole,
	'dropdown.remove-role': handleDropdownRemoveRole,
	list: handleList,
	'apply-channel-defaults': handleApplyChannelDefaults,
};

function messageOption(option, description) {
	return option
		.setName('message')
		.setDescription(description)
		.setAutocomplete(true)
		.setRequired(true);
}

function buildCreateSubcommand(sub) {
	sub.setName('create');
	sub.setDescription('(Admin) Post a new dropdown role message, or attach one to an existing message.');
	sub.addChannelOption((option) => option
		.setName('channel')
		.setDescription('Channel to post in (or that contains the existing message)')
		.addChannelTypes(ChannelType.GuildText)
		.setRequired(true));
	sub.addRoleOption((option) => option
		.setName('role')
		.setDescription('Role to offer')
		.setRequired(true));
	sub.addStringOption((option) => option
		.setName('message_id')
		.setDescription('Attach to this existing message (that I posted) instead of creating a new one')
		.setRequired(false));
	sub.addStringOption((option) => option
		.setName('title')
		.setDescription('Embed title (defaults to "Pick your roles" for a new message)')
		.setMaxLength(256)
		.setRequired(false));
	sub.addStringOption((option) => option
		.setName('description')
		.setDescription('Embed description')
		.setMaxLength(2000)
		.setRequired(false));
	sub.addBooleanOption((option) => option
		.setName('apply_channel_defaults')
		.setDescription('Lock the channel to admin/bot posting and member-only visibility')
		.setRequired(false));
	sub.addStringOption((option) => option
		.setName('descriptor')
		.setDescription("Optional secondary text shown under the role's name")
		.setMaxLength(100)
		.setRequired(false));
	return sub;
}

function buildAddRoleSubcommand(sub) {
	sub.setName('add-role');
	sub.setDescription('(Admin) Add a role to a dropdown role message.');
	sub.addStringOption((option) => messageOption(option, 'The dropdown role message'));
	sub.addRoleOption((option) => option
		.setName('role')
		.setDescription('Role to offer')
		.setRequired(true));
	sub.addStringOption((option) => option
		.setName('descriptor')
		.setDescription("Optional secondary text shown under the role's name")
		.setMaxLength(100)
		.setRequired(false));
	return sub;
}

function buildRemoveRoleSubcommand(sub) {
	sub.setName('remove-role');
	sub.setDescription('(Admin) Remove a role from a dropdown role message.');
	sub.addStringOption((option) => messageOption(option, 'The dropdown role message'));
	sub.addRoleOption((option) => option
		.setName('role')
		.setDescription('Role to remove')
		.setRequired(true));
	return sub;
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName('roles')
		.setDescription('Configure self-service role menus.')
		.addSubcommandGroup((group) => group
			.setName('dropdown')
			.setDescription('Role menus where a dropdown lets members pick their roles.')
			.addSubcommand(buildCreateSubcommand)
			.addSubcommand(buildAddRoleSubcommand)
			.addSubcommand(buildRemoveRoleSubcommand))
		.addSubcommand((sub) => sub
			.setName('list')
			.setDescription("(Admin) List this server's configured role menus."))
		.addSubcommand((sub) => sub
			.setName('apply-channel-defaults')
			.setDescription('(Admin) Lock a channel to admin/bot posting and member-only visibility.')
			.addChannelOption((option) => option
				.setName('channel')
				.setDescription('Channel to apply defaults to')
				.addChannelTypes(ChannelType.GuildText)
				.setRequired(true))),
	async execute(interaction) {
		const group = interaction.options.getSubcommandGroup(false);
		const sub = interaction.options.getSubcommand();
		const key = group ? `${group}.${sub}` : sub;

		const handler = HANDLERS[key];
		if (!handler) throw new Error(`Unknown /roles subcommand: ${key}`);
		await handler(interaction);
	},
	async autocomplete(interaction) {
		const focusedOption = interaction.options.getFocused(true);

		if (focusedOption.name === 'message') {
			await handleMessageAutocomplete(interaction);
			return;
		}

		await interaction.respond([]);
	},
};
