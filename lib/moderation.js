const {
	ActionRowBuilder,
	EmbedBuilder,
	ModalBuilder,
	PermissionFlagsBits,
	RESTJSONErrorCodes,
	TextInputBuilder,
	TextInputStyle,
} = require('discord.js');
const tempBanStore = require('../state/tempBans');
const caseStore = require('../state/modCases');
const guildSettings = require('../state/guildSettings');
const { isMod, requireMod } = require('./permissions');
const { sendAlert } = require('./alertDelivery');
const { parseDuration, formatDuration } = require('./duration');

// /mod and the right-click Kick/Ban/Timeout actions. Alongside lib/honeypot.js
// this is the only code that removes members, so it follows the same rules
// (WorkingAgreements.md § 3 and § 4):
//   1. staff (admins and mods) are never acted on, checked first
//   2. the DM goes out before the removal, best-effort
//   3. every API call carries a reason naming the moderator
//   4. the outcome is reported through sendAlert, failures included
// Every action is also recorded as a case (state/modCases.js), so /mod history
// shows the full record — including what the bot did on its own.

const ALERT_COLOR = 0xed4245;

// Discord's own limits.
const MAX_TIMEOUT_SECONDS = 28 * 24 * 60 * 60;
const MAX_AUDIT_REASON_LENGTH = 512;

// Long enough for any real temporary ban, short enough that a typo like
// "700d" is caught.
const MAX_TEMP_BAN_SECONDS = 365 * 24 * 60 * 60;

// Leaves room in the audit-log reason for " — by <tag> (<id>)".
const MAX_REASON_LENGTH = 400;

// setTimeout's ceiling is about 24.8 days; longer temporary bans re-arm in
// chunks, as giveaways do (see lib/giveaways.js).
const MAX_TIMER_MS = 2_147_000_000;

const MIN_ESCALATION_WARNINGS = 2;
const MAX_ESCALATION_WARNINGS = 20;
// Long enough for "3 warnings in a month", short enough that a typo is caught.
const MAX_ESCALATION_WINDOW_SECONDS = 365 * 24 * 60 * 60;

// Validates escalation settings as typed ("7d", "1h"), returning what
// guildSettings.setWarnEscalation stores. Shared by /mod config escalation and
// the admin dashboard.
function parseEscalation({ count, within, timeout }) {
	if (!Number.isInteger(count) || count < MIN_ESCALATION_WARNINGS || count > MAX_ESCALATION_WARNINGS) {
		throw new Error(`The number of warnings must be from ${MIN_ESCALATION_WARNINGS} to ${MAX_ESCALATION_WARNINGS}.`);
	}
	const windowSeconds = parseDuration(within);
	const timeoutSeconds = parseDuration(timeout);
	if (windowSeconds > MAX_ESCALATION_WINDOW_SECONDS) {
		throw new Error(`The window can be at most ${formatDuration(MAX_ESCALATION_WINDOW_SECONDS)}.`);
	}
	if (timeoutSeconds > MAX_TIMEOUT_SECONDS) {
		throw new Error(`Discord allows a timeout of at most ${formatDuration(MAX_TIMEOUT_SECONDS)}.`);
	}
	return { count, windowSeconds, timeoutSeconds };
}

const DELETE_MESSAGE_CHOICES = [
	{ name: "Don't delete any", value: 0 },
	{ name: 'Last hour', value: 60 * 60 },
	{ name: 'Last 24 hours', value: 24 * 60 * 60 },
	{ name: 'Last 7 days', value: 7 * 24 * 60 * 60 },
];

