const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const moderation = require('../lib/moderation');
const caseStore = require('../state/modCases');
const guildSettings = require('../state/guildSettings');
const { parseDuration, formatDuration } = require('../lib/duration');
const { isAdmin, requireAdmin } = require('../lib/permissions');

const EMBED_COLOR = 0x5865f2;

// How many cases /mod history shows; the counts above them cover the rest.
const HISTORY_LIMIT = 15;
const MAX_HISTORY_REASON_LENGTH = 150;
// Embed descriptions are capped at 4096 characters.
const MAX_DESCRIPTION_LENGTH = 4096;

const MAX_APPEAL_NOTE_LENGTH = 300;

const MAX_AUTOCOMPLETE_CHOICES = 25;
// Discord caps autocomplete choice names and values at 100 characters.
const MAX_CHOICE_LENGTH = 100;
// How much of the ban list the unban suggestions search through.
const MAX_BANS_FETCHED = 1000;

const SOFTBAN_DEFAULT_DELETE_SECONDS = 24 * 60 * 60;

function getReason(interaction) {
	return interaction.options.getString('reason')?.trim() || null;
}

// Every action is a handful of API calls plus a DM, which can outlast
// Discord's 3-second reply window — so each handler defers first.
async function run(interaction, action) {
	requireAdmin(interaction);
	await interaction.deferReply({ ephemeral: true });
	const summary = await action();
	await interaction.editReply({ content: summary });
}

async function handleKick(interaction) {
	await run(interaction, () => moderation.kick(interaction.guild, interaction.member, interaction.options.getUser('member'), getReason(interaction)));
}

async function handleBan(interaction) {
	const rawDuration = interaction.options.getString('duration');
	await run(interaction, () => moderation.ban(interaction.guild, interaction.member, interaction.options.getUser('user'), getReason(interaction), {
		deleteSeconds: interaction.options.getInteger('delete_messages') ?? 0,
		durationSeconds: rawDuration ? parseDuration(rawDuration) : null,
	}));
}

async function handleSoftban(interaction) {
	await run(interaction, () => moderation.softban(
		interaction.guild,
		interaction.member,
		interaction.options.getUser('user'),
		getReason(interaction),
		interaction.options.getInteger('delete_messages') ?? SOFTBAN_DEFAULT_DELETE_SECONDS,
	));
}

// The string option holds a user ID (what autocomplete submits). A pasted
// mention or ID works too.
async function handleUnban(interaction) {
	const userId = interaction.options.getString('user').match(/\d{17,20}/)?.[0];
	if (!userId) throw new Error('Pick someone from the suggestions, or paste their user ID.');
	await run(interaction, () => moderation.unban(interaction.guild, interaction.member, userId, getReason(interaction)));
}

async function handleTimeout(interaction) {
	await run(interaction, () => moderation.timeout(
		interaction.guild,
		interaction.member,
		interaction.options.getUser('member'),
		getReason(interaction),
		parseDuration(interaction.options.getString('duration')),
	));
}

async function handleUntimeout(interaction) {
	await run(interaction, () => moderation.untimeout(interaction.guild, interaction.member, interaction.options.getUser('member'), getReason(interaction)));
}

async function handleWarn(interaction) {
	await run(interaction, () => moderation.warn(interaction.guild, interaction.member, interaction.options.getUser('member'), interaction.options.getString('reason').trim()));
}

function describeCase(entry) {
	const parts = [
		`**#${entry.id}** ${moderation.CASE_LABELS[entry.action] ?? entry.action}`,
		`<t:${Math.floor(Date.parse(entry.createdAt) / 1000)}:d>`,
		entry.moderatorId ? `by <@${entry.moderatorId}>` : 'by PariahBot',
	];
	if (entry.durationSeconds) parts.push(formatDuration(entry.durationSeconds));
	const reason = entry.reason ? `\n> ${entry.reason.length > MAX_HISTORY_REASON_LENGTH ? `${entry.reason.slice(0, MAX_HISTORY_REASON_LENGTH - 1)}…` : entry.reason}` : '';
	return `${parts.join(' · ')}${reason}`;
}

