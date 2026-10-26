const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	EmbedBuilder,
	ModalBuilder,
	PermissionFlagsBits,
	TextInputBuilder,
	TextInputStyle,
	ThreadAutoArchiveDuration,
} = require('discord.js');
const ticketStore = require('../state/tickets');
const features = require('./features');
const { requireMod, staffRoleIds } = require('./permissions');

// Support tickets (#89), modeled on open-discord-bots/open-ticket (see
// References.md). Each ticket is a private thread in the channel an admin
// picked with /ticket setup, so the bot never creates a channel for it
// (WorkingAgreements.md § 7) — a member pressing "Open a ticket" is the ask
// for the thread.

const OPEN_BUTTON_ID = 'ticket:open';
const FORM_ID = 'ticket:form';
const CLOSE_BUTTON_ID = 'ticket:close';
const CLAIM_BUTTON_ID = 'ticket:claim';

const INFO_COLOR = 0x5865f2;
const SUCCESS_COLOR = 0x57f287;
const CLOSED_COLOR = 0xed4245;

const MAX_SUBJECT_LENGTH = 80;
const MAX_DETAILS_LENGTH = 1000;
const MEMBER_FETCH_TIMEOUT_MS = 15 * 1000;

// What the bot needs in the panel channel. The thread permissions are the
// feature itself: creating a private thread, talking in it, and locking it on
// close — locking is what stops a member reopening a closed ticket just by
// posting in it, and it needs Manage Threads.
const PANEL_PERMISSIONS = {
	ViewChannel: PermissionFlagsBits.ViewChannel,
	SendMessages: PermissionFlagsBits.SendMessages,
	EmbedLinks: PermissionFlagsBits.EmbedLinks,
	CreatePrivateThreads: PermissionFlagsBits.CreatePrivateThreads,
	SendMessagesInThreads: PermissionFlagsBits.SendMessagesInThreads,
	ManageThreads: PermissionFlagsBits.ManageThreads,
};

const LOG_PERMISSIONS = {
	ViewChannel: PermissionFlagsBits.ViewChannel,
	SendMessages: PermissionFlagsBits.SendMessages,
	EmbedLinks: PermissionFlagsBits.EmbedLinks,
};

function formatNumber(number) {
	return `#${String(number).padStart(4, '0')}`;
}

function threadName(ticket) {
	return `${formatNumber(ticket.number)} · ${ticket.subject}`.slice(0, 100);
}

// Throws naming every missing permission and where to grant it, so setup
// fails up front rather than every ticket failing later.
function requireBotPermissions(channel, wanted) {
	const granted = channel.permissionsFor(channel.guild.members.me);
	const missing = Object.entries(wanted)
		.filter(([, flag]) => !granted?.has(flag))
		.map(([name]) => name.replace(/([a-z])([A-Z])/g, '$1 $2'));
	if (missing.length) {
		throw new Error(
			`I'm missing **${missing.join(', ')}** in ${channel}. `
			+ 'Grant them to my role in that channel\'s settings (Edit Channel → Permissions), then run this again.',
		);
	}
}

function buildPanel() {
	return {
		embeds: [new EmbedBuilder()
			.setTitle('Need help from the staff?')
			.setColor(INFO_COLOR)
			.setDescription('Press the button below to open a private ticket. Only you and the staff can see it.')],
		components: [new ActionRowBuilder().addComponents(
			new ButtonBuilder().setCustomId(OPEN_BUTTON_ID).setLabel('Open a ticket').setStyle(ButtonStyle.Primary),
		)],
	};
}

function ticketControls() {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder().setCustomId(CLAIM_BUTTON_ID).setLabel('Claim').setStyle(ButtonStyle.Secondary),
		new ButtonBuilder().setCustomId(CLOSE_BUTTON_ID).setLabel('Close').setStyle(ButtonStyle.Danger),
	);
}

function ticketLink(ticket) {
	return ticket.threadId ? `<#${ticket.threadId}>` : formatNumber(ticket.number);
}

// --- Log channel ---------------------------------------------------------------

// Best-effort: a deleted log channel or a lost permission must never stop a
// ticket opening or closing.
async function postLog(guild, embed) {
	const { logChannelId } = ticketStore.getConfig(guild.id);
	if (!logChannelId) return;
	const channel = await guild.channels.fetch(logChannelId).catch(() => null);
	if (!channel?.isTextBased()) return;
	await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch((error) => {
		console.error(`Tickets: log post failed in guild ${guild.id}:`, error.message);
	});
}

