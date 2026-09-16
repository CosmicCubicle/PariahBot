const {
	EmbedBuilder,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
	PermissionFlagsBits,
} = require('discord.js');
const guildSettings = require('../state/guildSettings');

const EMBED_COLOR = 0x5865f2;
const START_ACTION = 'securityVerifyStart';
const ANSWER_ACTION = 'securityVerifyAnswer';

const CHOICES_PER_CHALLENGE = 5;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// Deliberately distinct at a glance — no two that read alike, so a member
// never fails because two options looked the same.
const CHOICE_POOL = [
	{ value: 'dolphin', emoji: '🐬', label: 'Dolphin' },
	{ value: 'rocket', emoji: '🚀', label: 'Rocket' },
	{ value: 'apple', emoji: '🍎', label: 'Apple' },
	{ value: 'tree', emoji: '🌲', label: 'Tree' },
	{ value: 'star', emoji: '⭐', label: 'Star' },
	{ value: 'anchor', emoji: '⚓', label: 'Anchor' },
	{ value: 'guitar', emoji: '🎸', label: 'Guitar' },
	{ value: 'camera', emoji: '📷', label: 'Camera' },
	{ value: 'balloon', emoji: '🎈', label: 'Balloon' },
	{ value: 'cactus', emoji: '🌵', label: 'Cactus' },
];

// userId -> { answer, expiresAt }. Deliberately in memory rather than SQLite:
// a pending challenge is ephemeral and trivially rebuilt (the member just
// clicks Start again), and keeping the answer server-side means it never
// ships to the client the way encoding it in the select menu's customId
// would. See CLAUDE.md's note on lib/autoDelete.js for the same reasoning.
const pendingChallenges = new Map();

function shuffle(items) {
	const copy = [...items];
	for (let i = copy.length - 1; i > 0; i -= 1) {
		const j = Math.floor(Math.random() * (i + 1));
		[copy[i], copy[j]] = [copy[j], copy[i]];
	}
	return copy;
}

// Picks a fresh set of options and a random correct one among them, so the
// same member retrying gets a different target and a different ordering.
function createChallenge(userId) {
	const choices = shuffle(CHOICE_POOL).slice(0, CHOICES_PER_CHALLENGE);
	const answer = choices[Math.floor(Math.random() * choices.length)];

	pendingChallenges.set(userId, { answer: answer.value, expiresAt: Date.now() + CHALLENGE_TTL_MS });
	return { choices, answer };
}

function takeChallengeAnswer(userId) {
	const pending = pendingChallenges.get(userId);
	if (!pending) return null;

	pendingChallenges.delete(userId);
	return pending.expiresAt > Date.now() ? pending.answer : null;
}

function buildScreeningMessage() {
	const embed = new EmbedBuilder()
		.setTitle('Verify yourself')
		.setColor(EMBED_COLOR)
		.setDescription([
			'This server asks new members to complete a quick check before getting access.',
			'',
			'Press **Start verification** below. You will be asked to pick one specific option from a menu — only you can see it, and it takes a few seconds.',
		].join('\n'));

	const row = new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId(START_ACTION)
			.setLabel('Start verification')
			.setEmoji('✅')
			.setStyle(ButtonStyle.Primary),
	);

	return { embeds: [embed], components: [row] };
}

function buildChallengeComponents(choices) {
	const menu = new StringSelectMenuBuilder()
		.setCustomId(ANSWER_ACTION)
		.setPlaceholder('Pick the option you were asked for')
		.setMinValues(1)
		.setMaxValues(1)
		.addOptions(choices.map((choice) => new StringSelectMenuOptionBuilder()
			.setLabel(choice.label)
			.setValue(choice.value)
			.setEmoji(choice.emoji)));

	return [new ActionRowBuilder().addComponents(menu)];
}