// Read-only, and only ever this server's cases. The user option works for
// someone who has left or been banned, since their record outlives them.
async function handleHistory(interaction) {
	requireAdmin(interaction);
	const user = interaction.options.getUser('user');
	const counts = caseStore.countCasesByAction(interaction.guildId, user.id);
	const cases = caseStore.listCasesForUser(interaction.guildId, user.id, HISTORY_LIMIT);
	const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

	const embed = new EmbedBuilder()
		.setTitle(`Moderation history: ${user.tag ?? user.username}`)
		.setColor(EMBED_COLOR)
		.setThumbnail(user.displayAvatarURL?.() ?? null);

	if (total === 0) {
		embed.setDescription(`No moderation actions against ${user} in this server.`);
	} else {
		const summary = Object.entries(moderation.CASE_LABELS)
			.filter(([action]) => counts[action])
			.map(([action, label]) => `${label}: **${counts[action]}**`)
			.join(' · ');
		let description = `${summary}\n\n`;
		for (const entry of cases) {
			const line = `${describeCase(entry)}\n`;
			if (description.length + line.length > MAX_DESCRIPTION_LENGTH - 40) break;
			description += line;
		}
		if (total > cases.length) description += `\n…and ${total - cases.length} older.`;
		embed.setDescription(description);

		const { warnEscalation } = guildSettings.getGuildSettings(interaction.guildId);
		if (warnEscalation && counts.warn) {
			const since = new Date(Date.now() - (warnEscalation.windowSeconds * 1000)).toISOString();
			const recent = caseStore.countWarningsSince(interaction.guildId, user.id, since);
			const window = formatDuration(warnEscalation.windowSeconds);
			embed.setFooter({
				text: recent >= warnEscalation.count
					? `${recent} warnings in the last ${window} — at the automatic-timeout limit of ${warnEscalation.count}, so each further warning times them out`
					: `${recent} of ${warnEscalation.count} warnings in the last ${window} before an automatic timeout`,
			});
		}
	}
	await interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
}

// Deletes the record only — a kick or ban it describes stays done. Reported,
// so removing a case is itself on the record.
async function handleRemoveCase(interaction) {
	requireAdmin(interaction);
	const summary = await moderation.removeCaseRecord(interaction.guild, interaction.options.getInteger('case'), `${interaction.member}`);
	await interaction.reply({ content: summary, ephemeral: true, allowedMentions: { parse: [] } });
}

async function handleConfigEscalation(interaction) {
	requireAdmin(interaction);
	const { count, windowSeconds, timeoutSeconds } = moderation.parseEscalation({
		count: interaction.options.getInteger('warnings'),
		within: interaction.options.getString('within'),
		timeout: interaction.options.getString('timeout'),
	});

	guildSettings.setWarnEscalation(interaction.guildId, { count, windowSeconds, timeoutSeconds });
	const notes = [`From now on, a member's **${count}${count === 2 ? 'nd' : count === 3 ? 'rd' : 'th'}** warning within ${formatDuration(windowSeconds)} — and each one after it in that window — times them out for **${formatDuration(timeoutSeconds)}**.`];
	if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.ModerateMembers)) {
		notes.push('⚠️ I need **Timeout Members** for that to work. Add it to my PariahBot role in Server Settings → Roles.');
	}
	await interaction.reply({ content: notes.join('\n'), ephemeral: true });
}

async function handleConfigEscalationOff(interaction) {
	requireAdmin(interaction);
	guildSettings.setWarnEscalation(interaction.guildId, null);
	await interaction.reply({ content: 'Automatic timeouts are off. Warnings are still recorded.', ephemeral: true });
}

async function handleConfigAppealNote(interaction) {
	requireAdmin(interaction);
	const text = interaction.options.getString('text').trim();
	guildSettings.setBanAppealNote(interaction.guildId, text);
	await interaction.reply({ content: `Ban DMs will now end with:\n> ${text}`, ephemeral: true, allowedMentions: { parse: [] } });
}

async function handleConfigAppealNoteClear(interaction) {
	requireAdmin(interaction);
	guildSettings.setBanAppealNote(interaction.guildId, null);
	await interaction.reply({ content: 'Ban DMs no longer include an appeal note.', ephemeral: true });
}

