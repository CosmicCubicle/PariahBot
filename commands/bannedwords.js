const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const bannedWordStore = require('../state/bannedWords');
const guildSettings = require('../state/guildSettings');
const { LISTS } = require('../lib/bannedWordLists');
const { MAX_CUSTOM_WORDS, addCustomWords, normalizeWord, requireManageGuild, syncGuild } = require('../lib/bannedWords');
const { isAdmin, requireAdmin } = require('../lib/permissions');

const EMBED_COLOR = 0x5865f2;
const MAX_AUTOCOMPLETE_CHOICES = 25;
// Discord caps autocomplete choice names and values at 100 characters.
const MAX_CHOICE_LENGTH = 100;
// Embed field values are capped at 1024 characters.
const MAX_FIELD_LENGTH = 1024;

const LIST_CHOICES = Object.entries(LISTS).map(([value, { label, description }]) => ({
	name: `${label}: ${description}`.slice(0, MAX_CHOICE_LENGTH),
	value,
}));

function hasAnything(guildId) {
	return bannedWordStore.listLists(guildId).length > 0 || bannedWordStore.countWords(guildId) > 0;
}

// Where blocks get reported: the same destination as every other admin
// alert (see lib/alertDelivery.js). Warns when that's nowhere at all.
function reportingNote(guildId) {
	const { alertChannelId, defaultChannelId } = guildSettings.getGuildSettings(guildId);
	const channelId = alertChannelId ?? defaultChannelId;
	const recipients = guildSettings.listAlertRecipients(guildId);
	if (!channelId && recipients.length === 0) {
		return "⚠️ Blocked messages won't be reported anywhere: this server has no admin alert channel or DM recipients. Set one with `/alerts channel`.";
	}
	return `Blocked messages are reported with the other admin alerts${channelId ? ` in <#${channelId}>` : ''}${recipients.length ? ` and by DM to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}` : ''}.`;
}

// After any change to the lists or words: only touches Discord when the
// feature is on. Defers first, since syncing is a few API round trips.
async function applyChange(interaction, summary) {
	const { bannedWordsEnabled } = guildSettings.getGuildSettings(interaction.guildId);
	if (!bannedWordsEnabled) {
		await interaction.reply({ content: `${summary}\nBanned words are off, so nothing is blocked yet — \`/bannedwords enable\` turns them on.`, ephemeral: true });
		return;
	}

	await interaction.deferReply({ ephemeral: true });
	await syncGuild(interaction.guild);
	const lines = [summary];
	if (!hasAnything(interaction.guildId)) {
		lines.push('⚠️ No lists or words are left, so nothing is being blocked. Add some, or `/bannedwords disable`.');
	}
	await interaction.editReply({ content: lines.join('\n') });
}

async function handleEnable(interaction) {
	requireAdmin(interaction);
	requireManageGuild(interaction.guild);
	if (!hasAnything(interaction.guildId)) {
		throw new Error('Pick at least one list with `/bannedwords list add`, or add words with `/bannedwords word add`, first.');
	}

	await interaction.deferReply({ ephemeral: true });
	guildSettings.enableBannedWords(interaction.guildId);
	try {
		await syncGuild(interaction.guild);
	} catch (error) {
		// Left off if the rules couldn't be made, so the setting never claims
		// to be blocking words that Discord isn't.
		guildSettings.disableBannedWords(interaction.guildId);
		throw error;
	}

	await interaction.editReply({
		content: [
			'Banned words are on. Discord now blocks matching messages before anyone sees them, and tells the sender why.',
			reportingNote(interaction.guildId),
			'Members with Administrator or Manage Server are never blocked. To exempt a channel or role too, edit the **PariahBot: banned words** rules in Server Settings → AutoMod — the bot keeps those settings.',
		].join('\n'),
	});
}

async function handleDisable(interaction) {
	requireAdmin(interaction);
	guildSettings.disableBannedWords(interaction.guildId);

	await interaction.deferReply({ ephemeral: true });
	try {
		await syncGuild(interaction.guild);
	} catch (error) {
		throw new Error(`Banned words are off in my settings, but I couldn't switch off the AutoMod rules: ${error.message} Until then, switch off the **PariahBot: banned words** rules by hand in Server Settings → AutoMod.`);
	}
	await interaction.editReply({ content: 'Banned words are off. The lists and words are kept — `/bannedwords enable` turns them back on.' });
}

async function handleListAdd(interaction) {
	requireAdmin(interaction);
	const key = interaction.options.getString('list');
	const added = bannedWordStore.addList(interaction.guildId, key);
	await applyChange(interaction, added ? `Added the **${LISTS[key].label}** list.` : `The **${LISTS[key].label}** list was already on.`);
}

async function handleListRemove(interaction) {
	requireAdmin(interaction);
	const key = interaction.options.getString('list');
	const removed = bannedWordStore.removeList(interaction.guildId, key);
	await applyChange(interaction, removed ? `Removed the **${LISTS[key].label}** list.` : `The **${LISTS[key].label}** list wasn't on.`);
}

async function handleWordAdd(interaction) {
	requireAdmin(interaction);

	await applyChange(interaction, addCustomWords(interaction.guildId, interaction.options.getString('words')));
}