function logEmbed(ticket, color, title, lines) {
	return new EmbedBuilder()
		.setColor(color)
		.setTitle(`${formatNumber(ticket.number)} ${title}`)
		.setDescription([`**Subject:** ${ticket.subject}`, `**Thread:** ${ticketLink(ticket)}`, ...lines].join('\n'))
		.setTimestamp();
}

// --- Resolving tickets and permissions -----------------------------------------

async function fetchThread(guild, ticket) {
	if (!ticket.threadId) return null;
	const thread = await guild.channels.fetch(ticket.threadId).catch(() => null);
	return thread?.isThread() ? thread : null;
}

function requireOpen(ticket) {
	if (ticket.status !== 'open') {
		throw new Error(`Ticket ${formatNumber(ticket.number)} is closed. Staff can reopen it with \`/ticket reopen number:${ticket.number}\`.`);
	}
}

function requireOpenerOrStaff(interaction, ticket) {
	if (interaction.user.id === ticket.openerId) return;
	requireMod(interaction);
}

// Every member holding a mod or admin role. The member list is loaded first
// when the cache is short of it, because a role's member list only covers
// cached members — the same trap lib/memberCounters.js hit. After the first
// load, the Server Members intent keeps the cache current, so later tickets
// don't fetch again. Admins by Discord's Administrator permission alone aren't
// added, but they can see every private thread anyway.
async function staffMemberIds(guild) {
	const roleIds = staffRoleIds(guild.id);
	if (!roleIds.length) return [];

	if (guild.members.cache.size < guild.memberCount) {
		await guild.members.fetch({ time: MEMBER_FETCH_TIMEOUT_MS }).catch((error) => {
			console.warn(`Tickets: couldn't load the member list for guild ${guild.id}, adding cached staff only:`, error.message);
		});
	}

	const ids = new Set();
	for (const roleId of roleIds) {
		for (const member of guild.roles.cache.get(roleId)?.members.values() ?? []) {
			if (!member.user.bot) ids.add(member.id);
		}
	}
	return [...ids];
}

// --- Opening -------------------------------------------------------------------

// Checks run before the form opens, so a member isn't asked to describe their
// problem for a ticket that can't be made. They run again on submit.
async function requireCanOpen(interaction) {
	features.requireEnabled(interaction, 'tickets');

	const { panelChannelId } = ticketStore.getConfig(interaction.guildId);
	if (!panelChannelId) {
		throw new Error('Tickets aren\'t set up in this server yet. An admin can turn them on with `/ticket setup`.');
	}
	const channel = await interaction.guild.channels.fetch(panelChannelId).catch(() => null);
	if (!channel) {
		throw new Error('The ticket channel no longer exists. An admin needs to run `/ticket setup` again.');
	}
	// A private thread is only reachable through its parent, so someone who
	// can't see the ticket channel couldn't see their own ticket.
	if (!channel.permissionsFor(interaction.member)?.has(PermissionFlagsBits.ViewChannel)) {
		throw new Error(`You can't see ${channel}, where tickets are opened, so you wouldn't be able to see yours. Ask the staff for access.`);
	}
	return channel;
}

async function openForm(interaction) {
	await requireCanOpen(interaction);

	const modal = new ModalBuilder()
		.setCustomId(FORM_ID)
		.setTitle('Open a support ticket')
		.addComponents(
			new ActionRowBuilder().addComponents(new TextInputBuilder()
				.setCustomId('subject')
				.setLabel('Subject')
				.setPlaceholder('A few words about what you need')
				.setStyle(TextInputStyle.Short)
				.setMaxLength(MAX_SUBJECT_LENGTH)
				.setRequired(true)),
			new ActionRowBuilder().addComponents(new TextInputBuilder()
				.setCustomId('details')
				.setLabel('Details')
				.setStyle(TextInputStyle.Paragraph)
				.setMaxLength(MAX_DETAILS_LENGTH)
				.setRequired(false)),
		);
	await interaction.showModal(modal);
}

async function createTicketThread(channel, ticket, opener) {
	const thread = await channel.threads.create({
		name: threadName(ticket),
		type: ChannelType.PrivateThread,
		// Only staff decide who else sees a ticket (/ticket add).
		invitable: false,
		autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
		reason: `Support ticket ${formatNumber(ticket.number)} opened by ${opener.tag}`,
	});
	ticketStore.attachThread(ticket.id, ticket.guildId, thread.id);
	return thread;
}

