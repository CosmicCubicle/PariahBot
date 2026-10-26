const { SlashCommandBuilder, ChannelType, EmbedBuilder } = require('discord.js');
const ticketStore = require('../state/tickets');
const tickets = require('../lib/tickets');
const { requireAdmin, requireMod, staffRoleIds } = require('../lib/permissions');

const LIST_LIMIT = 25;

// The ticket a command acts on: the one named by number:, or else the ticket
// thread it was run in. number: is typed, so it's looked up scoped to this
// guild (state/tickets.js).
function resolveTicket(interaction) {
	const number = interaction.options.getInteger('number');
	if (number !== null) {
		const ticket = ticketStore.getByNumber(number, interaction.guildId);
		if (!ticket?.threadId) throw new Error(`There's no ticket ${tickets.formatNumber(number)} in this server. \`/ticket list\` shows them.`);
		return ticket;
	}
	const ticket = ticketStore.getByThread(interaction.channelId, interaction.guildId);
	if (!ticket) throw new Error('Run this inside a ticket thread, or pass `number:` to name one.');
	return ticket;
}

async function handleSetup(interaction) {
	requireAdmin(interaction);

	const channel = interaction.options.getChannel('channel');
	const logChannel = interaction.options.getChannel('log-channel');
	tickets.requireBotPermissions(channel, tickets.PANEL_PERMISSIONS);
	if (logChannel) tickets.requireBotPermissions(logChannel, tickets.LOG_PERMISSIONS);

	await interaction.deferReply({ ephemeral: true });

	// Re-running setup refreshes the existing panel rather than posting a
	// second one. A panel left behind in a different channel is removed, so
	// there's never a stale button pointing at the wrong place.
	const previous = ticketStore.getConfig(interaction.guildId);
	let panel = null;
	if (previous.panelMessageId) {
		const oldChannel = await interaction.guild.channels.fetch(previous.panelChannelId).catch(() => null);
		const oldMessage = await oldChannel?.messages.fetch(previous.panelMessageId).catch(() => null);
		if (oldMessage && oldChannel.id === channel.id) {
			panel = await oldMessage.edit(tickets.buildPanel()).catch(() => null);
		} else {
			await oldMessage?.delete().catch(() => null);
		}
	}
	panel ??= await channel.send(tickets.buildPanel());

	ticketStore.setConfig(interaction.guildId, {
		panelChannelId: channel.id,
		panelMessageId: panel.id,
		logChannelId: logChannel?.id ?? null,
	});

	const roleIds = staffRoleIds(interaction.guildId);
	await interaction.editReply({
		content: [
			`Tickets are on. Members open one from the button in ${channel}, or with \`/ticket open\`.`,
			`Each ticket is a private thread in ${channel}, numbered from ${tickets.formatNumber(1)}.`,
			roleIds.length
				? `Members of ${roleIds.map((id) => `<@&${id}>`).join(', ')} are added to every ticket.`
				: '**No mod or admin roles are set**, so only Administrators will see tickets. Add one with `/setup mod-role`.',
			logChannel
				? `Ticket events are logged in ${logChannel}.`
				: 'No log channel. Pass `log-channel:` to record who opened, claimed and closed each ticket.',
		].join('\n'),
		allowedMentions: { parse: [] },
	});
}

async function handleDisable(interaction) {
	requireAdmin(interaction);

	const { panelChannelId, panelMessageId } = ticketStore.getConfig(interaction.guildId);
	if (!ticketStore.clearConfig(interaction.guildId)) {
		throw new Error('Tickets aren\'t set up in this server, so there\'s nothing to turn off.');
	}

	const channel = await interaction.guild.channels.fetch(panelChannelId).catch(() => null);
	const panel = await channel?.messages.fetch(panelMessageId).catch(() => null);
	await panel?.delete().catch(() => null);

	const open = ticketStore.countOpen(interaction.guildId);
	await interaction.reply({
		content: [
			'Tickets are off, and the "Open a ticket" panel was removed.',
			open ? `The ${open} ticket${open === 1 ? '' : 's'} still open keep working and can be closed as usual.` : null,
			'Turn them back on with `/ticket setup`.',
		].filter(Boolean).join(' '),
		ephemeral: true,
	});
}

async function handleOpen(interaction) {
	await tickets.openForm(interaction);
}

