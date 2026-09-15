const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { resolveCallerChannel, requireOwner } = require('../lib/vcScope');

// Owner self-service on the temp channel the caller currently owns — distinct
// from /voice, which is guild-admin hub management (Manage Channels). Every
// subcommand here is scoped via resolveCallerChannel: caller must be
// connected to a tracked temp channel and run the command in that channel's
// own chat.

async function handleName(interaction) {
	const { channel, record } = resolveCallerChannel(interaction);
	requireOwner(interaction, record);

	const name = interaction.options.getString('name');
	await channel.setName(name, 'Renamed via /vc name');
	await interaction.reply({ content: `Renamed your channel to **${name}**.`, ephemeral: true });
}

async function handleLimit(interaction) {
	const { channel, record } = resolveCallerChannel(interaction);
	requireOwner(interaction, record);

	const limit = interaction.options.getInteger('limit');
	if (limit < record.minLimit || limit > record.maxLimit) {
		throw new Error(`This channel's hub only allows a limit between ${record.minLimit} and ${record.maxLimit}.`);
	}

	await channel.setUserLimit(limit, 'Changed via /vc limit');
	await interaction.reply({
		content: limit === 0 ? 'Removed the user limit — anyone can join.' : `Set the user limit to ${limit}.`,
		ephemeral: true,
	});
}

// Denying @everyone's Connect also denies it to the bot itself unless the bot
// has its own explicit overwrite — an @everyone deny overrides the bot's
// guild-level role grant just like it would for any other member. Without
// this, the bot would lock itself out of Connect on this channel the moment
// it locks it, and since Discord only lets you touch a permission bit you
// currently hold, it could never regain Connect here again to unlock it.
// Granting this explicitly, every time, before the @everyone deny happens
// (while the bot still holds Connect via its role) makes the channel
// self-healing rather than a one-way trip.
async function ensureBotRetainsConnect(interaction, channel) {
	const botId = interaction.client.user.id;
	const botOverwrite = channel.permissionOverwrites.cache.get(botId);
	if (botOverwrite?.allow.has(PermissionFlagsBits.Connect)) return;

	await channel.permissionOverwrites.edit(botId, { Connect: true }, { reason: 'Ensuring PariahBot can always lock/unlock this channel' });
}

// @everyone's role id is always the guild id, so the overwrite target below
// needs no lookup.
async function handleLock(interaction) {
	const { channel, record } = resolveCallerChannel(interaction);
	requireOwner(interaction, record);

	await ensureBotRetainsConnect(interaction, channel);

	const everyoneOverwrite = channel.permissionOverwrites.cache.get(interaction.guildId);
	if (everyoneOverwrite?.deny.has(PermissionFlagsBits.Connect)) {
		await interaction.reply({ content: 'This channel is already locked.', ephemeral: true });
		return;
	}

	await channel.permissionOverwrites.edit(interaction.guildId, { Connect: false }, { reason: 'Locked via /vc lock' });
	await interaction.reply({
		content: "Locked the channel — people already inside can stay, but nobody new can join.",
		ephemeral: true,
	});
}

async function handleUnlock(interaction) {
	const { channel, record } = resolveCallerChannel(interaction);
	requireOwner(interaction, record);

	const everyoneOverwrite = channel.permissionOverwrites.cache.get(interaction.guildId);
	if (!everyoneOverwrite?.deny.has(PermissionFlagsBits.Connect)) {
		await interaction.reply({ content: 'This channel is already unlocked.', ephemeral: true });
		return;
	}

	// Cleared to null (neutral) rather than an explicit allow, so the channel
	// reverts to whatever it would inherit normally instead of overriding it.
	await channel.permissionOverwrites.edit(interaction.guildId, { Connect: null }, { reason: 'Unlocked via /vc unlock' });
	await interaction.reply({ content: 'Unlocked the channel — anyone can join again.', ephemeral: true });
}

async function handleKick(interaction) {
	const { channel, record } = resolveCallerChannel(interaction);
	requireOwner(interaction, record);

	const target = interaction.options.getMember('member');
	if (!target) {
		throw new Error("Couldn't find that member in this server.");
	}
	if (target.id === interaction.user.id) {
		throw new Error("You can't kick yourself — just leave the channel.");
	}
	if (target.voice.channelId !== channel.id) {
		throw new Error(`${target} isn't in this channel.`);
	}

	await target.voice.disconnect(`Kicked via /vc kick by ${interaction.user.tag}`);
	await interaction.reply({ content: `Disconnected ${target} from the channel.`, ephemeral: true });
}

const HANDLERS = {
	name: handleName,
	limit: handleLimit,
	lock: handleLock,
	unlock: handleUnlock,
	kick: handleKick,
};

module.exports = {
	data: new SlashCommandBuilder()
		.setName('vc')
		.setDescription('Manage the temporary voice channel you currently own.')
		.addSubcommand((sub) => sub
			.setName('name')
			.setDescription('Rename your channel.')
			.addStringOption((option) => option
				.setName('name')
				.setDescription('New channel name')
				.setMaxLength(100)
				.setRequired(true)))
		.addSubcommand((sub) => sub
			.setName('limit')
			.setDescription("Set your channel's user limit.")
			.addIntegerOption((option) => option
				.setName('limit')
				.setDescription('0 for no limit')
				.setMinValue(0)
				.setMaxValue(99)
				.setRequired(true)))
		.addSubcommand((sub) => sub
			.setName('lock')
			.setDescription('Stop new people from joining your channel.'))
		.addSubcommand((sub) => sub
			.setName('unlock')
			.setDescription('Let people join your channel again.'))
		.addSubcommand((sub) => sub
			.setName('kick')
			.setDescription('Disconnect someone from your channel.')
			.addUserOption((option) => option
				.setName('member')
				.setDescription('Member to disconnect')
				.setRequired(true))),
	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();
		const handler = HANDLERS[subcommand];
		if (!handler) throw new Error(`Unknown /vc subcommand: ${subcommand}`);
		await handler(interaction);
	},
};