// What each action needs from the bot, and how it's described.
const ACTIONS = {
	kick: { verb: 'kick', past: 'kicked', permission: PermissionFlagsBits.KickMembers, permissionName: 'Kick Members', canAct: (member) => member.kickable, needsMember: true },
	ban: { verb: 'ban', past: 'banned', permission: PermissionFlagsBits.BanMembers, permissionName: 'Ban Members', canAct: (member) => member.bannable, needsMember: false },
	softban: { verb: 'softban', past: 'softbanned', permission: PermissionFlagsBits.BanMembers, permissionName: 'Ban Members', canAct: (member) => member.bannable, needsMember: false },
	timeout: { verb: 'time out', past: 'timed out', permission: PermissionFlagsBits.ModerateMembers, permissionName: 'Timeout Members', canAct: (member) => member.moderatable, needsMember: true },
	untimeout: { verb: 'remove the timeout from', past: 'had their timeout removed', permission: PermissionFlagsBits.ModerateMembers, permissionName: 'Timeout Members', canAct: (member) => member.moderatable, needsMember: true },
	// A warning changes nothing in Discord, so it needs no permission and no
	// role above theirs — but it still never targets an admin or mod.
	warn: { verb: 'warn', past: 'warned', permission: null, permissionName: null, canAct: () => true, needsMember: true },
};

// How each case's action reads in /mod history and alerts.
const CASE_LABELS = {
	warn: '⚠️ Warning',
	timeout: '🔇 Timeout',
	untimeout: '🔊 Timeout removed',
	kick: '👢 Kick',
	softban: '🧹 Softban',
	tempban: '⏳ Temporary ban',
	ban: '🔨 Ban',
	unban: '🔓 Unban',
};

function auditReason(reason, actor) {
	return `${reason || 'No reason given'} — by ${actor.user.tag} (${actor.id})`.slice(0, MAX_AUDIT_REASON_LENGTH);
}

// Every check that can stop an action, in one place, run before anything is
// sent or changed. member is null when the user isn't in the server — only a
// ban (or softban) can target someone who isn't.
function checkTarget(guild, actor, user, member, action) {
	const { verb, permission, permissionName, canAct, needsMember } = ACTIONS[action];

	if (permission && !guild.members.me.permissions.has(permission)) {
		throw new Error(`I need the **${permissionName}** permission to ${verb} anyone. Add it to my PariahBot role in Server Settings → Roles.`);
	}
	if (user.id === actor.id) throw new Error(`You can't ${verb} yourself.`);
	if (user.id === guild.client.user.id) throw new Error(`I can't ${verb} myself.`);
	if (user.id === guild.ownerId) throw new Error(`Nobody can ${verb} the server owner.`);

	if (!member) {
		if (needsMember) throw new Error(`${user} isn't in this server.`);
		return;
	}

	// The one guard that must never be removed: the bot never acts against its
	// own staff, admins or mods — same rule as the honeypot's
	// (WorkingAgreements.md § 3).
	if (isMod(member, guild.id)) {
		throw new Error(`${member} is staff (Administrator, an admin role or a mod role), so I won't ${verb} them. Take that away first if you really mean to.`);
	}

	// Discord's own rule for its kick and ban: you can only act on someone
	// below you. The owner outranks everyone.
	if (actor.id !== guild.ownerId && actor.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
		throw new Error(`Your highest role isn't above ${member}'s, so you can't ${verb} them.`);
	}

	if (!canAct(member)) {
		throw new Error(`My highest role isn't above ${member}'s, so Discord won't let me ${verb} them. Move my PariahBot role above theirs in Server Settings → Roles.`);
	}
}

// Best-effort: closed DMs, or someone the bot shares no server with, is
// normal and must never block the action. Returns whether it arrived.
async function notify(user, text) {
	return user.send(text).then(() => true).catch(() => false);
}

// actor is null when the bot acted on its own.
function recordCase(guild, userId, actor, action, reason, durationSeconds = null) {
	return caseStore.addCase({ guildId: guild.id, userId, moderatorId: actor?.id ?? null, action, reason, durationSeconds });
}

