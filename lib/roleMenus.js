const {
	EmbedBuilder,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
} = require('discord.js');
const roleMenuStore = require('../state/roleMenus');

const EMBED_COLOR = 0x5865f2;
const CUSTOM_EMOJI_RE = /^<a?:(\w{2,32}):(\d{15,21})>$/;

// discord.js's react()/setEmoji() both accept the raw <a:name:id> mention form
// directly, so `raw` doubles as the value fed back to Discord. `matchKey` is what
// identifies "same emoji" — the snowflake for a custom emoji (names aren't stable
// identity, e.g. after a guild emoji rename) or the literal string for unicode.
function parseEmoji(raw) {
	const trimmed = raw.trim();
	const customMatch = trimmed.match(CUSTOM_EMOJI_RE);
	if (customMatch) {
		return { raw: trimmed, matchKey: customMatch[2] };
	}
	return { raw: trimmed, matchKey: trimmed };
}

function reactionMatchKey(reaction) {
	return reaction.emoji.id ?? reaction.emoji.name;
}

// Looks up which role_menu_options row (if any) a live incoming reaction
// corresponds to. Only a handful of options exist per message (Discord caps
// reaction messages at 20), so a linear scan beats parsing emoji at write time
// and keeping a second, easily-desynced index.
function resolveReactionRoleOption(reaction) {
	const menu = roleMenuStore.getMenu(reaction.message.id);
	if (!menu || menu.type !== 'reaction') return null;

	const key = reactionMatchKey(reaction);
	const options = roleMenuStore.getOptions(reaction.message.id);
	return options.find((option) => parseEmoji(option.emoji).matchKey === key) ?? null;
}

function buildReactionMenuEmbed(title, description, options) {
	const embed = new EmbedBuilder().setTitle(title).setColor(EMBED_COLOR);
	if (description) embed.setDescription(description);

	embed.addFields({
		name: 'Roles',
		value: options.length
			? options.map((option) => `${option.emoji} — <@&${option.roleId}>`).join('\n')
			: 'No roles configured yet — an admin can add some with `/roles reaction add-role`.',
	});

	return embed;
}

function buildDropdownAnchorEmbed(title, description, options) {
	const embed = new EmbedBuilder().setTitle(title).setColor(EMBED_COLOR);
	if (description) embed.setDescription(description);

	embed.addFields({
		name: 'Roles',
		value: options.length
			? options.map((option) => `<@&${option.roleId}> — ${option.label}`).join('\n')
			: 'No roles configured yet — an admin can add some with `/roles dropdown add-role`.',
	});

	return embed;
}

// Shared by both menu types' add-role/remove-role handlers: re-reads the
// message's own current title/description straight off its live embed rather
// than storing a second copy in the database, so there's exactly one source of
// truth for that text.
async function refreshMenuEmbed(message, options, buildEmbed) {
	const existing = message.embeds[0];
	const embed = buildEmbed(existing?.title ?? null, existing?.description ?? null, options);
	await message.edit({ embeds: [embed] });
}

function buildOpenButtonRow(messageId) {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId(`roleMenuOpen:${messageId}`)
			.setLabel('Select your roles')
			.setStyle(ButtonStyle.Primary),
	);
}

function buildPersonalSelectRow(messageId, options, memberRoleIds) {
	const menu = new StringSelectMenuBuilder()
		.setCustomId(`roleMenuSelect:${messageId}`)
		.setMinValues(0)
		.setMaxValues(options.length)
		.addOptions(options.map((option) => {
			const built = new StringSelectMenuOptionBuilder()
				.setLabel(option.label)
				.setValue(option.roleId)
				.setDefault(memberRoleIds.has(option.roleId));
			if (option.emoji) built.setEmoji(option.emoji);
			return built;
		}));

	return new ActionRowBuilder().addComponents(menu);
}

// Reconciles a member's roles to exactly match `selectedRoleIds` within the set
// of roles this menu manages — never touches roles outside managedRoleIds. Per-role
// try/catch so one role above the bot's own (or a permission hiccup) doesn't abort
// the rest of the diff.
async function applyRoleDiff(member, selectedRoleIds, managedRoleIds) {
	const result = { added: [], removed: [], failed: [] };

	for (const roleId of managedRoleIds) {
		const shouldHave = selectedRoleIds.has(roleId);
		const has = member.roles.cache.has(roleId);
		if (shouldHave === has) continue;

		try {
			if (shouldHave) {
				await member.roles.add(roleId, 'Role menu selection via PariahBot');
				result.added.push(roleId);
			} else {
				await member.roles.remove(roleId, 'Role menu selection via PariahBot');
				result.removed.push(roleId);
			}
		} catch (error) {
			result.failed.push({ roleId, error });
		}
	}

	return result;
}

// Handles the "Select your roles" button — replies with a personal, ephemeral
// select menu pre-checked to the roles the clicking member already holds.
// Returns false for any customId that isn't ours, matching lib/hubDesync.js's
// convention so interactionCreate.js can fall through to other button handlers.
async function handleRoleMenuButtonInteraction(interaction) {
	const [action, messageId] = interaction.customId.split(':');
	if (action !== 'roleMenuOpen') return false;

	const menu = roleMenuStore.getMenu(messageId);
	if (!menu) {
		await interaction.reply({ content: 'This role menu no longer exists.', ephemeral: true });
		return true;
	}

	const options = roleMenuStore.getOptions(messageId);
	if (options.length === 0) {
		await interaction.reply({ content: "This menu doesn't have any roles configured yet.", ephemeral: true });
		return true;
	}

	const memberRoleIds = new Set(interaction.member.roles.cache.keys());
	const row = buildPersonalSelectRow(messageId, options, memberRoleIds);

	await interaction.reply({ content: 'Pick the roles you want — unchecking one removes it.', components: [row], ephemeral: true });
	return true;
}

// Handles a submission from that select menu: diffs the chosen values against
// the member's current roles and re-renders the same ephemeral menu so it stays
// in sync with what just changed.
async function handleRoleMenuSelectInteraction(interaction) {
	const [action, messageId] = interaction.customId.split(':');
	if (action !== 'roleMenuSelect') return false;

	const options = roleMenuStore.getOptions(messageId);
	const managedRoleIds = options.map((option) => option.roleId);
	const selectedRoleIds = new Set(interaction.values);

	const result = await applyRoleDiff(interaction.member, selectedRoleIds, managedRoleIds);

	const parts = [];
	if (result.added.length) parts.push(`Added: ${result.added.map((id) => `<@&${id}>`).join(', ')}`);
	if (result.removed.length) parts.push(`Removed: ${result.removed.map((id) => `<@&${id}>`).join(', ')}`);
	if (result.failed.length) parts.push(`Couldn't change: ${result.failed.map((f) => `<@&${f.roleId}>`).join(', ')} (check my role position)`);
	if (!parts.length) parts.push('No changes.');

	const memberRoleIds = new Set(interaction.member.roles.cache.keys());
	const row = buildPersonalSelectRow(messageId, options, memberRoleIds);

	await interaction.update({ content: parts.join('\n'), components: [row] });
	return true;
}

module.exports = {
	parseEmoji,
	resolveReactionRoleOption,
	buildReactionMenuEmbed,
	buildDropdownAnchorEmbed,
	refreshMenuEmbed,
	buildOpenButtonRow,
	buildPersonalSelectRow,
	applyRoleDiff,
	handleRoleMenuButtonInteraction,
	handleRoleMenuSelectInteraction,
};
