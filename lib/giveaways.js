const { randomInt } = require('node:crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const giveawayStore = require('../state/giveaways');

const BUTTON_PREFIX = 'giveaway:enter:';
const MAX_TIMEOUT = 2_147_000_000;

function buildRow(id) {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId(`${BUTTON_PREFIX}${id}`)
			.setLabel('Enter giveaway')
			.setStyle(ButtonStyle.Primary),
	);
}

function buildEmbed(giveaway, entryCount = 0) {
	return new EmbedBuilder()
		.setTitle(`Giveaway: ${giveaway.prize}`)
		.setColor(0xf1c40f)
		.setDescription(`Click the button below to enter. Winners: **${giveaway.winnerCount ?? giveaway.winner_count}**\nEntries: **${entryCount}**`)
		.addFields({ name: 'Ends', value: `<t:${Math.floor(new Date(giveaway.endsAt ?? giveaway.ends_at).getTime() / 1000)}:F>` });
}

function chooseWinners(entries, count) {
	const remaining = [...entries];
	const winners = [];
	while (remaining.length && winners.length < count) {
		winners.push(remaining.splice(randomInt(remaining.length), 1)[0]);
	}
	return winners;
}

async function finishGiveaway(client, giveawayId, force = false) {
	const giveaway = giveawayStore.listActiveGiveaways().find((item) => item.giveaway_id === giveawayId);
	if (!giveaway || (!force && new Date(giveaway.ends_at).getTime() > Date.now())) return false;
	if (!giveawayStore.finish(giveawayId)) return false;

	const entries = giveawayStore.getEntries(giveawayId);
	const winners = chooseWinners(entries, giveaway.winner_count);
	const channel = await client.channels.fetch(giveaway.channel_id).catch(() => null);
	if (!channel?.isTextBased()) return true;

	const message = giveaway.message_id
		? await channel.messages.fetch(giveaway.message_id).catch(() => null)
		: null;
	if (message) {
		await message.edit({
			embeds: [buildEmbed({ ...giveaway, prize: `Ended: ${giveaway.prize}` }, entries.length)],
			components: [],
		}).catch(() => null);
	}

	const result = winners.length
		? `Congratulations ${winners.map((id) => `<@${id}>`).join(', ')}! You won **${giveaway.prize}**.`
		: `The giveaway for **${giveaway.prize}** ended without any entries.`;
	await channel.send(result).catch(() => null);
	return true;
}

function scheduleGiveaway(client, giveaway) {
	const delay = Math.max(0, new Date(giveaway.ends_at ?? giveaway.endsAt).getTime() - Date.now());
	if (delay > MAX_TIMEOUT) {
		setTimeout(() => scheduleGiveaway(client, giveaway), MAX_TIMEOUT);
		return;
	}
	setTimeout(() => finishGiveaway(client, giveaway.giveaway_id).catch((error) => {
		console.error(`Giveaway ${giveaway.giveaway_id} failed to finish:`, error.message);
	}), delay);
}

function scheduleActiveGiveaways(client) {
	for (const giveaway of giveawayStore.listActiveGiveaways()) scheduleGiveaway(client, giveaway);
}

async function handleEntryInteraction(interaction) {
	if (!interaction.customId.startsWith(BUTTON_PREFIX)) return false;

	const giveawayId = interaction.customId.slice(BUTTON_PREFIX.length);
	const giveaway = giveawayStore.get(giveawayId, interaction.guildId);
	if (!giveaway || giveaway.status !== 'active') {
		await interaction.reply({ content: 'This giveaway is no longer active.', ephemeral: true });
		return true;
	}
	if (new Date(giveaway.ends_at).getTime() <= Date.now()) {
		await interaction.reply({ content: 'This giveaway has ended.', ephemeral: true });
		return true;
	}

	const added = giveawayStore.enter(giveawayId, interaction.user.id);
	await interaction.reply({ content: added ? 'You are entered in the giveaway.' : 'Already entered this giveaway.', ephemeral: true });
	return true;
}

module.exports = { buildEmbed, buildRow, scheduleActiveGiveaways, scheduleGiveaway, handleEntryInteraction, finishGiveaway };