async function report(guild, { title, user, actor, reason, caseId = null, fields = [] }) {
	const embed = new EmbedBuilder()
		.setColor(ALERT_COLOR)
		.setTitle(title)
		.addFields(
			{ name: 'Member', value: `${user} (${user.tag ?? user.username}, ${user.id})`, inline: true },
			{ name: 'Moderator', value: actor ? `${actor}` : 'PariahBot', inline: true },
			{ name: 'Reason', value: reason || 'No reason given' },
			...fields,
		)
		.setTimestamp();
	if (caseId) embed.setFooter({ text: `Case #${caseId} · /mod history to see all` });
	await sendAlert(guild, { embeds: [embed], allowedMentions: { parse: [] } }).catch((error) => {
		console.error(`Moderation: failed to send alert in guild ${guild.id}:`, error.message);
	});
}

async function fetchMember(guild, userId) {
	return guild.members.fetch(userId).catch(() => null);
}

async function isBanned(guild, userId) {
	return guild.bans.fetch({ user: userId, force: true }).then(() => true).catch((error) => {
		if (error.code === RESTJSONErrorCodes.UnknownBan) return false;
		throw error;
	});
}

function reasonLine(reason) {
	return reason ? ` Reason: ${reason}` : '';
}

// The server's /mod config appeal-note, on its own line in a ban DM.
function appealLine(guild) {
	const { banAppealNote } = guildSettings.getGuildSettings(guild.id);
	return banAppealNote ? `\n${banAppealNote}` : '';
}

async function kick(guild, actor, user, reason) {
	const member = await fetchMember(guild, user.id);
	checkTarget(guild, actor, user, member, 'kick');

	// DM first: once they're gone the bot can't open a DM with them.
	const dmSent = await notify(user, `You were kicked from **${guild.name}**.${reasonLine(reason)}`);
	await member.kick(auditReason(reason, actor));
	const caseId = recordCase(guild, user.id, actor, 'kick', reason);

	await report(guild, { title: '👢 Member kicked', user, actor, reason, caseId, fields: [{ name: 'DM', value: dmSent ? 'Sent' : "Couldn't be delivered", inline: true }] });
	return `Kicked ${user} (case #${caseId}).${dmSent ? '' : " They couldn't be DMed."}`;
}

async function ban(guild, actor, user, reason, { deleteSeconds = 0, durationSeconds = null } = {}) {
	if (durationSeconds !== null && durationSeconds > MAX_TEMP_BAN_SECONDS) {
		throw new Error(`A temporary ban can last at most ${formatDuration(MAX_TEMP_BAN_SECONDS)}. Leave the duration empty for a permanent ban.`);
	}
	const member = await fetchMember(guild, user.id);
	checkTarget(guild, actor, user, member, 'ban');
	if (await isBanned(guild, user.id)) {
		throw new Error(`${user} is already banned. To change it, \`/mod unban\` them first.`);
	}

	const unbanAt = durationSeconds ? new Date(Date.now() + (durationSeconds * 1000)) : null;
	const until = unbanAt ? ` until <t:${Math.floor(unbanAt.getTime() / 1000)}:F>` : '';

	// DM first, while they still share the server.
	const dmSent = await notify(user, `You were banned from **${guild.name}**${until}.${reasonLine(reason)}${appealLine(guild)}`);
	await guild.bans.create(user.id, { deleteMessageSeconds: deleteSeconds, reason: auditReason(reason, actor) });
	const caseId = recordCase(guild, user.id, actor, durationSeconds ? 'tempban' : 'ban', reason, durationSeconds);

	if (unbanAt) {
		tempBanStore.setTempBan(guild.id, user.id, unbanAt.toISOString(), actor.id, reason);
		scheduleUnban(guild.client, tempBanStore.getTempBan(guild.id, user.id));
	} else {
		// A permanent ban replaces any earlier temporary one.
		tempBanStore.removeTempBan(guild.id, user.id);
	}

	const fields = [
		{ name: 'Length', value: durationSeconds ? `${formatDuration(durationSeconds)} (until <t:${Math.floor(unbanAt.getTime() / 1000)}:F>)` : 'Permanent', inline: true },
		{ name: 'DM', value: dmSent ? 'Sent' : "Couldn't be delivered", inline: true },
	];
	await report(guild, { title: durationSeconds ? '⏳ Member temporarily banned' : '🔨 Member banned', user, actor, reason, caseId, fields });
	return `Banned ${user}${durationSeconds ? ` for ${formatDuration(durationSeconds)}` : ''} (case #${caseId}).${dmSent ? '' : " They couldn't be DMed."}`;
}

