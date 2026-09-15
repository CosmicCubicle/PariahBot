const crypto = require('node:crypto');
const {
	ActionRowBuilder, ChannelSelectMenuBuilder, ButtonBuilder, ButtonStyle,
	ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType,
} = require('discord.js');
const voiceStore = require('../state/voiceChannels');

// /voice create is a multi-step interactive flow rather than a pile of
// slash-command options: pick categories via select menus, then a modal for
// the text/number fields, then the hub actually gets created. Category
// choices have to survive between the select-menu interaction and the later
// modal-submit interaction — those are separate Discord interactions with no
// shared state of their own — so they're held here in memory, keyed by a
// session id embedded in every component's customId. Short-lived (a human
// filling out a form takes seconds to minutes, not hours), so a bot restart
// losing in-progress wizards is an acceptable tradeoff for not needing a DB
// table for something this transient.
const SESSION_TTL_MS = 10 * 60 * 1000;
const sessions = new Map();

function pruneExpiredSessions() {
	const cutoff = Date.now() - SESSION_TTL_MS;
	for (const [id, session] of sessions) {
		if (session.createdAt < cutoff) sessions.delete(id);
	}
}

function startSession(guildId) {
	pruneExpiredSessions();
	const sessionId = crypto.randomUUID();
	sessions.set(sessionId, { guildId, categoryId: null, overflowCategoryId: null, createdAt: Date.now() });
	return sessionId;
}

function getSession(sessionId) {
	return sessions.get(sessionId) ?? null;
}

function deleteSession(sessionId) {
	sessions.delete(sessionId);
}

function describeCategory(guild, categoryId) {
	if (!categoryId) return '*none*';
	const category = guild.channels.cache.get(categoryId);
	return category ? category.name : '*previously selected category no longer exists*';
}