// Posts (or refreshes) the persistent Verify message and locks the channel
// down so unverified members can see it but not talk in it. Inverse of
// lib/roleAssignmentChannel.js, which hides its channel from @everyone —
// this one has to stay visible to people who have no roles yet.
async function setupScreeningChannel(channel, existingMessageId) {
	const everyoneId = channel.guild.roles.everyone.id;
	const botId = channel.client.user.id;
	const reason = 'PariahBot captcha screening channel';

	await channel.permissionOverwrites.edit(everyoneId, { ViewChannel: true, SendMessages: false }, { reason });
	await channel.permissionOverwrites.edit(botId, { ViewChannel: true, SendMessages: true }, { reason });

	const payload = buildScreeningMessage();

	if (existingMessageId) {
		const existing = await channel.messages.fetch(existingMessageId).catch(() => null);
		if (existing) {
			await existing.edit(payload);
			return existing;
		}
	}

	return channel.send(payload);
}

// One role-level change instead of an overwrite on every channel: dropping
// ViewChannel from @everyone hides everything that doesn't explicitly grant
// it back, including channels created later, which per-channel overwrites
// would silently miss.
async function applyVisibilityLockdown(guild, memberRoleId) {
	const reason = 'PariahBot captcha visibility lockdown';
	const everyone = guild.roles.everyone;
	const memberRole = guild.roles.cache.get(memberRoleId) ?? await guild.roles.fetch(memberRoleId).catch(() => null);

	if (!memberRole) {
		throw new Error("The configured member role no longer exists — set it again with `/setup member-role`.");
	}

	await everyone.setPermissions(everyone.permissions.remove(PermissionFlagsBits.ViewChannel), reason);
	await memberRole.setPermissions(memberRole.permissions.add(PermissionFlagsBits.ViewChannel), reason);
}

async function grantMemberRole(interaction, memberRoleId) {
	const botMember = interaction.guild.members.me;
	const role = interaction.guild.roles.cache.get(memberRoleId);

	if (!role) {
		throw new Error('The configured member role no longer exists — an admin needs to set it again.');
	}
	if (botMember.roles.highest.position <= role.position) {
		throw new Error(`I can't grant ${role} — my own role sits below it. An admin needs to move my role above it.`);
	}

	await interaction.member.roles.add(role, 'Passed PariahBot captcha');
	return role;
}

// Returns false for any customId that isn't ours, matching the convention in
// lib/hubDesync.js and lib/roleMenus.js so interactionCreate.js can fall
// through to other handlers.
async function handleVerifyStartInteraction(interaction) {
	if (interaction.customId !== START_ACTION) return false;

	const { memberRoleId } = guildSettings.getGuildSettings(interaction.guildId);
	if (!memberRoleId) {
		await interaction.reply({ content: "Verification isn't fully set up yet — no member role is configured. Let an admin know.", ephemeral: true });
		return true;
	}

	if (interaction.member.roles.cache.has(memberRoleId)) {
		await interaction.reply({ content: "You're already verified — you have access already.", ephemeral: true });
		return true;
	}

	const { choices, answer } = createChallenge(interaction.user.id);

	await interaction.reply({
		content: `To verify, select **${answer.emoji} ${answer.label}** from the menu below.`,
		components: buildChallengeComponents(choices),
		ephemeral: true,
	});
	return true;
}

async function handleVerifyAnswerInteraction(interaction) {
	if (interaction.customId !== ANSWER_ACTION) return false;

	const expected = takeChallengeAnswer(interaction.user.id);
	const picked = interaction.values[0];

	if (!expected) {
		await interaction.update({
			content: 'That check expired. Press **Start verification** again for a new one.',
			components: [],
		});
		return true;
	}

	if (picked !== expected) {
		await interaction.update({
			content: "That wasn't the option you were asked for. Press **Start verification** again to try once more.",
			components: [],
		});
		return true;
	}

	const { memberRoleId } = guildSettings.getGuildSettings(interaction.guildId);
	const role = await grantMemberRole(interaction, memberRoleId);

	await interaction.update({ content: `Verified — you've been given ${role}. Welcome in.`, components: [] });
	return true;
}

module.exports = {
	setupScreeningChannel,
	applyVisibilityLockdown,
	handleVerifyStartInteraction,
	handleVerifyAnswerInteraction,
};