// Ban, then unban straight away: Discord deletes their recent messages, and
// they can rejoin. The same thing the honeypot's default "remove" does.
async function softban(guild, actor, user, reason, deleteSeconds) {
	const member = await fetchMember(guild, user.id);
	checkTarget(guild, actor, user, member, 'softban');
	if (await isBanned(guild, user.id)) {
		throw new Error(`${user} is already banned, so a softban would unban them. Use \`/mod unban\` if that's what you want.`);
	}

	const dmSent = member ? await notify(user, `You were removed from **${guild.name}** and your recent messages were deleted. You can rejoin.${reasonLine(reason)}`) : false;
	await guild.bans.create(user.id, { deleteMessageSeconds: deleteSeconds, reason: auditReason(reason, actor) });
	await guild.bans.remove(user.id, `${auditReason(reason, actor)} (softban — unbanning so they can rejoin)`.slice(0, MAX_AUDIT_REASON_LENGTH));
	const caseId = recordCase(guild, user.id, actor, 'softban', reason);

	await report(guild, { title: '🧹 Member softbanned', user, actor, reason, caseId, fields: [{ name: 'DM', value: dmSent ? 'Sent' : "Couldn't be delivered", inline: true }] });
	return `Softbanned ${user} (case #${caseId}): their recent messages were deleted and they can rejoin.${member && !dmSent ? " They couldn't be DMed." : ''}`;
}

async function unban(guild, actor, userId, reason) {
	if (!guild.members.me.permissions.has(PermissionFlagsBits.BanMembers)) {
		throw new Error('I need the **Ban Members** permission to unban anyone. Add it to my PariahBot role in Server Settings → Roles.');
	}
	// The ID comes from a free-typed string option, but bans.fetch only ever
	// looks inside this guild's own ban list.
	const entry = await guild.bans.fetch({ user: userId, force: true }).catch((error) => {
		if (error.code === RESTJSONErrorCodes.UnknownBan || error.code === RESTJSONErrorCodes.UnknownUser) return null;
		throw error;
	});
	if (!entry) throw new Error("That user isn't banned here — pick someone from the suggestions.");

	await guild.bans.remove(userId, auditReason(reason, actor));
	const hadTempBan = tempBanStore.removeTempBan(guild.id, userId);
	const caseId = recordCase(guild, userId, actor, 'unban', reason);

	await report(guild, { title: '🔓 Member unbanned', user: entry.user, actor, reason, caseId, fields: hadTempBan ? [{ name: 'Note', value: 'Their temporary ban was cancelled.' }] : [] });
	return `Unbanned ${entry.user} (case #${caseId}).${hadTempBan ? ' Their temporary ban was cancelled.' : ''}`;
}

async function timeout(guild, actor, user, reason, durationSeconds) {
	if (durationSeconds > MAX_TIMEOUT_SECONDS) {
		throw new Error(`Discord allows a timeout of at most ${formatDuration(MAX_TIMEOUT_SECONDS)}. For longer, use a temporary ban.`);
	}
	const member = await fetchMember(guild, user.id);
	checkTarget(guild, actor, user, member, 'timeout');

	const until = Math.floor((Date.now() + (durationSeconds * 1000)) / 1000);
	await member.timeout(durationSeconds * 1000, auditReason(reason, actor));
	const dmSent = await notify(user, `You were timed out in **${guild.name}** until <t:${until}:F>.${reasonLine(reason)}`);
	const caseId = recordCase(guild, user.id, actor, 'timeout', reason, durationSeconds);

	await report(guild, { title: '🔇 Member timed out', user, actor, reason, caseId, fields: [{ name: 'Length', value: `${formatDuration(durationSeconds)} (until <t:${until}:F>)`, inline: true }] });
	return `Timed out ${user} for ${formatDuration(durationSeconds)} (case #${caseId}).${dmSent ? '' : " They couldn't be DMed."}`;
}

