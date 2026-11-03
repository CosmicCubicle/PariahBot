const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	EmbedBuilder,
	ModalBuilder,
	PermissionFlagsBits,
	RESTJSONErrorCodes,
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

function threadGoneMessage(ticket) {
	return `Ticket ${formatNumber(ticket.number)}'s thread has been deleted, so the ticket is closed. The member can open a new one.`;
}

// Records a ticket as closed because its thread is gone. Nobody closed it
// through the bot, so closed_by stays null.
async function closeOrphan(guild, ticket, why) {
	if (!ticketStore.closeTicket(ticket.id, ticket.guildId, null)) return false;
	await postLog(guild, logEmbed(ticket, CLOSED_COLOR, 'closed', [why]));
	return true;
}

// The ticket's thread, or null when it has been deleted. threadDelete only
// fires for threads the bot has cached, so an archived thread deleted while
// the bot was offline is first noticed here, and its ticket is closed on the
// spot. Any other failure (a lost permission, an outage) is reported as
// itself rather than as a deleted thread.
async function fetchThread(guild, ticket) {
	if (!ticket.threadId) return null;
	try {
		const thread = await guild.channels.fetch(ticket.threadId);
		return thread?.isThread() ? thread : null;
	} catch (error) {
		if (error.code !== RESTJSONErrorCodes.UnknownChannel) {
			throw new Error(`I couldn't reach ticket ${formatNumber(ticket.number)}'s thread: ${error.message}`);
		}
		if (ticket.status === 'open') {
			await closeOrphan(guild, ticket, '**The thread was deleted**, so the ticket was closed.');
			ticket.status = 'closed';
		}
		return null;
	}
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

// An open ticket's thread, ready to change who's in it. Tickets left idle for
// a week auto-archive while staying open, and Discord refuses member changes
// on an archived thread, so it's unarchived first.
async function openThreadForChange(guild, ticket) {
	requireOpen(ticket);
	const thread = await fetchThread(guild, ticket);
	if (!thread) throw new Error(threadGoneMessage(ticket));
	if (thread.archived) await thread.edit({ archived: false, reason: 'Support ticket changed while archived' });
	return thread;
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

// Staff are added one by one rather than left to the role mention in the
// welcome message. A role mention only reaches its members when the role is
// mentionable or the bot has Mention Everyone, and the bot deliberately
// doesn't ask for that (lib/invitePermissions.js) — new roles aren't
// mentionable by default, so relying on it would leave most servers' staff
// out of every ticket. Best-effort per member: one staff member who can't see
// the channel mustn't stop the ticket. Returns who couldn't be added.
async function addStaff(thread, guild, openerId) {
	const failed = [];
	for (const id of await staffMemberIds(guild)) {
		if (id === openerId) continue;
		await thread.members.add(id).catch(() => failed.push(id));
	}
	return failed;
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

// Undoes a ticket whose thread exists but couldn't be finished, so the
// member's retry doesn't leave a second, button-less ticket behind. If the
// thread can't be deleted either, the ticket is kept and the member is told
// where it is, because it really does exist.
async function abandonTicket(thread, ticket, error) {
	const deleted = await thread.delete('Support ticket could not be finished').then(() => true, () => false);
	if (deleted) {
		ticketStore.discardFailed(ticket.id, ticket.guildId, thread.id);
		throw new Error(`I couldn't finish setting up your ticket (${error.message}), so I removed it. Please try again, and tell the staff if it keeps happening.`);
	}
	throw new Error(`Your ticket ${thread} was created, but I couldn't finish setting it up (${error.message}). The staff can still see it, and can close it with \`/ticket close\`.`);
}

async function submitForm(interaction) {
	const channel = await requireCanOpen(interaction);
	await interaction.deferReply({ ephemeral: true });

	const subject = interaction.fields.getTextInputValue('subject').trim() || 'Support request';
	const details = interaction.fields.getTextInputValue('details').trim();
	const ticket = ticketStore.createTicket(interaction.guildId, channel.id, interaction.user.id, subject);

	let thread;
	try {
		thread = await createTicketThread(channel, ticket, interaction.user);
	} catch (error) {
		ticketStore.discardUnstarted(ticket.id, ticket.guildId);
		throw new Error(`I couldn't create the ticket thread in ${channel}: ${error.message}. Ask an admin to check my permissions there.`);
	}
	ticket.threadId = thread.id;

	const roleIds = staffRoleIds(interaction.guildId);
	let failed;
	try {
		await thread.members.add(interaction.user.id);
		failed = await addStaff(thread, interaction.guild, interaction.user.id);
		await thread.send({
			content: [
				`${interaction.user}, thanks — the staff have been added and will reply here.`,
				roleIds.length ? roleIds.map((id) => `<@&${id}>`).join(' ') : null,
			].filter(Boolean).join('\n'),
			embeds: [new EmbedBuilder()
				.setColor(INFO_COLOR)
				.setTitle(`Ticket ${formatNumber(ticket.number)}: ${subject}`)
				.setDescription(details || '*No details given.*')
				.addFields({ name: 'Opened by', value: `${interaction.user}`, inline: true })
				.setFooter({ text: 'Staff: use Claim to take this ticket. Either of you can Close it when it\'s resolved.' })
				.setTimestamp()],
			components: [ticketControls()],
			// The opener and the staff roles only — never @everyone from a subject line.
			allowedMentions: { users: [interaction.user.id], roles: roleIds },
		});
	} catch (error) {
		await abandonTicket(thread, ticket, error);
	}

	const lines = [`**Opened by:** ${interaction.user}`];
	if (!roleIds.length) {
		lines.push('**No mod or admin roles are set**, so no staff were added. Set one with `/setup mod-role`.');
	}
	if (failed.length) {
		lines.push(`**Couldn't add:** ${failed.map((id) => `<@${id}>`).join(', ')} — they probably can't see the ticket channel.`);
	}
	await Promise.all([
		postLog(interaction.guild, logEmbed(ticket, SUCCESS_COLOR, 'opened', lines)),
		interaction.editReply({ content: `Your ticket is open: ${thread}. The staff will reply there.` }),
	]);
}

// --- Closing, reopening, claiming ----------------------------------------------

// Shared by the Close button and /ticket close.
async function closeFromInteraction(interaction, ticket, reason = null) {
	requireOpenerOrStaff(interaction, ticket);
	requireOpen(ticket);
	await interaction.deferReply({ ephemeral: true });

	const thread = await fetchThread(interaction.guild, ticket);
	if (!thread) throw new Error(threadGoneMessage(ticket));

	// Claimed in the database first, so the Close button and /ticket close
	// racing can't both post a closing message — and put back if Discord
	// refuses the rest, so the record never says closed over an open thread.
	if (!ticketStore.closeTicket(ticket.id, ticket.guildId, interaction.user.id)) {
		throw new Error(`Ticket ${formatNumber(ticket.number)} is already closed.`);
	}
	const undo = (error, doing) => {
		ticketStore.reopenTicket(ticket.id, ticket.guildId);
		return new Error(`I couldn't ${doing} (${error.message}), so ticket ${formatNumber(ticket.number)} is still open. Check I have Manage Threads in ${thread.parent ?? 'the ticket channel'}, then try again.`);
	};

	const embed = new EmbedBuilder()
		.setColor(CLOSED_COLOR)
		.setTitle(`Ticket ${formatNumber(ticket.number)} closed`)
		.setDescription([
			`Closed by ${interaction.user}.`,
			reason ? `**Reason:** ${reason}` : null,
			'This thread is now locked. Staff can reopen it with `/ticket reopen`.',
		].filter(Boolean).join('\n'));

	try {
		await thread.send({ embeds: [embed] });
	} catch (error) {
		throw undo(error, 'post in the thread');
	}
	// Answered before archiving: the deferred reply lives in the thread when
	// Close was pressed there, and an archived thread won't take it.
	await interaction.editReply({ content: `Closed ticket ${formatNumber(ticket.number)}.` }).catch(() => null);
	try {
		// Locked as well as archived, in one edit: an archived thread that
		// isn't locked reopens the moment anyone posts in it.
		await thread.edit({ locked: true, archived: true, reason: `Ticket closed by ${interaction.user.tag}` });
	} catch (error) {
		throw undo(error, 'lock the thread');
	}

	await postLog(interaction.guild, logEmbed(ticket, CLOSED_COLOR, 'closed', [
		`**Closed by:** ${interaction.user}`,
		reason ? `**Reason:** ${reason}` : null,
	].filter(Boolean)));
}

async function reopenFromInteraction(interaction, ticket) {
	requireMod(interaction);
	if (ticket.status === 'open') {
		throw new Error(`Ticket ${formatNumber(ticket.number)} is already open: ${ticketLink(ticket)}.`);
	}
	await interaction.deferReply({ ephemeral: true });

	const thread = await fetchThread(interaction.guild, ticket);
	if (!thread) throw new Error(threadGoneMessage(ticket));

	// Discord first, then the database, so a thread that can't be unlocked
	// leaves the ticket closed and a retry still works. One edit, and it has to
	// be: Discord refuses any other change to a thread while it's archived.
	await thread.edit({ archived: false, locked: false, reason: `Ticket reopened by ${interaction.user.tag}` }).catch((error) => {
		throw new Error(`I couldn't unlock ticket ${formatNumber(ticket.number)}'s thread (${error.message}). Check I have Manage Threads in ${thread.parent ?? 'the ticket channel'}, then try again.`);
	});
	if (!ticketStore.reopenTicket(ticket.id, ticket.guildId)) {
		await interaction.editReply({ content: `Ticket ${formatNumber(ticket.number)} was already reopened: ${thread}.` });
		return;
	}

	await Promise.all([
		thread.send({
			content: `<@${ticket.openerId}>, ${interaction.user} reopened this ticket.`,
			allowedMentions: { users: [ticket.openerId] },
		}).catch(() => null),
		postLog(interaction.guild, logEmbed(ticket, INFO_COLOR, 'reopened', [`**Reopened by:** ${interaction.user}`])),
	]);
	await interaction.editReply({ content: `Reopened ticket ${formatNumber(ticket.number)}: ${thread}.` });
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
	await interaction.deferReply({ ephemeral: true });

	const thread = await fetchThread(interaction.guild, ticket);
	if (!thread) throw new Error(threadGoneMessage(ticket));
	if (!ticketStore.claimTicket(ticket.id, ticket.guildId, interaction.user.id)) {
		throw new Error('Someone else claimed this ticket just now. `/ticket list` shows who.');
	}

	await Promise.all([
		thread.send({ content: `${interaction.user} has claimed this ticket and will handle it.`, allowedMentions: { parse: [] } }).catch(() => null),
		postLog(interaction.guild, logEmbed(ticket, INFO_COLOR, 'claimed', [`**Claimed by:** ${interaction.user}`])),
	]);
	await interaction.editReply({ content: `You claimed ticket ${formatNumber(ticket.number)} (${ticketLink(ticket)}).` });
}

// --- Listing -------------------------------------------------------------------

const EMBED_DESCRIPTION_LIMIT = 4096;
const LIST_SUBJECT_LENGTH = 60;

function listLine(ticket) {
	const subject = ticket.subject.length > LIST_SUBJECT_LENGTH
		? `${ticket.subject.slice(0, LIST_SUBJECT_LENGTH - 1)}…`
		: ticket.subject;
	return [
		`**${formatNumber(ticket.number)}** ${ticketLink(ticket)} — ${subject}`,
		`by <@${ticket.openerId}>`,
		ticket.status === 'open'
			? (ticket.claimedBy ? `claimed by <@${ticket.claimedBy}>` : 'unclaimed')
			: `closed <t:${Math.floor(new Date(ticket.closedAt).getTime() / 1000)}:R>`,
	].join(' · ');
}

// The /ticket list body, kept under the embed description's 4096 characters
// however long the subjects and IDs are. Lines stop where the next one
// wouldn't fit, leaving room for the line that says how many were left out.
function formatTicketList(rows) {
	if (!rows.length) return 'None.';
	const lines = [];
	let length = 0;
	for (const [index, ticket] of rows.entries()) {
		const line = listLine(ticket);
		const more = `…and ${rows.length - index} more. Pass \`number:\` to act on one directly.`;
		const reserve = index < rows.length - 1 ? more.length + 1 : 0;
		if (length + line.length + 1 + reserve > EMBED_DESCRIPTION_LIMIT) {
			lines.push(more);
			break;
		}
		lines.push(line);
		length += line.length + 1;
	}
	return lines.join('\n');
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
// forever. Only fires for cached threads; fetchThread and
// handleChannelDelete cover the rest.
async function handleThreadDelete(thread) {
	const ticket = ticketStore.getByThread(thread.id, thread.guildId);
	if (!ticket || ticket.status !== 'open') return;
	await closeOrphan(thread.guild, ticket, '**The thread was deleted**, so the ticket was closed.');
}

// Deleting a channel takes every thread in it, with no threadDelete for each
// one. If it was the panel channel, tickets are also switched off, since new
// ones would have nowhere to go.
async function handleChannelDelete(channel) {
	if (!channel.guild) return;
	const guildId = channel.guild.id;
	const open = ticketStore.listOpenInChannel(channel.id, guildId);
	const wasPanel = ticketStore.getConfig(guildId).panelChannelId === channel.id;
	if (!open.length && !wasPanel) return;

	const closed = open.filter((ticket) => ticketStore.closeTicket(ticket.id, guildId, null));
	if (wasPanel) ticketStore.clearConfig(guildId);

	await postLog(channel.guild, new EmbedBuilder()
		.setColor(CLOSED_COLOR)
		.setTitle('Ticket channel deleted')
		.setDescription([
			`**#${channel.name}** was deleted, taking its ticket threads with it.`,
			closed.length ? `**Closed:** ${closed.map((ticket) => formatNumber(ticket.number)).join(', ')}` : null,
			wasPanel ? 'It held the "Open a ticket" panel, so **tickets are now off**. Run `/ticket setup` to turn them back on in another channel.' : null,
		].filter(Boolean).join('\n'))
		.setTimestamp());
}

// A row still without a thread is one the bot was creating when it stopped.
// It would otherwise sit open in /ticket list, beyond the reach of
// /ticket close, which needs a thread. Called once at startup; the cutoff
// keeps it clear of a ticket genuinely being opened as the bot comes up.
const STALE_UNSTARTED_MS = 60 * 1000;

function discardAbandonedTickets() {
	const removed = ticketStore.discardStaleUnstarted(new Date(Date.now() - STALE_UNSTARTED_MS).toISOString());
	if (removed) console.log(`Tickets: discarded ${removed} ticket(s) left half-created by a restart.`);
	return removed;
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
	threadGoneMessage,
	requireOpen,
	openThreadForChange,
	postLog,
	logEmbed,
	openForm,
	closeFromInteraction,
	reopenFromInteraction,
	claimFromInteraction,
	formatTicketList,
	handleTicketButtonInteraction,
	handleTicketModal,
	handleThreadDelete,
	handleChannelDelete,
	discardAbandonedTickets,
	INFO_COLOR,
};
