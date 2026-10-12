const { SlashCommandBuilder, ChannelType, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const store = require('../state/serverLog');
const serverLog = require('../lib/serverLog');
const { requireAdmin } = require('../lib/permissions');

const POST_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

// The section option comes from fixed choices, but a choice is still just a
// string the client sends, so it's checked like any other.
function requireSection(interaction) {
	const section = interaction.options.getString('section', true);
	if (!serverLog.isSection(section)) throw new Error('Pick one of the listed sections.');
	return section;
}

// Problems that remain after a change, so the reply says up front why a
// section that's on may still log nothing.
function problemLines(interaction, section) {
	const { channelId } = store.getSection(interaction.guildId, section);
	const lines = serverLog.sectionProblems(interaction.guild, section, channelId).map((problem) => `⚠️ ${problem}`);
	const [described] = serverLog.describeSections(interaction.guild).filter((entry) => entry.key === section);
	if (described.note) lines.push(`ℹ️ ${described.note}`);
	return lines.length ? `\n${lines.join('\n')}` : '';
}

async function handleSet(interaction) {
	requireAdmin(interaction);

	const section = requireSection(interaction);
	const channel = interaction.options.getChannel('channel', true);
	if (!channel.permissionsFor(interaction.guild.members.me).has(POST_PERMISSIONS)) {
		throw new Error(`I can't post in ${channel}. Give me View Channel, Send Messages and Embed Links there, then run this again.`);
	}

	store.setChannel(interaction.guildId, section, channel.id);
	const { label } = serverLog.SECTIONS[section];
	await interaction.reply({ content: `**${label}** is on, posting to ${channel}.${problemLines(interaction, section)}`, ephemeral: true });
}

async function handleEnable(interaction) {
	requireAdmin(interaction);

	const section = requireSection(interaction);
	const { label } = serverLog.SECTIONS[section];
	const { enabled, channelId } = store.getSection(interaction.guildId, section);
	if (!channelId) throw new Error(`**${label}** has no channel yet. Pick one with \`/logging set section:${section}\`.`);
	if (enabled) {
		await interaction.reply({ content: `**${label}** was already on.${problemLines(interaction, section)}`, ephemeral: true });
		return;
	}

	store.setEnabled(interaction.guildId, section, true);
	await interaction.reply({ content: `**${label}** is on again, posting to <#${channelId}>.${problemLines(interaction, section)}`, ephemeral: true });
}

async function handleDisable(interaction) {
	requireAdmin(interaction);

	const section = requireSection(interaction);
	const { label } = serverLog.SECTIONS[section];
	if (!store.getSection(interaction.guildId, section).enabled) {
		await interaction.reply({ content: `**${label}** was already off.`, ephemeral: true });
		return;
	}

	store.setEnabled(interaction.guildId, section, false);
	await interaction.reply({ content: `**${label}** is off. Its channel is kept, so \`/logging enable\` turns it back on.`, ephemeral: true });
}

async function handleStatus(interaction) {
	requireAdmin(interaction);

	const embed = new EmbedBuilder()
		.setTitle('Server log')
		.setColor(0x5865f2)
		.setDescription('Each section posts to its own channel. Set one with `/logging set`.');

	for (const entry of serverLog.describeSections(interaction.guild)) {
		const state = entry.enabled && entry.channelId ? `On → <#${entry.channelId}>` : (entry.channelId ? `Off (channel kept: <#${entry.channelId}>)` : 'Off');
		const extra = [...entry.problems.map((problem) => `⚠️ ${problem}`), ...(entry.note ? [`ℹ️ ${entry.note}`] : [])];
		embed.addFields({ name: entry.label, value: serverLog.truncate([state, entry.description, ...extra].join('\n')) });
	}

	await interaction.reply({ embeds: [embed], ephemeral: true });
}

const HANDLERS = {
	set: handleSet,
	enable: handleEnable,
	disable: handleDisable,
	status: handleStatus,
};

function sectionOption(option, description) {
	return option
		.setName('section')
		.setDescription(description)
		.setRequired(true)
		.addChoices(...serverLog.SECTION_KEYS.map((key) => ({ name: serverLog.SECTIONS[key].label, value: key })));
}

module.exports = {
	// Switchable feature set this command belongs to (lib/features.js).
	// events/interactionCreate.js refuses it when the guild has it off.
	feature: 'logging',
	data: new SlashCommandBuilder()
		.setName('logging')
		.setDescription('(Admin) Log what happens in this server to channels you choose.')
		.addSubcommand((sub) => sub
			.setName('set')
			.setDescription('(Admin) Choose the channel for a log section, and switch it on.')
			.addStringOption((option) => sectionOption(option, 'What to log'))
			.addChannelOption((option) => option
				.setName('channel')
				.setDescription('Where to post it')
				.addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
				.setRequired(true)))
		.addSubcommand((sub) => sub
			.setName('enable')
			.setDescription('(Admin) Switch a log section back on, in the channel it had.')
			.addStringOption((option) => sectionOption(option, 'Section to switch on')))
		.addSubcommand((sub) => sub
			.setName('disable')
			.setDescription('(Admin) Switch a log section off. Its channel is kept.')
			.addStringOption((option) => sectionOption(option, 'Section to switch off')))
		.addSubcommand((sub) => sub
			.setName('status')
			.setDescription('(Admin) Show every log section, its channel, and anything stopping it.')),
	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();
		const handler = HANDLERS[subcommand];
		if (!handler) throw new Error(`Unknown /logging subcommand: ${subcommand}`);
		await handler(interaction);
	},
};