async function untimeout(guild, actor, user, reason) {
	const member = await fetchMember(guild, user.id);
	checkTarget(guild, actor, user, member, 'untimeout');
	if (!member.isCommunicationDisabled()) throw new Error(`${member} isn't timed out.`);

	await member.timeout(null, auditReason(reason, actor));
	const caseId = recordCase(guild, user.id, actor, 'untimeout', reason);
	await report(guild, { title: '🔊 Timeout removed', user, actor, reason, caseId });
	return `Removed ${member}'s timeout (case #${caseId}).`;
}

// /mod config escalation: once a member has this many warnings within the
// window, each further warning times them out. It's the bot acting, not the
// moderator who warned, so only the bot's own ability is checked here — the
// warning itself already passed checkTarget, which refuses admins and mods.
async function escalate(guild, user, member, escalation, warningCount) {
	const reason = `Automatic: ${warningCount} warnings within ${formatDuration(escalation.windowSeconds)}`;

	if (!guild.members.me.permissions.has(PermissionFlagsBits.ModerateMembers) || !member.moderatable) {
		await report(guild, {
			title: '⚠️ Automatic timeout failed',
			user,
			actor: null,
			reason,
			fields: [{ name: 'Fix', value: 'I need **Timeout Members**, and my PariahBot role above theirs, in Server Settings → Roles.' }],
		});
		return ` That's ${warningCount} warnings within ${formatDuration(escalation.windowSeconds)}, but I couldn't time them out: I need Timeout Members and my role above theirs.`;
	}

	const until = Math.floor((Date.now() + (escalation.timeoutSeconds * 1000)) / 1000);
	await member.timeout(escalation.timeoutSeconds * 1000, `${reason} — by PariahBot`.slice(0, MAX_AUDIT_REASON_LENGTH));
	await notify(user, `You were timed out in **${guild.name}** until <t:${until}:F> for reaching ${warningCount} warnings.`);
	const caseId = recordCase(guild, user.id, null, 'timeout', reason, escalation.timeoutSeconds);

	await report(guild, { title: '🔇 Member timed out automatically', user, actor: null, reason, caseId, fields: [{ name: 'Length', value: `${formatDuration(escalation.timeoutSeconds)} (until <t:${until}:F>)`, inline: true }] });
	return ` That's ${warningCount} warnings within ${formatDuration(escalation.windowSeconds)}, so they were also timed out for ${formatDuration(escalation.timeoutSeconds)} (case #${caseId}).`;
}

async function warn(guild, actor, user, reason) {
	const member = await fetchMember(guild, user.id);
	checkTarget(guild, actor, user, member, 'warn');

	const caseId = recordCase(guild, user.id, actor, 'warn', reason);
	const total = caseStore.countCasesByAction(guild.id, user.id).warn ?? 0;
	const dmSent = await notify(user, `You were warned in **${guild.name}**.${reasonLine(reason)}`);

	const { warnEscalation } = guildSettings.getGuildSettings(guild.id);
	const recent = warnEscalation
		? caseStore.countWarningsSince(guild.id, user.id, new Date(Date.now() - (warnEscalation.windowSeconds * 1000)).toISOString())
		: null;

	const fields = [{ name: 'Warnings', value: warnEscalation ? `${recent} in the last ${formatDuration(warnEscalation.windowSeconds)} (${total} in total)` : `${total} in total`, inline: true }];
	await report(guild, { title: '⚠️ Member warned', user, actor, reason, caseId, fields });

	let summary = `Warned ${user} (case #${caseId}). That's ${total} warning${total === 1 ? '' : 's'} in total.${dmSent ? '' : " They couldn't be DMed."}`;
	if (warnEscalation && recent >= warnEscalation.count) {
		summary += await escalate(guild, user, member, warnEscalation, recent);
	}
	return summary;
}