async function handleClose(interaction) {
	const ticket = resolveTicket(interaction);
	await tickets.closeFromInteraction(interaction, ticket, interaction.options.getString('reason'));
}

async function handleReopen(interaction) {
	requireMod(interaction);
	await tickets.reopenFromInteraction(interaction, resolveTicket(interaction));
}

async function handleClaim(interaction) {
	requireMod(interaction);
	await tickets.claimFromInteraction(interaction, resolveTicket(interaction));
}

async function handleUnclaim(interaction) {
	requireMod(interaction);
	const ticket = resolveTicket(interaction);
	tickets.requireOpen(ticket);
	if (!ticket.claimedBy) throw new Error(`Ticket ${tickets.formatNumber(ticket.number)} isn't claimed.`);

	ticketStore.setClaim(ticket.id, ticket.guildId, null);
	const thread = await tickets.fetchThread(interaction.guild, ticket);
	await thread?.send({
		content: `${interaction.user} released this ticket from <@${ticket.claimedBy}>. Any staff member can claim it.`,
		allowedMentions: { parse: [] },
	}).catch(() => null);
	await tickets.postLog(interaction.guild, tickets.logEmbed(ticket, tickets.INFO_COLOR, 'unclaimed', [
		`**Released by:** ${interaction.user} (was <@${ticket.claimedBy}>)`,
	]));
	await interaction.reply({ content: `Ticket ${tickets.formatNumber(ticket.number)} is no longer claimed.`, ephemeral: true });
}

async function requireOpenThread(interaction, ticket) {
	tickets.requireOpen(ticket);
	const thread = await tickets.fetchThread(interaction.guild, ticket);
	if (!thread) throw new Error(`Ticket ${tickets.formatNumber(ticket.number)}'s thread no longer exists.`);
	return thread;
}

async function handleAdd(interaction) {
	requireMod(interaction);
	const ticket = resolveTicket(interaction);
	const thread = await requireOpenThread(interaction, ticket);
	const user = interaction.options.getUser('user');

	await thread.members.add(user.id).catch(() => {
		throw new Error(`I couldn't add ${user} — they probably can't see ${thread.parent ?? 'the ticket channel'}. Give them access to it first.`);
	});
	await thread.send({ content: `${interaction.user} added ${user} to this ticket.`, allowedMentions: { users: [user.id] } });
	await interaction.reply({ content: `Added ${user} to ticket ${tickets.formatNumber(ticket.number)}.`, ephemeral: true });
}

async function handleRemove(interaction) {
	requireMod(interaction);
	const ticket = resolveTicket(interaction);
	const thread = await requireOpenThread(interaction, ticket);
	const user = interaction.options.getUser('user');
	if (user.id === ticket.openerId) {
		throw new Error(`${user} opened this ticket, so they can't be removed from it. Close it with \`/ticket close\` instead.`);
	}

	await thread.members.remove(user.id);
	await thread.send({ content: `${interaction.user} removed ${user} from this ticket.`, allowedMentions: { parse: [] } });
	await interaction.reply({ content: `Removed ${user} from ticket ${tickets.formatNumber(ticket.number)}.`, ephemeral: true });
}

const STATUS_LABELS = { open: 'Open', closed: 'Closed', all: 'All' };

async function handleList(interaction) {
	requireMod(interaction);
	const status = interaction.options.getString('status') ?? 'open';
	const rows = ticketStore.listTickets(interaction.guildId, status === 'all' ? null : status, LIST_LIMIT);

	const lines = rows.map((ticket) => [
		`**${tickets.formatNumber(ticket.number)}** ${tickets.ticketLink(ticket)} — ${ticket.subject}`,
		`by <@${ticket.openerId}>`,
		ticket.status === 'open'
			? (ticket.claimedBy ? `claimed by <@${ticket.claimedBy}>` : 'unclaimed')
			: `closed <t:${Math.floor(new Date(ticket.closedAt).getTime() / 1000)}:R>`,
	].join(' · '));

	const embed = new EmbedBuilder()
		.setTitle(`${STATUS_LABELS[status]} tickets`)
		.setColor(tickets.INFO_COLOR)
		// Each line is well under 200 characters, so 25 stay inside the
		// description's 4096 limit.
		.setDescription(lines.join('\n') || 'None.')
		.setFooter({ text: rows.length === LIST_LIMIT ? `Showing the newest ${LIST_LIMIT}.` : `${rows.length} shown.` });

	await interaction.reply({ embeds: [embed], ephemeral: true });
}