async function handleConfigShow(interaction) {
	requireAdmin(interaction);
	const { warnEscalation, banAppealNote } = guildSettings.getGuildSettings(interaction.guildId);
	const embed = new EmbedBuilder()
		.setTitle('Moderation settings')
		.setColor(EMBED_COLOR)
		.addFields(
			{
				name: 'Automatic timeout',
				value: warnEscalation
					? `${warnEscalation.count} warnings within ${formatDuration(warnEscalation.windowSeconds)} → timed out for ${formatDuration(warnEscalation.timeoutSeconds)}`
					: 'Off — `/mod config escalation` turns it on',
			},
			{ name: 'Appeal note in ban DMs', value: banAppealNote ?? 'None — `/mod config appeal-note` sets one' },
		);
	await interaction.reply({ embeds: [embed], ephemeral: true });
}

const HANDLERS = {
	warn: handleWarn,
	history: handleHistory,
	'remove-case': handleRemoveCase,
	'config escalation': handleConfigEscalation,
	'config escalation-off': handleConfigEscalationOff,
	'config appeal-note': handleConfigAppealNote,
	'config appeal-note-clear': handleConfigAppealNoteClear,
	'config show': handleConfigShow,
	kick: handleKick,
	ban: handleBan,
	softban: handleSoftban,
	unban: handleUnban,
	timeout: handleTimeout,
	untimeout: handleUntimeout,
};

function reasonOption(option) {
	return option
		.setName('reason')
		.setDescription('Shown to them in the DM, and in the audit log and alert')
		.setMaxLength(moderation.MAX_REASON_LENGTH)
		.setRequired(false);
}