async function submitForm(interaction) {
	const channel = await requireCanOpen(interaction);
	await interaction.deferReply({ ephemeral: true });

	const subject = interaction.fields.getTextInputValue('subject').trim() || 'Support request';
	const details = interaction.fields.getTextInputValue('details').trim();
	const ticket = ticketStore.createTicket(interaction.guildId, interaction.user.id, subject);

	let thread;
	try {
		thread = await createTicketThread(channel, ticket, interaction.user);
	} catch (error) {
		ticketStore.discardUnstarted(ticket.id, ticket.guildId);
		throw new Error(`I couldn't create the ticket thread in ${channel}: ${error.message}. Ask an admin to check my permissions there.`);
	}
	ticket.threadId = thread.id;

	await thread.members.add(interaction.user.id);

	// Added one by one rather than by mentioning them, so it doesn't depend on
	// whether the bot is allowed to ping a role. Best-effort per member: one
	// staff member who can't see the channel mustn't stop the ticket.
	const staffIds = (await staffMemberIds(interaction.guild)).filter((id) => id !== interaction.user.id);
	const failed = [];
	for (const id of staffIds) {
		await thread.members.add(id).catch(() => failed.push(id));
	}

	const roleIds = staffRoleIds(interaction.guildId);
	const embed = new EmbedBuilder()
		.setColor(INFO_COLOR)
		.setTitle(`Ticket ${formatNumber(ticket.number)}: ${subject}`)
		.setDescription(details || '*No details given.*')
		.addFields({ name: 'Opened by', value: `${interaction.user}`, inline: true })
		.setFooter({ text: 'Staff: use Claim to take this ticket. Either of you can Close it when it\'s resolved.' })
		.setTimestamp();

	await thread.send({
		content: [
			`${interaction.user}, thanks — the staff have been added and will reply here.`,
			roleIds.length ? roleIds.map((id) => `<@&${id}>`).join(' ') : null,
		].filter(Boolean).join('\n'),
		embeds: [embed],
		components: [ticketControls()],
		// The opener and the staff roles only — never @everyone from a subject line.
		allowedMentions: { users: [interaction.user.id], roles: roleIds },
	});

	const lines = [`**Opened by:** ${interaction.user}`];
	if (!roleIds.length) {
		lines.push('**No mod or admin roles are set**, so no staff were added. Set one with `/setup mod-role`.');
	}
	if (failed.length) {
		lines.push(`**Couldn't add:** ${failed.map((id) => `<@${id}>`).join(', ')} — they probably can't see the ticket channel.`);
	}
	await postLog(interaction.guild, logEmbed(ticket, SUCCESS_COLOR, 'opened', lines));

	await interaction.editReply({ content: `Your ticket is open: ${thread}. The staff will reply there.` });
}

// --- Closing, reopening, claiming ----------------------------------------------

async function lockAndArchive(thread, reason) {
	if (!thread) return;
	// Locked first: an archived thread that isn't locked reopens the moment
	// anyone posts in it.
	await thread.setLocked(true, reason).catch((error) => {
		console.error(`Tickets: couldn't lock thread ${thread.id}:`, error.message);
	});
	await thread.setArchived(true, reason).catch((error) => {
		console.error(`Tickets: couldn't archive thread ${thread.id}:`, error.message);
	});
}

// Shared by the Close button and /ticket close. The interaction is answered
// before the thread is archived, because a reply into an archived thread fails.
async function closeFromInteraction(interaction, ticket, reason = null) {
	requireOpenerOrStaff(interaction, ticket);
	if (!ticketStore.closeTicket(ticket.id, ticket.guildId, interaction.user.id)) {
		throw new Error(`Ticket ${formatNumber(ticket.number)} is already closed.`);
	}

	const embed = new EmbedBuilder()
		.setColor(CLOSED_COLOR)
		.setTitle(`Ticket ${formatNumber(ticket.number)} closed`)
		.setDescription([
			`Closed by ${interaction.user}.`,
			reason ? `**Reason:** ${reason}` : null,
			'This thread is now locked. Staff can reopen it with `/ticket reopen`.',
		].filter(Boolean).join('\n'));

	const thread = await fetchThread(interaction.guild, ticket);
	if (interaction.channelId === ticket.threadId) {
		await interaction.reply({ embeds: [embed] });
	} else {
		await thread?.send({ embeds: [embed] }).catch(() => null);
		await interaction.reply({ content: `Closed ticket ${formatNumber(ticket.number)} (${ticketLink(ticket)}).`, ephemeral: true });
	}
	await lockAndArchive(thread, `Ticket closed by ${interaction.user.tag}`);

	await postLog(interaction.guild, logEmbed(ticket, CLOSED_COLOR, 'closed', [
		`**Closed by:** ${interaction.user}`,
		reason ? `**Reason:** ${reason}` : null,
	].filter(Boolean)));
}