const HANDLERS = {
	setup: handleSetup,
	disable: handleDisable,
	open: handleOpen,
	close: handleClose,
	reopen: handleReopen,
	claim: handleClaim,
	unclaim: handleUnclaim,
	add: handleAdd,
	remove: handleRemove,
	list: handleList,
};

function numberOption(option, description) {
	return option.setName('number').setDescription(description).setMinValue(1).setRequired(false);
}

module.exports = {
	// Switchable feature set this command belongs to (lib/features.js).
	// events/interactionCreate.js refuses it when the guild has it off. The
	// Close and Claim buttons inside existing tickets keep working regardless —
	// see lib/tickets.js.
	feature: 'tickets',
	data: new SlashCommandBuilder()
		.setName('ticket')
		.setDescription('Private support tickets between a member and the staff.')
		.addSubcommand((sub) => sub
			.setName('open')
			.setDescription('Open a private support ticket with the staff.'))
		.addSubcommand((sub) => sub
			.setName('close')
			.setDescription('Close a ticket. Its opener or any staff member can.')
			.addStringOption((option) => option.setName('reason').setDescription('Why it was closed, shown in the ticket').setMaxLength(500).setRequired(false))
			.addIntegerOption((option) => numberOption(option, 'Ticket number (defaults to the ticket this is run in)')))
		.addSubcommand((sub) => sub
			.setName('setup')
			.setDescription('(Admin) Turn tickets on, posting the "Open a ticket" panel in a channel.')
			.addChannelOption((option) => option
				.setName('channel')
				.setDescription('Where the panel goes; each ticket is a private thread here')
				.addChannelTypes(ChannelType.GuildText)
				.setRequired(true))
			.addChannelOption((option) => option
				.setName('log-channel')
				.setDescription('Optional channel to log ticket events in')
				.addChannelTypes(ChannelType.GuildText)
				.setRequired(false)))
		.addSubcommand((sub) => sub
			.setName('disable')
			.setDescription('(Admin) Turn tickets off. Open tickets keep working.'))
		.addSubcommand((sub) => sub
			.setName('reopen')
			.setDescription('(Mod) Reopen a closed ticket.')
			.addIntegerOption((option) => numberOption(option, 'Ticket number (defaults to the ticket this is run in)')))
		.addSubcommand((sub) => sub
			.setName('claim')
			.setDescription('(Mod) Claim a ticket, so other staff know you\'re handling it.')
			.addIntegerOption((option) => numberOption(option, 'Ticket number (defaults to the ticket this is run in)')))
		.addSubcommand((sub) => sub
			.setName('unclaim')
			.setDescription('(Mod) Release a claimed ticket.')
			.addIntegerOption((option) => numberOption(option, 'Ticket number (defaults to the ticket this is run in)')))
		.addSubcommand((sub) => sub
			.setName('add')
			.setDescription('(Mod) Add someone to a ticket.')
			.addUserOption((option) => option.setName('user').setDescription('Who to add').setRequired(true))
			.addIntegerOption((option) => numberOption(option, 'Ticket number (defaults to the ticket this is run in)')))
		.addSubcommand((sub) => sub
			.setName('remove')
			.setDescription('(Mod) Remove someone from a ticket.')
			.addUserOption((option) => option.setName('user').setDescription('Who to remove').setRequired(true))
			.addIntegerOption((option) => numberOption(option, 'Ticket number (defaults to the ticket this is run in)')))
		.addSubcommand((sub) => sub
			.setName('list')
			.setDescription('(Mod) List tickets, newest first.')
			.addStringOption((option) => option
				.setName('status')
				.setDescription('Which tickets to show (default: open)')
				.addChoices(
					{ name: 'Open', value: 'open' },
					{ name: 'Closed', value: 'closed' },
					{ name: 'All', value: 'all' },
				)
				.setRequired(false))),
	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();
		const handler = HANDLERS[subcommand];
		if (!handler) throw new Error(`Unknown /ticket subcommand: ${subcommand}`);
		await handler(interaction);
	},
};
