const {
	ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType,
} = require('discord.js');
const voiceStore = require('../state/voiceChannels');

// /voice create and /voice edit each open a single modal directly as their
// response to the slash command — no buttons, no select menus, no in-memory
// session. Everything needed to create or update a hub travels in one modal
// submission, so there's no cross-interaction state to track at all: mode and
// (for edit) which hub is encoded right in the modal's customId.
//
// A modal caps out at 5 text-input fields, and categories can't be a Discord
// select menu here (a select menu can only reference channels that already
// exist, but an admin needs to be able to type one that doesn't and have it
// created) — so both categories are free-text, find-or-create by name, same
// rule the very first (pre-wizard) version of this command used: names aren't
// unique in Discord, so the first cache match wins, since a category here is
// just a placement hint, not an identity anything else depends on. Min/max
// (and optionally the starting/base limit) share one "range" field to make
// room for the other four fields — see parseLimitRange for its formats.

// Case-insensitive category lookup.
function findCategoryByName(guild, name) {
	if (!name) return null;
	return guild.channels.cache.find(
		(channel) => channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === name.toLowerCase(),
	) ?? null;
}

async function resolveOrCreateCategory(guild, name) {
	if (!name) return null;
	return findCategoryByName(guild, name) ?? guild.channels.create({ name, type: ChannelType.GuildCategory });
}

// minLimit === 0 and maxLimit === 99 are indistinguishable from "never
// configured" (they're also the schema defaults) — an admin who explicitly
// wants exactly those values gets identical behavior either way, so treating
// them as "unset" for this fallback is a harmless simplification. Used
// whenever the limit-range field doesn't spell out an explicit base limit.
function resolveDefaultLimit(minLimit, maxLimit) {
	if (minLimit > 0) return minLimit;
	if (maxLimit < 99) return maxLimit;
	return 0;
}

// Accepts blank (unlimited range, auto base), a single number ("10" -> 0-10,
// auto base), a min-max range ("2-10", auto base), or a full
// min-base-max range ("2-5-10") for explicit control over the starting
// limit too. Returns { error } or the fully resolved { minLimit, maxLimit,
// defaultLimit } — the base/starting limit is always resolved here, never
// left for the caller to figure out.
function parseLimitRange(raw) {
	const trimmed = raw.trim();
	if (trimmed === '') return { minLimit: 0, maxLimit: 99, defaultLimit: resolveDefaultLimit(0, 99) };

	const parts = trimmed.split('-').map((part) => part.trim());
	if (parts.length > 3 || parts.some((part) => !/^\d{1,2}$/.test(part))) {
		return { error: 'User limit range must be blank, a single number (10), min-max (2-10), or min-base-max (2-5-10).' };
	}

	const numbers = parts.map((part) => Number.parseInt(part, 10));
	if (numbers.some((n) => n > 99)) return { error: 'Limits must be between 0 and 99.' };

	let minLimit;
	let maxLimit;
	let explicitDefault = null;
	if (numbers.length === 1) {
		[maxLimit] = numbers;
		minLimit = 0;
	} else if (numbers.length === 2) {
		[minLimit, maxLimit] = numbers;
	} else {
		[minLimit, explicitDefault, maxLimit] = numbers;
	}

	if (minLimit > maxLimit) return { error: `Minimum limit (${minLimit}) can't be greater than the maximum (${maxLimit}).` };
	if (explicitDefault !== null && (explicitDefault < minLimit || explicitDefault > maxLimit)) {
		return { error: `Starting limit (${explicitDefault}) must be between the min (${minLimit}) and max (${maxLimit}).` };
	}

	return { minLimit, maxLimit, defaultLimit: explicitDefault ?? resolveDefaultLimit(minLimit, maxLimit) };
}

