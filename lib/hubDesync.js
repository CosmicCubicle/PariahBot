const { ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder } = require('discord.js');
const voiceStore = require('../state/voiceChannels');
const voiceHubs = require('./voiceHubs');
const { sendAlert } = require('./alertDelivery');
const { isMod } = require('./permissions');
const features = require('./features');

const PRUNE_ACTION = 'voice-hub-prune';
const RESTORE_ACTION = 'voice-hub-restore';

function findDeadHubs(guild) {
	return voiceStore.listHubs(guild.id).filter((hub) => !guild.channels.cache.has(hub.channelId));
}

// One full message (embed + button row) per dead hub, rather than one message
// covering several — clicking Prune/Restore can then just clear that whole message
// with interaction.update(), with no need to reconstruct a partial embed/component
// list for whichever hubs are still unresolved.
function buildDeadHubMessage(hub) {
	const embed = new EmbedBuilder()
		.setTitle('⚠️ Voice hub desync detected')
		.setColor(0xed4245)
		.setDescription(`A registered voice hub's channel (\`${hub.channelId}\`) no longer exists in Discord.`)
		.setFooter({ text: 'Prune to forget it, or Restore to recreate it with the same category and limits.' })
		.setTimestamp();

	const row = new ActionRowBuilder().addComponents(
		new ButtonBuilder().setCustomId(`${PRUNE_ACTION}:${hub.guildId}:${hub.channelId}`).setLabel('Prune').setStyle(ButtonStyle.Danger),
		new ButtonBuilder().setCustomId(`${RESTORE_ACTION}:${hub.guildId}:${hub.channelId}`).setLabel('Restore').setStyle(ButtonStyle.Success),
	);

	return { embeds: [embed], components: [row] };
}

async function checkAndNotifyDeadHubs(guild) {
	const deadHubs = findDeadHubs(guild);
	for (const hub of deadHubs) {
		await sendAlert(guild, buildDeadHubMessage(hub));
	}
	return deadHubs;
}

// A button click can arrive from within the guild (interaction.guild and
// memberPermissions already resolved by discord.js) or from a DM — sendAlert can DM
// this same message to every configured recipient, and a DM interaction has no
// member/guild context at all, so both the guild and the clicker's permission in it
// have to be resolved by hand in that case.
async function resolveActingGuildAndPermission(interaction, guildId) {
	const guild = interaction.guild ?? interaction.client.guilds.cache.get(guildId);
	if (!guild) return { guild: null, hasPermission: false };

	// isMod reads the member's roles, not just their permission bits, so even
	// the in-guild path needs the member object — interaction.memberPermissions
	// carries bits alone and can't answer "do they hold a mod role".
	const member = interaction.member
		?? await guild.members.fetch(interaction.user.id).catch(() => null);

	// No longer a member of that guild — can't verify, so fail closed (§5).
	if (!member) return { guild, hasPermission: false };

	return { guild, hasPermission: isMod(member, guild.id) };
}

async function handleHubPrune(interaction, guild, hubChannelId) {
	const removed = voiceHubs.pruneHub(guild, hubChannelId);
	await interaction.update({
		content: removed ? `Pruned hub \`${hubChannelId}\` — no longer tracked.` : `Hub \`${hubChannelId}\` was already resolved.`,
		embeds: [],
		components: [],
	});
}

// If two people click Restore/Prune on the same hub around the same time, the
// first one to land already changed or removed the hub, so restoreHub finds
// nothing and this reports "already resolved" instead of double-creating it.
async function handleHubRestore(interaction, guild, hubChannelId) {
	const newChannel = await voiceHubs.restoreHub(guild, hubChannelId);
	await interaction.update({
		content: newChannel ? `Restored the hub as ${newChannel}.` : `Hub \`${hubChannelId}\` was already resolved (pruned or restored elsewhere).`,
		embeds: [],
		components: [],
	});
}

// Returns true if this button belonged to us (handled or denied), false if it's
// some other feature's button and interactionCreate.js should ignore it.
async function handleHubButtonInteraction(interaction) {
	const [action, guildId, hubChannelId] = interaction.customId.split(':');
	if (action !== PRUNE_ACTION && action !== RESTORE_ACTION) return false;

	// Switched off (#69). Answered rather than returning false: false means
	// "not my button", which would leave the click unanswered.
	// guildId from the customId, not interaction.guildId: these buttons are also
	// DMed to alert recipients, where interaction.guildId is null.
	if (!features.isEnabled(guildId, 'tempVoice')) {
		await interaction.reply({ content: features.disabledMessage('tempVoice'), ephemeral: true }).catch(() => null);
		return true;
	}

	const { guild, hasPermission } = await resolveActingGuildAndPermission(interaction, guildId);

	if (!guild) {
		await interaction.update({ content: 'That server is no longer available.', embeds: [], components: [] }).catch(() => null);
		return true;
	}

	if (!hasPermission) {
		await interaction.reply({ content: 'You need to be staff in that server to do this: a mod role, an admin role, or Administrator.', ephemeral: true });
		return true;
	}

	if (action === PRUNE_ACTION) {
		await handleHubPrune(interaction, guild, hubChannelId);
	} else {
		await handleHubRestore(interaction, guild, hubChannelId);
	}
	return true;
}

module.exports = { findDeadHubs, buildDeadHubMessage, checkAndNotifyDeadHubs, handleHubButtonInteraction };