// Deletes a case record — not the action it describes — and reports who did,
// so the removal is itself on the record. removedBy is shown in the alert (a
// member, or a dashboard user's name). Shared by /mod remove-case and the admin
// dashboard. Returns a summary.
async function removeCaseRecord(guild, caseId, removedBy) {
	const entry = caseStore.getCase(guild.id, caseId);
	if (!entry) throw new Error(`There's no case #${caseId} in this server. Find case numbers with \`/mod history\`.`);

	caseStore.removeCase(guild.id, caseId);
	const label = CASE_LABELS[entry.action] ?? entry.action;
	const embed = new EmbedBuilder()
		.setColor(ALERT_COLOR)
		.setTitle(`🗑️ Case #${caseId} removed`)
		.setDescription(`${label} against <@${entry.userId}>, from <t:${Math.floor(Date.parse(entry.createdAt) / 1000)}:d>.${entry.reason ? `\n> ${entry.reason}` : ''}`)
		.addFields({ name: 'Removed by', value: removedBy, inline: true })
		.setTimestamp();
	await sendAlert(guild, { embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);

	return `Removed case #${caseId} (${label} against <@${entry.userId}>). This only deletes the record${entry.action === 'warn' ? ', so it no longer counts towards an automatic timeout' : ' — the action itself still stands'}.`;
}

// --- Temporary bans ---------------------------------------------------------

// Re-checks the stored row when it fires: a /mod unban, a permanent ban, or
// a newer temporary ban since this timer was set all change or remove it,
// and then this timer simply does nothing.
async function expireTempBan(client, scheduled) {
	const current = tempBanStore.getTempBan(scheduled.guildId, scheduled.userId);
	if (!current || current.unbanAt !== scheduled.unbanAt) return;

	const guild = client.guilds.cache.get(current.guildId);
	if (!guild) {
		// The bot left that server; there's nothing it can unban any more.
		tempBanStore.removeTempBan(current.guildId, current.userId);
		return;
	}

	let failure = null;
	let alreadyLifted = false;
	await guild.bans.remove(current.userId, `Temporary ban ended (set by ${current.bannedBy})`).catch((error) => {
		// Unbanned by hand in Server Settings already: nothing left to do, and
		// nothing worth an alert — the moderator who lifted it knows.
		if (error.code === RESTJSONErrorCodes.UnknownBan) alreadyLifted = true;
		else failure = error.message;
	});
	if (failure) {
		// Kept, so the next restart tries again rather than leaving them
		// banned forever.
		console.error(`Moderation: couldn't lift temporary ban of ${current.userId} in guild ${guild.id}:`, failure);
		const user = await client.users.fetch(current.userId).catch(() => ({ id: current.userId, toString: () => `<@${current.userId}>`, username: current.userId }));
		await report(guild, { title: '⚠️ Temporary ban could not be lifted', user, actor: null, reason: current.reason, fields: [{ name: 'Error', value: failure.slice(0, 1024) }, { name: 'Fix', value: 'Unban them by hand in Server Settings → Bans, or give me Ban Members. I retry at my next restart.' }] });
		return;
	}

	tempBanStore.removeTempBan(current.guildId, current.userId);
	if (alreadyLifted) return;
	const caseId = recordCase(guild, current.userId, null, 'unban', 'Temporary ban ended');
	const user = await client.users.fetch(current.userId).catch(() => ({ id: current.userId, toString: () => `<@${current.userId}>`, username: current.userId }));
	await report(guild, { title: '⌛ Temporary ban ended', user, actor: null, reason: current.reason, caseId, fields: [{ name: 'Banned by', value: `<@${current.bannedBy}>`, inline: true }] });
}

// The timer is only the reminder; the row in temp_bans is what persists, and
// scheduleAllTempBans rebuilds every timer from it at startup.
function scheduleUnban(client, tempBan) {
	const delay = Math.max(0, Date.parse(tempBan.unbanAt) - Date.now());
	if (delay > MAX_TIMER_MS) {
		setTimeout(() => scheduleUnban(client, tempBan), MAX_TIMER_MS);
		return;
	}
	setTimeout(() => {
		expireTempBan(client, tempBan).catch((error) => {
			console.error(`Moderation: temporary ban expiry failed for ${tempBan.userId} in guild ${tempBan.guildId}:`, error.message);
		});
	}, delay);
}

// Called once from events/ready.js. Bans that ran out while the bot was
// offline are lifted straight away.
function scheduleAllTempBans(client) {
	for (const tempBan of tempBanStore.listTempBans()) scheduleUnban(client, tempBan);
}

// --- Right-click actions ----------------------------------------------------

const MODAL_PREFIX = 'mod:';

function reasonInput() {
	return new TextInputBuilder()
		.setCustomId('reason')
		.setLabel('Reason (shown to them and in the audit log)')
		.setStyle(TextInputStyle.Paragraph)
		.setMaxLength(MAX_REASON_LENGTH)
		.setRequired(false);
}

function durationInput(required, placeholder) {
	return new TextInputBuilder()
		.setCustomId('duration')
		.setLabel('Duration')
		.setPlaceholder(placeholder)
		.setStyle(TextInputStyle.Short)
		.setMaxLength(20)
		.setRequired(required);
}

const MODAL_TITLES = { kick: 'Kick', ban: 'Ban', timeout: 'Time out' };

// Checks run here too, before the form opens, so a moderator isn't asked
// for a reason for something that can't happen. They run again on submit.
async function openActionModal(interaction, action) {
	requireMod(interaction);
	const user = interaction.targetUser;
	checkTarget(interaction.guild, interaction.member, user, interaction.targetMember ?? await fetchMember(interaction.guild, user.id), action);

	const modal = new ModalBuilder()
		.setCustomId(`${MODAL_PREFIX}${action}:${user.id}`)
		.setTitle(`${MODAL_TITLES[action]} ${user.username}`.slice(0, 45));
	const inputs = [reasonInput()];
	if (action === 'timeout') inputs.push(durationInput(true, 'e.g. 10m, 1h, 1d (max 28d)'));
	if (action === 'ban') inputs.push(durationInput(false, 'Leave empty for permanent, or e.g. 7d'));
	modal.addComponents(...inputs.map((input) => new ActionRowBuilder().addComponents(input)));

	await interaction.showModal(modal);
}

// Returns false for any modal that isn't ours, like the component handlers in
// events/interactionCreate.js. The target ID comes from our own custom ID, but
// every check runs again here against the guild the form was submitted in.
async function handleModerationModal(interaction) {
	if (!interaction.customId.startsWith(MODAL_PREFIX)) return false;
	const [, action, userId] = interaction.customId.split(':');
	if (!MODAL_TITLES[action]) return false;

	requireMod(interaction);
	await interaction.deferReply({ ephemeral: true });

	const user = await interaction.client.users.fetch(userId);
	const reason = interaction.fields.getTextInputValue('reason').trim() || null;
	const rawDuration = action === 'kick' ? '' : interaction.fields.getTextInputValue('duration').trim();

	let summary;
	if (action === 'kick') summary = await kick(interaction.guild, interaction.member, user, reason);
	if (action === 'ban') summary = await ban(interaction.guild, interaction.member, user, reason, { durationSeconds: rawDuration ? parseDuration(rawDuration) : null });
	if (action === 'timeout') summary = await timeout(interaction.guild, interaction.member, user, reason, parseDuration(rawDuration));

	await interaction.editReply({ content: summary });
	return true;
}

module.exports = {
	CASE_LABELS,
	DELETE_MESSAGE_CHOICES,
	MAX_REASON_LENGTH,
	MAX_TIMEOUT_SECONDS,
	MIN_ESCALATION_WARNINGS,
	MAX_ESCALATION_WARNINGS,
	parseEscalation,
	recordCase,
	removeCaseRecord,
	warn,
	kick,
	ban,
	softban,
	unban,
	timeout,
	untimeout,
	scheduleAllTempBans,
	openActionModal,
	handleModerationModal,
};
