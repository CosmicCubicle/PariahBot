const { randomUUID } = require('node:crypto');
const { SlashCommandBuilder } = require('discord.js');
const giveawayStore = require('../state/giveaways');
const giveaways = require('../lib/giveaways');
const { requireAdmin } = require('../lib/permissions');

async function handleCreate(interaction) {
	requireAdmin(interaction);

	const durationMinutes = interaction.options.getInteger('duration');
	const giveaway = {
		id: randomUUID(),
		guildId: interaction.guildId,
		channelId: interaction.channelId,
		prize: interaction.options.getString('prize'),
		winnerCount: interaction.options.getInteger('winners'),
		endsAt: new Date(Date.now() + durationMinutes * 60 * 1000).toISOString(),
		createdBy: interaction.user.id,
	};

	giveawayStore.create(giveaway);
	try {
		const message = await interaction.channel.send({
			embeds: [giveaways.buildEmbed(giveaway)],
			components: [giveaways.buildRow(giveaway.id)],
		});
		giveawayStore.attachMessage(giveaway.id, giveaway.guildId, message.id);
		giveaways.scheduleGiveaway(interaction.client, { ...giveaway, giveaway_id: giveaway.id, message_id: message.id });
	} catch (error) {
		throw new Error(`Giveaway could not be posted: ${error.message}`);
	}

	await interaction.reply({ content: `Giveaway created. ID: \`${giveaway.id}\``, ephemeral: true });
}

async function handleEnd(interaction) {
	requireAdmin(interaction);

	const id = interaction.options.getString('id');
	const giveaway = giveawayStore.get(id, interaction.guildId);
	if (!giveaway || giveaway.status !== 'active') throw new Error('That giveaway does not exist or has already ended.');

	await interaction.deferReply({ ephemeral: true });
	await giveaways.finishGiveaway(interaction.client, id, true);
	await interaction.editReply({ content: 'Giveaway ended and winners were announced.' });
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName('giveaway')
		.setDescription('Create and manage server giveaways.')
		.addSubcommand((sub) => sub
			.setName('create')
			.setDescription('(Admin) Start a giveaway in this channel.')
			.addStringOption((option) => option.setName('prize').setDescription('What the winner will receive').setRequired(true).setMaxLength(256))
			.addIntegerOption((option) => option.setName('duration').setDescription('How many minutes the giveaway runs').setRequired(true).setMinValue(1).setMaxValue(43200))
			.addIntegerOption((option) => option.setName('winners').setDescription('Number of winners').setRequired(true).setMinValue(1).setMaxValue(20)))
		.addSubcommand((sub) => sub
			.setName('end')
			.setDescription('(Admin) End an active giveaway immediately.')
			.addStringOption((option) => option.setName('id').setDescription('Giveaway ID from its creation reply').setRequired(true))),
	async execute(interaction) {
		const handler = interaction.options.getSubcommand() === 'create' ? handleCreate : handleEnd;
		await handler(interaction);
	},
};