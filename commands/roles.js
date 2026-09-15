const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const roleMenuStore = require('../state/roleMenus');
const { applyChannelDefaults } = require('../lib/roleAssignmentChannel');
const {
	parseEmoji,
	buildReactionMenuEmbed,
	buildDropdownAnchorEmbed,
	refreshMenuEmbed,
	buildOpenButtonRow,
} = require('../lib/roleMenus');

function requireManageChannels(interaction) {
	if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageChannels)) {
		throw new Error('You need the Manage Channels permission to manage role menus.');
	}
}

// Shared by every *-add-role/*-remove-role subcommand: resolves the `message`
// option (populated by autocomplete, but not guaranteed to have come from it —
// see the same caveat in commands/voice.js's handleRemove) to a menu of the
// expected type in this guild.
function requireMenu(interaction, type) {
	const messageId = interaction.options.getString('message');
	const menu = roleMenuStore.getMenu(messageId);
	if (!menu || menu.guildId !== interaction.guildId || menu.type !== type) {
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

async function handleReactionCreate(interaction) {
	requireManageChannels(interaction);

	const channel = interaction.options.getChannel('channel');
	const title = interaction.options.getString('title');
	const description = interaction.options.getString('description');
	const applyDefaults = interaction.options.getBoolean('apply_channel_defaults') ?? false;

	const message = await channel.send({ embeds: [buildReactionMenuEmbed(title, description, [])] });
	roleMenuStore.createMenu({ messageId: message.id, guildId: interaction.guildId, channelId: channel.id, type: 'reaction' });

	let note = '';
	if (applyDefaults) {
		await applyChannelDefaults(channel, interaction.guildId);
		note = ' Channel defaults applied.';
	}

	await interaction.reply({
		content: `Created a reaction-role message in ${channel}: ${message.url}\nAdd roles to it with \`/roles reaction add-role\`.${note}`,
		ephemeral: true,
	});
}

async function handleReactionAddRole(interaction) {
	requireManageChannels(interaction);

	const menu = requireMenu(interaction, 'reaction');
	const role = interaction.options.getRole('role');
	const rawEmoji = interaction.options.getString('emoji');

	if (roleMenuStore.getOptionByRole(menu.messageId, role.id)) {
		throw new Error(`${role} is already on this message.`);
	}

	const existingOptions = roleMenuStore.getOptions(menu.messageId);
	if (existingOptions.length >= 20) {
		throw new Error('This message already has the maximum of 20 reaction roles Discord allows.');
	}

	const parsed = parseEmoji(rawEmoji);
	if (existingOptions.some((option) => parseEmoji(option.emoji).matchKey === parsed.matchKey)) {
		throw new Error('That emoji is already used on this message.');
	}

	requireRoleBelowBot(interaction, role);

	const message = await fetchMenuMessage(interaction, menu);
	if (!message) {
		throw new Error("Couldn't find that message anymore — it may have been deleted.");
	}

	try {
		await message.react(parsed.raw);
	} catch (error) {
		throw new Error(`Couldn't react with that emoji: ${error.message}`);
	}

	roleMenuStore.addOption({ messageId: menu.messageId, roleId: role.id, emoji: parsed.raw, label: null });
	await refreshMenuEmbed(message, roleMenuStore.getOptions(menu.messageId), buildReactionMenuEmbed);

	await interaction.reply({ content: `Added ${role} on ${parsed.raw} to that message.`, ephemeral: true });
}

async function handleReactionRemoveRole(interaction) {
	requireManageChannels(interaction);

	const menu = requireMenu(interaction, 'reaction');
	const role = interaction.options.getRole('role');

	const option = roleMenuStore.getOptionByRole(menu.messageId, role.id);
	if (!option) {
		throw new Error(`${role} isn't on this message.`);
	}

	roleMenuStore.removeOption(menu.messageId, role.id);

	const message = await fetchMenuMessage(interaction, menu);
	if (message) {
		const parsed = parseEmoji(option.emoji);
		const reaction = message.reactions.cache.find((r) => (r.emoji.id ?? r.emoji.name) === parsed.matchKey);
		await reaction?.remove().catch(() => null);
		await refreshMenuEmbed(message, roleMenuStore.getOptions(menu.messageId), buildReactionMenuEmbed);
	}

	await interaction.reply({ content: `Removed ${role} from that message.`, ephemeral: true });
}

async function handleDropdownCreate(interaction) {
	requireManageChannels(interaction);

	const channel = interaction.options.getChannel('channel');
	const title = interaction.options.getString('title');
	const description = interaction.options.getString('description');
	const applyDefaults = interaction.options.getBoolean('apply_channel_defaults') ?? false;

	const message = await channel.send({ embeds: [buildDropdownAnchorEmbed(title, description, [])] });
	await message.edit({ components: [buildOpenButtonRow(message.id)] });
	roleMenuStore.createMenu({ messageId: message.id, guildId: interaction.guildId, channelId: channel.id, type: 'dropdown' });

	let note = '';
	if (applyDefaults) {
		await applyChannelDefaults(channel, interaction.guildId);
		note = ' Channel defaults applied.';
	}

	await interaction.reply({
		content: `Created a dropdown role message in ${channel}: ${message.url}\nAdd roles to it with \`/roles dropdown add-role\`.${note}`,
		ephemeral: true,
	});
}

async function handleDropdownAddRole(interaction) {
	requireManageChannels(interaction);

	const menu = requireMenu(interaction, 'dropdown');
	const role = interaction.options.getRole('role');
	const label = interaction.options.getString('label');
	const rawEmoji = interaction.options.getString('emoji');

	if (roleMenuStore.getOptionByRole(menu.messageId, role.id)) {
		throw new Error(`${role} is already on this message.`);
	}

	const existingOptions = roleMenuStore.getOptions(menu.messageId);
	if (existingOptions.length >= 25) {
		throw new Error('This message already has the maximum of 25 roles a dropdown can hold.');
	}

	requireRoleBelowBot(interaction, role);

	const message = await fetchMenuMessage(interaction, menu);
	if (!message) {
		throw new Error("Couldn't find that message anymore — it may have been deleted.");
	}

	const parsedEmoji = rawEmoji ? parseEmoji(rawEmoji) : null;
	roleMenuStore.addOption({ messageId: menu.messageId, roleId: role.id, emoji: parsedEmoji?.raw ?? null, label });
	await refreshMenuEmbed(message, roleMenuStore.getOptions(menu.messageId), buildDropdownAnchorEmbed);

	await interaction.reply({ content: `Added ${role} ("${label}") to that dropdown.`, ephemeral: true });
}

async function handleDropdownRemoveRole(interaction) {
	requireManageChannels(interaction);

	const menu = requireMenu(interaction, 'dropdown');
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
	requireManageChannels(interaction);

	const menus = roleMenuStore.listMenusForGuild(interaction.guildId);
	const embed = new EmbedBuilder().setTitle('Role menus').setColor(0x5865f2);

	if (menus.length === 0) {
		embed.setDescription('No role menus are configured for this server yet. Use `/roles reaction create` or `/roles dropdown create` to make one.');
	} else {
		for (const menu of menus) {
			const options = roleMenuStore.getOptions(menu.messageId);
			const channel = interaction.guild.channels.cache.get(menu.channelId);
			embed.addFields({
				name: `${menu.type === 'reaction' ? 'Reaction' : 'Dropdown'} menu in ${channel ? `#${channel.name}` : 'an unknown channel'}`,
				value: `${options.length} role${options.length === 1 ? '' : 's'} — https://discord.com/channels/${interaction.guildId}/${menu.channelId}/${menu.messageId}`,
			});
		}
	}

	await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleApplyChannelDefaults(interaction) {
	requireManageChannels(interaction);

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
	const group = interaction.options.getSubcommandGroup(false);
	const type = group === 'dropdown' ? 'dropdown' : 'reaction';

	const menus = roleMenuStore.listMenusForGuild(interaction.guildId).filter((menu) => menu.type === type);
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
	'reaction.create': handleReactionCreate,
	'reaction.add-role': handleReactionAddRole,
	'reaction.remove-role': handleReactionRemoveRole,
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

module.exports = {
	data: new SlashCommandBuilder()
		.setName('roles')
		.setDescription('Configure self-service role menus.')
		.addSubcommandGroup((group) => group
			.setName('reaction')
			.setDescription('Role menus where reacting with an emoji grants a role.')
			.addSubcommand((sub) => sub
				.setName('create')
				.setDescription('(Manage Channels) Post a new reaction-role message.')
				.addChannelOption((option) => option
					.setName('channel')
					.setDescription('Channel to post the message in')
					.addChannelTypes(ChannelType.GuildText)
					.setRequired(true))
				.addStringOption((option) => option
					.setName('title')
					.setDescription('Embed title')
					.setMaxLength(256)
					.setRequired(true))
				.addStringOption((option) => option
					.setName('description')
					.setDescription('Embed description')
					.setMaxLength(2000)
					.setRequired(false))
				.addBooleanOption((option) => option
					.setName('apply_channel_defaults')
					.setDescription('Lock the channel to admin/bot posting and member-only visibility')
					.setRequired(false)))
			.addSubcommand((sub) => sub
				.setName('add-role')
				.setDescription('(Manage Channels) Add a role + emoji to a reaction-role message.')
				.addStringOption((option) => messageOption(option, 'The reaction-role message'))
				.addRoleOption((option) => option
					.setName('role')
					.setDescription('Role to grant')
					.setRequired(true))
				.addStringOption((option) => option
					.setName('emoji')
					.setDescription('Emoji to react with (unicode or a custom emoji from this server)')
					.setRequired(true)))
			.addSubcommand((sub) => sub
				.setName('remove-role')
				.setDescription('(Manage Channels) Remove a role from a reaction-role message.')
				.addStringOption((option) => messageOption(option, 'The reaction-role message'))
				.addRoleOption((option) => option
					.setName('role')
					.setDescription('Role to remove')
					.setRequired(true))))
		.addSubcommandGroup((group) => group
			.setName('dropdown')
			.setDescription('Role menus where a dropdown lets members pick their roles.')
			.addSubcommand((sub) => sub
				.setName('create')
				.setDescription('(Manage Channels) Post a new dropdown role-selection message.')
				.addChannelOption((option) => option
					.setName('channel')
					.setDescription('Channel to post the message in')
					.addChannelTypes(ChannelType.GuildText)
					.setRequired(true))
				.addStringOption((option) => option
					.setName('title')
					.setDescription('Embed title')
					.setMaxLength(256)
					.setRequired(true))
				.addStringOption((option) => option
					.setName('description')
					.setDescription('Embed description')
					.setMaxLength(2000)
					.setRequired(false))
				.addBooleanOption((option) => option
					.setName('apply_channel_defaults')
					.setDescription('Lock the channel to admin/bot posting and member-only visibility')
					.setRequired(false)))
			.addSubcommand((sub) => sub
				.setName('add-role')
				.setDescription('(Manage Channels) Add a role to a dropdown role message.')
				.addStringOption((option) => messageOption(option, 'The dropdown role message'))
				.addRoleOption((option) => option
					.setName('role')
					.setDescription('Role to offer')
					.setRequired(true))
				.addStringOption((option) => option
					.setName('label')
					.setDescription('Label shown in the dropdown')
					.setMaxLength(100)
					.setRequired(true))
				.addStringOption((option) => option
					.setName('emoji')
					.setDescription('Optional emoji shown next to the label')
					.setRequired(false)))
			.addSubcommand((sub) => sub
				.setName('remove-role')
				.setDescription('(Manage Channels) Remove a role from a dropdown role message.')
				.addStringOption((option) => messageOption(option, 'The dropdown role message'))
				.addRoleOption((option) => option
					.setName('role')
					.setDescription('Role to remove')
					.setRequired(true))))
		.addSubcommand((sub) => sub
			.setName('list')
			.setDescription("(Manage Channels) List this server's configured role menus."))
		.addSubcommand((sub) => sub
			.setName('apply-channel-defaults')
			.setDescription('(Manage Channels) Lock a channel to admin/bot posting and member-only visibility.')
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