function deleteMessagesOption(option, description) {
	return option
		.setName('delete_messages')
		.setDescription(description)
		.addChoices(...moderation.DELETE_MESSAGE_CHOICES)
		.setRequired(false);
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName('mod')
		.setDescription('Warn, kick, ban and time out members, and see their history.')
		.addSubcommand((sub) => sub
			.setName('warn')
			.setDescription('(Admin) Warn a member: DMs them and records it in their history.')
			.addUserOption((option) => option.setName('member').setDescription('Member to warn').setRequired(true))
			.addStringOption((option) => option
				.setName('reason')
				.setDescription('Why — shown to them, and in their history')
				.setMaxLength(moderation.MAX_REASON_LENGTH)
				.setRequired(true)))
		.addSubcommand((sub) => sub
			.setName('history')
			.setDescription('(Admin) Every warning, kick, ban and timeout against someone, with who and why.')
			.addUserOption((option) => option.setName('user').setDescription("Whose history (they needn't still be in the server)").setRequired(true)))
		.addSubcommand((sub) => sub
			.setName('remove-case')
			.setDescription('(Admin) Delete a record from history, e.g. a mistaken warning. Undoes nothing.')
			.addIntegerOption((option) => option
				.setName('case')
				.setDescription('Case number, from /mod history')
				.setMinValue(1)
				.setRequired(true)))
		.addSubcommandGroup((group) => group
			.setName('config')
			.setDescription('Automatic timeouts for repeated warnings, and the ban appeal note')
			.addSubcommand((sub) => sub
				.setName('escalation')
				.setDescription('(Admin) Time members out automatically after enough warnings.')
				.addIntegerOption((option) => option
					.setName('warnings')
					.setDescription('How many warnings trigger it')
					.setMinValue(moderation.MIN_ESCALATION_WARNINGS)
					.setMaxValue(moderation.MAX_ESCALATION_WARNINGS)
					.setRequired(true))
				.addStringOption((option) => option
					.setName('within')
					.setDescription('Counted over this long, e.g. 7d or 30d')
					.setMaxLength(20)
					.setRequired(true))
				.addStringOption((option) => option
					.setName('timeout')
					.setDescription('How long the timeout lasts, e.g. 1h or 1d (max 28d)')
					.setMaxLength(20)
					.setRequired(true)))
			.addSubcommand((sub) => sub
				.setName('escalation-off')
				.setDescription('(Admin) Stop automatic timeouts. Warnings are still recorded.'))
			.addSubcommand((sub) => sub
				.setName('appeal-note')
				.setDescription('(Admin) A line added to every ban DM, e.g. how to appeal.')
				.addStringOption((option) => option
					.setName('text')
					.setDescription('e.g. Appeal at https://example.com/appeal')
					.setMaxLength(MAX_APPEAL_NOTE_LENGTH)
					.setRequired(true)))
			.addSubcommand((sub) => sub
				.setName('appeal-note-clear')
				.setDescription('(Admin) Stop adding an appeal note to ban DMs.'))
			.addSubcommand((sub) => sub
				.setName('show')
				.setDescription('(Admin) Show the automatic timeout and appeal note settings.')))
		.addSubcommand((sub) => sub
			.setName('kick')
			.setDescription('(Admin) DM a member, then kick them. They can rejoin.')
			.addUserOption((option) => option.setName('member').setDescription('Member to kick').setRequired(true))
			.addStringOption(reasonOption))
		.addSubcommand((sub) => sub
			.setName('ban')
			.setDescription('(Admin) DM someone, then ban them — for good, or for a set time.')
			.addUserOption((option) => option.setName('user').setDescription("Who to ban (they needn't be in the server — paste an ID)").setRequired(true))
			.addStringOption(reasonOption)
			.addIntegerOption((option) => deleteMessagesOption(option, 'Also delete their recent messages (default: none)'))
			.addStringOption((option) => option
				.setName('duration')
				.setDescription('Make it temporary, e.g. 1d, 7d, 30d (max 365d). Leave empty for permanent')
				.setMaxLength(20)
				.setRequired(false)))
		.addSubcommand((sub) => sub
			.setName('softban')
			.setDescription('(Admin) Ban then unban at once: deletes their recent messages, and they can rejoin.')
			.addUserOption((option) => option.setName('user').setDescription('Who to softban').setRequired(true))
			.addStringOption(reasonOption)
			.addIntegerOption((option) => deleteMessagesOption(option, 'How far back to delete their messages (default: 24 hours)')))
		.addSubcommand((sub) => sub
			.setName('unban')
			.setDescription('(Admin) Lift a ban, including a temporary one.')
			.addStringOption((option) => option
				.setName('user')
				.setDescription('Banned user (pick from the suggestions, or paste their ID)')
				.setAutocomplete(true)
				.setMaxLength(MAX_CHOICE_LENGTH)
				.setRequired(true))
			.addStringOption(reasonOption))
		.addSubcommand((sub) => sub
			.setName('timeout')
			.setDescription('(Admin) Stop a member talking or joining voice for a while (max 28 days).')
			.addUserOption((option) => option.setName('member').setDescription('Member to time out').setRequired(true))
			.addStringOption((option) => option
				.setName('duration')
				.setDescription('e.g. 10m, 1h, 1d, 7d (max 28d)')
				.setMaxLength(20)
				.setRequired(true))
			.addStringOption(reasonOption))
		.addSubcommand((sub) => sub
			.setName('untimeout')
			.setDescription("(Admin) End a member's timeout early.")
			.addUserOption((option) => option.setName('member').setDescription('Member whose timeout to end').setRequired(true))
			.addStringOption(reasonOption)),
	async execute(interaction) {
		const group = interaction.options.getSubcommandGroup(false);
		const subcommand = interaction.options.getSubcommand();
		const name = group ? `${group} ${subcommand}` : subcommand;
		const handler = HANDLERS[name];
		if (!handler) throw new Error(`Unknown /mod subcommand: ${name}`);
		await handler(interaction);
	},
	// Suggestions for /mod unban — this guild's own ban list, for admins only.
	// A typed ID needn't come from here, which is why unban looks it up in
	// this guild's bans rather than trusting it.
	async autocomplete(interaction) {
		if (!isAdmin(interaction.member, interaction.guildId)
			|| !interaction.guild.members.me.permissions.has(PermissionFlagsBits.BanMembers)) {
			await interaction.respond([]);
			return;
		}
		const typed = interaction.options.getFocused().toLowerCase();
		const bans = await interaction.guild.bans.fetch({ limit: MAX_BANS_FETCHED });
		const choices = [...bans.values()]
			.filter(({ user }) => user.username.toLowerCase().includes(typed) || user.id.includes(typed))
			.slice(0, MAX_AUTOCOMPLETE_CHOICES)
			.map(({ user, reason }) => ({
				name: `${user.username}${reason ? ` — ${reason}` : ''}`.slice(0, MAX_CHOICE_LENGTH),
				value: user.id,
			}));
		await interaction.respond(choices);
	},
};