// current.minLimit/maxLimit of 0/99 (the schema defaults, indistinguishable
// from "never set") render as a blank field rather than a literal "0-99", so
// re-submitting an untouched edit modal doesn't look like it explicitly typed
// a range it never did. Only spelled out as the full min-base-max form when
// the current starting limit isn't what the auto-fallback would produce
// anyway — otherwise a plain min-max (or blank) is enough to reproduce it.
function formatLimitRangeDefault(minLimit, maxLimit, defaultLimit) {
	const isDefaultRange = minLimit === 0 && maxLimit === 99;
	const isAutoBase = defaultLimit === undefined || defaultLimit === null || defaultLimit === resolveDefaultLimit(minLimit, maxLimit);

	if (isDefaultRange && isAutoBase) return '';
	if (isAutoBase) return `${minLimit}-${maxLimit}`;
	return `${minLimit}-${defaultLimit}-${maxLimit}`;
}

// mode: 'create' (a brand-new hub channel gets made) or 'edit' (an existing
// hub's channel + row get updated in place, hubChannelId identifies which).
// current pre-fills the modal for /voice edit; omitted entirely for create.
function buildHubModal({ mode, hubChannelId = null, current = {} }) {
	const customId = mode === 'edit' ? `hub-modal:edit:${hubChannelId}` : 'hub-modal:create';
	const modal = new ModalBuilder().setCustomId(customId).setTitle(mode === 'edit' ? 'Edit voice hub' : 'Create a voice hub');

	const hubNameInput = new TextInputBuilder()
		.setCustomId('hubName')
		.setLabel('Hub channel name')
		.setStyle(TextInputStyle.Short)
		.setMaxLength(100)
		.setRequired(false)
		.setPlaceholder('➕ Join to Create');
	if (current.hubName) hubNameInput.setValue(current.hubName);

	const nameTemplateInput = new TextInputBuilder()
		.setCustomId('nameTemplate')
		.setLabel('Temp channel name (use {owner})')
		.setStyle(TextInputStyle.Short)
		.setMaxLength(100)
		.setRequired(false)
		.setPlaceholder("🔊 {owner}'s channel");
	if (current.nameTemplate) nameTemplateInput.setValue(current.nameTemplate);

	const categoryInput = new TextInputBuilder()
		.setCustomId('categoryName')
		.setLabel("Category (created if it doesn't exist)")
		.setStyle(TextInputStyle.Short)
		.setMaxLength(100)
		.setRequired(false)
		.setPlaceholder('Leave blank for no category');
	if (current.categoryName) categoryInput.setValue(current.categoryName);

	const overflowInput = new TextInputBuilder()
		.setCustomId('overflowCategoryName')
		.setLabel('Overflow category (used at 50 channels)')
		.setStyle(TextInputStyle.Short)
		.setMaxLength(100)
		.setRequired(false)
		.setPlaceholder('Optional');
	if (current.overflowCategoryName) overflowInput.setValue(current.overflowCategoryName);

	const limitRangeInput = new TextInputBuilder()
		.setCustomId('limitRange')
		.setLabel('Limit: max, min-max, or min-base-max')
		.setStyle(TextInputStyle.Short)
		.setMaxLength(8)
		.setRequired(false)
		.setPlaceholder('e.g. 10, 2-10, or 2-5-10 — blank = unlimited');
	if (current.minLimit !== undefined) {
		const defaultRange = formatLimitRangeDefault(current.minLimit, current.maxLimit, current.defaultLimit);
		if (defaultRange) limitRangeInput.setValue(defaultRange);
	}

	return modal.addComponents(
		new ActionRowBuilder().addComponents(hubNameInput),
		new ActionRowBuilder().addComponents(nameTemplateInput),
		new ActionRowBuilder().addComponents(categoryInput),
		new ActionRowBuilder().addComponents(overflowInput),
		new ActionRowBuilder().addComponents(limitRangeInput),
	);
}