async function handleWordRemove(interaction) {
	requireAdmin(interaction);
	const word = normalizeWord(interaction.options.getString('word')) ?? '';
	const removed = bannedWordStore.removeWord(interaction.guildId, word);
	if (!removed) {
		throw new Error(`"${word}" isn't one of this server's custom words — pick one from the suggestions.`);
	}
	await applyChange(interaction, `Removed ||${word}|| from the custom words.`);
}

function fitField(lines, empty) {
	if (lines.length === 0) return empty;
	let value = '';
	for (const [index, line] of lines.entries()) {
		const more = `\n…and ${lines.length - index} more`;
		if (value.length + line.length + 1 + more.length > MAX_FIELD_LENGTH) return `${value}${more}`;
		value += `${value ? '\n' : ''}${line}`;
	}
	return value;
}

async function handleStatus(interaction) {
	requireAdmin(interaction);

	const { bannedWordsEnabled } = guildSettings.getGuildSettings(interaction.guildId);
	const lists = bannedWordStore.listLists(interaction.guildId).filter((key) => LISTS[key]);
	const words = bannedWordStore.listWords(interaction.guildId);

	const embed = new EmbedBuilder()
		.setTitle('Banned words')
		.setColor(EMBED_COLOR)
		.addFields(
			{ name: 'Status', value: bannedWordsEnabled ? 'On — Discord AutoMod is blocking matches' : 'Off', inline: true },
			{ name: 'Custom words', value: `${words.length} of ${MAX_CUSTOM_WORDS}`, inline: true },
			{ name: 'Lists', value: fitField(lists.map((key) => `**${LISTS[key].label}**: ${LISTS[key].description}`), 'None') },
			// Spoilered, so opening the status doesn't put the words on screen.
			{ name: 'Custom word list', value: fitField(words.map((word) => `||${word}||`), 'None') },
			{ name: 'Reports', value: reportingNote(interaction.guildId) },
		);
	if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.ManageGuild)) {
		embed.addFields({ name: '⚠️ Permission missing', value: 'I need **Manage Server** to manage the AutoMod rules. Add it to my PariahBot role in Server Settings → Roles.' });
	}

	await interaction.reply({ embeds: [embed], ephemeral: true });
}

const HANDLERS = {
	enable: handleEnable,
	disable: handleDisable,
	'list add': handleListAdd,
	'list remove': handleListRemove,
	'word add': handleWordAdd,
	'word remove': handleWordRemove,
	status: handleStatus,
};

function listOption(option, description) {
	return option
		.setName('list')
		.setDescription(description)
		.addChoices(...LIST_CHOICES)
		.setRequired(true);
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName('bannedwords')
		.setDescription('Block messages containing banned words, using Discord AutoMod.')
		.addSubcommand((sub) => sub
			.setName('enable')
			.setDescription('(Admin) Start blocking messages that match the chosen lists and words.'))
		.addSubcommand((sub) => sub
			.setName('disable')
			.setDescription('(Admin) Stop blocking. The lists and words are kept.'))
		.addSubcommandGroup((group) => group
			.setName('list')
			.setDescription('Ready-made word lists')
			.addSubcommand((sub) => sub
				.setName('add')
				.setDescription('(Admin) Turn on a ready-made list.')
				.addStringOption((option) => listOption(option, 'The list to turn on')))
			.addSubcommand((sub) => sub
				.setName('remove')
				.setDescription('(Admin) Turn off a ready-made list.')
				.addStringOption((option) => listOption(option, 'The list to turn off'))))
		.addSubcommandGroup((group) => group
			.setName('word')
			.setDescription("This server's own banned words")
			.addSubcommand((sub) => sub
				.setName('add')
				.setDescription('(Admin) Ban words or phrases. Separate several with commas; * is a wildcard.')
				.addStringOption((option) => option
					.setName('words')
					.setDescription('e.g. badword, bad phrase, *scamsite*')
					.setMaxLength(1000)
					.setRequired(true)))
			.addSubcommand((sub) => sub
				.setName('remove')
				.setDescription('(Admin) Unban one of your custom words.')
				.addStringOption((option) => option
					.setName('word')
					.setDescription('The word to remove (pick from the suggestions)')
					.setAutocomplete(true)
					.setRequired(true))))
		.addSubcommand((sub) => sub
			.setName('status')
			.setDescription('(Admin) Show whether it is on, the lists, the custom words and where blocks are reported.')),
	async execute(interaction) {
		const group = interaction.options.getSubcommandGroup(false);
		const subcommand = interaction.options.getSubcommand();
		const name = group ? `${group} ${subcommand}` : subcommand;
		const handler = HANDLERS[name];
		if (!handler) throw new Error(`Unknown /bannedwords subcommand: ${name}`);
		await handler(interaction);
	},
	// Suggestions for /bannedwords word remove — this guild's words only, and
	// only for admins, since the list itself is moderation detail.
	async autocomplete(interaction) {
		if (!isAdmin(interaction.member, interaction.guildId)) {
			await interaction.respond([]);
			return;
		}
		const typed = interaction.options.getFocused().toLowerCase();
		const choices = bannedWordStore.listWords(interaction.guildId)
			.filter((word) => word.includes(typed))
			.slice(0, MAX_AUTOCOMPLETE_CHOICES)
			.map((word) => ({ name: word.slice(0, MAX_CHOICE_LENGTH), value: word.slice(0, MAX_CHOICE_LENGTH) }));
		await interaction.respond(choices);
	},
};