function buildWizardMessage(guild, sessionId, session) {
	const content = [
		'**Create a voice hub**',
		`Category: ${describeCategory(guild, session.categoryId)}`,
		`Overflow category (used if the category above hits Discord's 50-channel cap): ${describeCategory(guild, session.overflowCategoryId)}`,
		'',
		"Both categories are optional. Once you're ready, hit Continue to name the hub and set its limits.",
	].join('\n');

	const categoryRow = new ActionRowBuilder().addComponents(
		new ChannelSelectMenuBuilder()
			.setCustomId(`hub-wizard-category:${sessionId}`)
			.setPlaceholder('Category for temp channels (optional)')
			.addChannelTypes(ChannelType.GuildCategory)
			.setMinValues(0)
			.setMaxValues(1),
	);
	const overflowRow = new ActionRowBuilder().addComponents(
		new ChannelSelectMenuBuilder()
			.setCustomId(`hub-wizard-overflow:${sessionId}`)
			.setPlaceholder('Overflow category (optional)')
			.addChannelTypes(ChannelType.GuildCategory)
			.setMinValues(0)
			.setMaxValues(1),
	);
	const buttonRow = new ActionRowBuilder().addComponents(
		new ButtonBuilder().setCustomId(`hub-wizard-continue:${sessionId}`).setLabel('Continue').setStyle(ButtonStyle.Primary),
		new ButtonBuilder().setCustomId(`hub-wizard-cancel:${sessionId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
	);

	return { content, components: [categoryRow, overflowRow, buttonRow] };
}

function buildModal(sessionId) {
	return new ModalBuilder()
		.setCustomId(`hub-wizard-modal:${sessionId}`)
		.setTitle('Configure your voice hub')
		.addComponents(
			new ActionRowBuilder().addComponents(
				new TextInputBuilder()
					.setCustomId('hubName')
					.setLabel('Hub channel name')
					.setStyle(TextInputStyle.Short)
					.setMaxLength(100)
					.setRequired(false)
					.setPlaceholder('➕ Join to Create'),
			),
			new ActionRowBuilder().addComponents(
				new TextInputBuilder()
					.setCustomId('nameTemplate')
					.setLabel('Temp channel name (use {owner})')
					.setStyle(TextInputStyle.Short)
					.setMaxLength(100)
					.setRequired(false)
					.setPlaceholder("🔊 {owner}'s channel"),
			),
			new ActionRowBuilder().addComponents(
				new TextInputBuilder()
					.setCustomId('minLimit')
					.setLabel('Minimum user limit an owner can set')
					.setStyle(TextInputStyle.Short)
					.setMaxLength(2)
					.setRequired(false)
					.setPlaceholder('0'),
			),
			new ActionRowBuilder().addComponents(
				new TextInputBuilder()
					.setCustomId('maxLimit')
					.setLabel('Maximum user limit an owner can set')
					.setStyle(TextInputStyle.Short)
					.setMaxLength(2)
					.setRequired(false)
					.setPlaceholder('99'),
			),
		);
}

// Parses and validates the modal's raw text fields; returns { errors } if
// anything's wrong (caller replies with the first one) or the clamped,
// defaulted values ready to persist otherwise.
function parseModalFields(interaction) {
	const hubName = interaction.fields.getTextInputValue('hubName').trim() || '➕ Join to Create';
	const nameTemplate = interaction.fields.getTextInputValue('nameTemplate').trim() || "🔊 {owner}'s channel";
	const minLimitRaw = interaction.fields.getTextInputValue('minLimit').trim();
	const maxLimitRaw = interaction.fields.getTextInputValue('maxLimit').trim();

	const minLimit = minLimitRaw === '' ? 0 : Number.parseInt(minLimitRaw, 10);
	const maxLimit = maxLimitRaw === '' ? 99 : Number.parseInt(maxLimitRaw, 10);

	if (!Number.isInteger(minLimit) || !Number.isInteger(maxLimit) || minLimit < 0 || maxLimit < 0 || minLimit > 99 || maxLimit > 99) {
		return { error: 'Limits must be whole numbers between 0 and 99.' };
	}
	if (minLimit > maxLimit) {
		return { error: `Minimum limit (${minLimit}) can't be greater than the maximum (${maxLimit}).` };
	}

	return { hubName, nameTemplate, minLimit, maxLimit };
}

// Creates the actual Discord channel and registers it — called once the modal
// has been validated. Throws on a real Discord API failure; the caller (the
// modal-submit branch in handleWizardInteraction) is responsible for
// reporting that the same way any other command error is reported.
async function createHub(interaction, session, fields) {
	const category = session.categoryId ? interaction.guild.channels.cache.get(session.categoryId) : null;

	const hub = await interaction.guild.channels.create({
		name: fields.hubName,
		type: ChannelType.GuildVoice,
		parent: category?.id ?? undefined,
	});

	try {
		voiceStore.addHub(interaction.guildId, hub.id, {
			categoryId: session.categoryId,
			overflowCategoryId: session.overflowCategoryId,
			nameTemplate: fields.nameTemplate,
			minLimit: fields.minLimit,
			maxLimit: fields.maxLimit,
		});
	} catch (error) {
		// Only realistically happens if a freshly-created channel's snowflake
		// somehow collided with an existing hub row — practically impossible,
		// but leaving an orphaned channel behind on any failure would be worse.
		await hub.delete('Cleaning up after failed hub registration').catch(() => null);
		throw error;
	}

	return hub;
}

// Dispatches every component/modal interaction belonging to this wizard;
// returns false for anything else so interactionCreate.js can try other
// features' handlers in sequence, same pattern as lib/hubDesync.js's button
// handler. No permission re-check here deliberately: every wizard message is
// sent ephemeral, which Discord itself restricts to the one user who ran
// /voice create — unlike hubDesync's buttons (posted to a shared alert
// channel or DMed), there's no one else who could ever see these to click them.
async function handleWizardInteraction(interaction) {
	const customId = interaction.customId;
	if (!customId || !customId.startsWith('hub-wizard-')) return false;

	const [, sessionId] = customId.split(':');

	if (interaction.isChannelSelectMenu()) {
		const session = getSession(sessionId);
		if (!session) {
			await interaction.update({ content: "This setup expired — run `/voice create` again.", components: [] });
			return true;
		}

		const selectedId = interaction.values[0] ?? null;
		if (customId.startsWith('hub-wizard-category:')) session.categoryId = selectedId;
		else if (customId.startsWith('hub-wizard-overflow:')) session.overflowCategoryId = selectedId;

		await interaction.update(buildWizardMessage(interaction.guild, sessionId, session));
		return true;
	}

	if (interaction.isButton() && customId.startsWith('hub-wizard-cancel:')) {
		deleteSession(sessionId);
		await interaction.update({ content: 'Cancelled — no hub was created.', components: [] });
		return true;
	}

	if (interaction.isButton() && customId.startsWith('hub-wizard-continue:')) {
		const session = getSession(sessionId);
		if (!session) {
			await interaction.reply({ content: "This setup expired — run `/voice create` again.", ephemeral: true });
			return true;
		}
		// showModal() must be the interaction's only/first response — no prior
		// reply/update/defer, which is why Continue doesn't touch the original
		// message itself; that gets cleaned up below once the modal is submitted.
		await interaction.showModal(buildModal(sessionId));
		return true;
	}

	if (interaction.isModalSubmit() && customId.startsWith('hub-wizard-modal:')) {
		const session = getSession(sessionId);
		if (!session) {
			await interaction.reply({ content: "This setup expired — run `/voice create` again.", ephemeral: true });
			return true;
		}

		const fields = parseModalFields(interaction);
		if (fields.error) {
			await interaction.reply({ content: fields.error, ephemeral: true });
			return true;
		}

		deleteSession(sessionId);
		const hub = await createHub(interaction, session, fields);

		await interaction.reply({
			content: [
				`Created ${hub} as a voice hub.`,
				`Category: ${describeCategory(interaction.guild, session.categoryId)}`,
				`Overflow category: ${describeCategory(interaction.guild, session.overflowCategoryId)}`,
				`Temp channel names: ${fields.nameTemplate}`,
				`User limit range: ${fields.minLimit}-${fields.maxLimit}`,
			].join('\n'),
			ephemeral: true,
		});

		// Best-effort: clears the now-stale select menus/buttons off the original
		// wizard message. Not critical if this fails or isn't available.
		await interaction.message?.edit({ content: 'Hub created — see the confirmation below.', components: [] }).catch(() => null);

		return true;
	}

	return false;
}

module.exports = {
	startSession,
	getSession,
	deleteSession,
	describeCategory,
	buildWizardMessage,
	buildModal,
	parseModalFields,
	createHub,
	handleWizardInteraction,
};
