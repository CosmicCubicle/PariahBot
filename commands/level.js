const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getStanding } = require('../lib/leveling');
const levelStore = require('../state/levels');

async function handleRank(interaction) {
	const target = interaction.options.getUser('user') ?? interaction.user;
	const standing = getStanding(interaction.guildId, target.id);

	const embed = new EmbedBuilder()
		.setTitle(`${target.username}'s rank`)
		.setColor(0x5865f2)
		.setDescription(`Level **${standing.level}** — ${standing.xp}/${standing.xpForNextLevel} XP`);

	await interaction.reply({ embeds: [embed] });
}

async function handleLeaderboard(interaction) {
	const top = levelStore.listTopForGuild(interaction.guildId, 10);

	const embed = new EmbedBuilder().setTitle('Leaderboard').setColor(0x5865f2);

	if (top.length === 0) {
		embed.setDescription('Nobody has earned any XP in this server yet.');
	} else {
		embed.setDescription(top.map((row, index) => `**${index + 1}.** <@${row.userId}> — Level ${row.level} (${row.xp} XP)`).join('\n'));
	}

	await interaction.reply({ embeds: [embed] });
}

const HANDLERS = {
	rank: handleRank,
	leaderboard: handleLeaderboard,
};

module.exports = {
	data: new SlashCommandBuilder()
		.setName('level')
		.setDescription('Check message-activity levels for this server.')
		.addSubcommand((sub) => sub
			.setName('rank')
			.setDescription("Show your (or someone else's) level and XP.")
			.addUserOption((option) => option
				.setName('user')
				.setDescription('Member to check (defaults to you)')
				.setRequired(false)))
		.addSubcommand((sub) => sub
			.setName('leaderboard')
			.setDescription('Show the top 10 members by XP in this server.')),
	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();
		const handler = HANDLERS[subcommand];
		if (!handler) throw new Error(`Unknown /level subcommand: ${subcommand}`);
		await handler(interaction);
	},
};
