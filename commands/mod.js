const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const moderation = require('../lib/moderation');
const { parseDuration } = require('../lib/duration');
const { isAdmin, requireAdmin } = require('../lib/permissions');

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

const HANDLERS = {
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
		.setDescription('Kick, ban and time out members.')
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
		const subcommand = interaction.options.getSubcommand();
		const handler = HANDLERS[subcommand];
		if (!handler) throw new Error(`Unknown /mod subcommand: ${subcommand}`);
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