async function reopenFromInteraction(interaction, ticket) {
	requireMod(interaction);
	const thread = await fetchThread(interaction.guild, ticket);
	if (!thread) {
		throw new Error(`Ticket ${formatNumber(ticket.number)}'s thread has been deleted, so it can't be reopened. The member can open a new ticket.`);
	}
	if (!ticketStore.reopenTicket(ticket.id, ticket.guildId)) {
		throw new Error(`Ticket ${formatNumber(ticket.number)} is already open: ${thread}.`);
	}

	// Unarchived before unlocking: Discord refuses any other edit to a thread
	// while it's archived.
	await thread.setArchived(false, `Ticket reopened by ${interaction.user.tag}`);
	await thread.setLocked(false, `Ticket reopened by ${interaction.user.tag}`);
	await thread.send({
		content: `<@${ticket.openerId}>, ${interaction.user} reopened this ticket.`,
		allowedMentions: { users: [ticket.openerId] },
	});

	await postLog(interaction.guild, logEmbed(ticket, INFO_COLOR, 'reopened', [`**Reopened by:** ${interaction.user}`]));
	await interaction.reply({ content: `Reopened ticket ${formatNumber(ticket.number)}: ${thread}.`, ephemeral: true });
}

async function claimFromInteraction(interaction, ticket) {
	requireMod(interaction);
	requireOpen(ticket);
	if (ticket.claimedBy === interaction.user.id) {
		throw new Error('You\'ve already claimed this ticket.');
	}
	if (ticket.claimedBy) {
		throw new Error(`<@${ticket.claimedBy}> has already claimed this ticket. They, or any staff, can release it with \`/ticket unclaim\`.`);
	}
	ticketStore.setClaim(ticket.id, ticket.guildId, interaction.user.id);

	const content = `${interaction.user} has claimed this ticket and will handle it.`;
	if (interaction.channelId === ticket.threadId) {
		await interaction.reply({ content, allowedMentions: { parse: [] } });
	} else {
		const thread = await fetchThread(interaction.guild, ticket);
		await thread?.send({ content, allowedMentions: { parse: [] } }).catch(() => null);
		await interaction.reply({ content: `You claimed ticket ${formatNumber(ticket.number)} (${ticketLink(ticket)}).`, ephemeral: true });
	}
	await postLog(interaction.guild, logEmbed(ticket, INFO_COLOR, 'claimed', [`**Claimed by:** ${interaction.user}`]));
}

// --- Components ----------------------------------------------------------------

async function handleTicketButtonInteraction(interaction) {
	const { customId } = interaction;
	if (customId === OPEN_BUTTON_ID) {
		await openForm(interaction);
		return true;
	}
	if (customId !== CLOSE_BUTTON_ID && customId !== CLAIM_BUTTON_ID) return false;

	// Close and Claim are deliberately NOT gated on the tickets feature switch
	// (#69): switching tickets off stops new ones, but a member already waiting
	// in an open ticket mustn't be stranded in it. Same principle as the
	// giveaway entry button in lib/giveaways.js.
	const ticket = ticketStore.getByThread(interaction.channelId, interaction.guildId);
	if (!ticket) {
		await interaction.reply({ content: 'This thread isn\'t a ticket I know about.', ephemeral: true });
		return true;
	}

	if (customId === CLOSE_BUTTON_ID) await closeFromInteraction(interaction, ticket);
	else await claimFromInteraction(interaction, ticket);
	return true;
}

async function handleTicketModal(interaction) {
	if (interaction.customId !== FORM_ID) return false;
	await submitForm(interaction);
	return true;
}

// --- Events --------------------------------------------------------------------

// A ticket thread deleted by hand would otherwise sit in /ticket list as open
// forever.
async function handleThreadDelete(thread) {
	const ticket = ticketStore.getByThread(thread.id, thread.guildId);
	if (!ticket || ticket.status !== 'open') return;
	if (!ticketStore.closeTicket(ticket.id, ticket.guildId, null)) return;
	await postLog(thread.guild, logEmbed(ticket, CLOSED_COLOR, 'closed', ['**The thread was deleted**, so the ticket was closed.']));
}

module.exports = {
	PANEL_PERMISSIONS,
	LOG_PERMISSIONS,
	formatNumber,
	threadName,
	requireBotPermissions,
	buildPanel,
	ticketLink,
	fetchThread,
	requireOpen,
	postLog,
	logEmbed,
	openForm,
	closeFromInteraction,
	reopenFromInteraction,
	claimFromInteraction,
	handleTicketButtonInteraction,
	handleTicketModal,
	handleThreadDelete,
	INFO_COLOR,
};