// Creates a brand-new hub channel and registers it. Throws on a real Discord
// API failure; the caller is responsible for reporting that the same way any
// other command error is reported.
async function createHub(interaction, fields, category, overflowCategory) {
	const hub = await interaction.guild.channels.create({
		name: fields.hubName,
		type: ChannelType.GuildVoice,
		parent: category?.id ?? undefined,
	});

	try {
		voiceStore.addHub(interaction.guildId, hub.id, {
			categoryId: category?.id ?? null,
			overflowCategoryId: overflowCategory?.id ?? null,
			nameTemplate: fields.nameTemplate,
			defaultLimit: fields.defaultLimit,
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

// Updates an existing hub in place: the DB row, and the live channel's name
// and category if they changed. Returns the (possibly renamed/moved) channel.
// default_limit is a stored setting for FUTURE temp channels, not something
// the hub's own trigger channel needs to reflect, so nothing about the live
// hub channel changes for it.
async function updateHub(interaction, hubChannelId, fields, category, overflowCategory) {
	const channel = interaction.guild.channels.cache.get(hubChannelId);
	if (!channel) {
		throw new Error("This hub's channel no longer exists on Discord — use /voice audit to prune or restore it first.");
	}

	if (channel.name !== fields.hubName) await channel.setName(fields.hubName, 'Edited via /voice edit');
	if (channel.parentId !== (category?.id ?? null)) await channel.setParent(category?.id ?? null, { reason: 'Edited via /voice edit' });

	voiceStore.updateHub(hubChannelId, {
		categoryId: category?.id ?? null,
		overflowCategoryId: overflowCategory?.id ?? null,
		nameTemplate: fields.nameTemplate,
		defaultLimit: fields.defaultLimit,
		minLimit: fields.minLimit,
		maxLimit: fields.maxLimit,
	});

	return channel;
}

// Handles the one and only interaction this whole feature has after the
// initial slash command: the modal submission. Returns false for anything
// else so interactionCreate.js can try other features' handlers in sequence.
async function handleWizardInteraction(interaction) {
	if (!interaction.isModalSubmit()) return false;
	const customId = interaction.customId;
	if (!customId || !customId.startsWith('hub-modal:')) return false;

	const [, mode, hubChannelId] = customId.split(':');

	const hubName = interaction.fields.getTextInputValue('hubName').trim() || '➕ Join to Create';
	const nameTemplate = interaction.fields.getTextInputValue('nameTemplate').trim() || "🔊 {owner}'s channel";
	const categoryName = interaction.fields.getTextInputValue('categoryName').trim() || null;
	const overflowCategoryName = interaction.fields.getTextInputValue('overflowCategoryName').trim() || null;

	const range = parseLimitRange(interaction.fields.getTextInputValue('limitRange'));
	if (range.error) {
		await interaction.reply({ content: range.error, ephemeral: true });
		return true;
	}

	const category = await resolveOrCreateCategory(interaction.guild, categoryName);
	const overflowCategory = await resolveOrCreateCategory(interaction.guild, overflowCategoryName);
	const fields = {
		hubName,
		nameTemplate,
		minLimit: range.minLimit,
		maxLimit: range.maxLimit,
		defaultLimit: range.defaultLimit,
	};

	const hub = mode === 'edit'
		? await updateHub(interaction, hubChannelId, fields, category, overflowCategory)
		: await createHub(interaction, fields, category, overflowCategory);

	const verb = mode === 'edit' ? 'Updated' : 'Created';
	await interaction.reply({
		content: [
			`${verb} ${hub} as a voice hub.`,
			`Category: ${category ? category.name : '*none*'}`,
			`Overflow category: ${overflowCategory ? overflowCategory.name : '*none*'}`,
			`Temp channel names: ${fields.nameTemplate}`,
			`User limit range: ${fields.minLimit}-${fields.maxLimit}`,
			`Starting user limit: ${fields.defaultLimit}`,
		].join('\n'),
		ephemeral: true,
	});
	return true;
}

module.exports = {
	findCategoryByName,
	resolveOrCreateCategory,
	resolveDefaultLimit,
	parseLimitRange,
	formatLimitRangeDefault,
	buildHubModal,
	createHub,
	updateHub,
	handleWizardInteraction,
};
