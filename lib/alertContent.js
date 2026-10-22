// The text line posted above an alert embed: the ping roles, optionally inside
// an admin's custom message. Shared by stream, Instagram and RSS alerts so all
// of them fill in placeholders and place the ping the same way.
//
// Only the configured roles are ever pinged — the callers pass allowedMentions
// from pingMentions() below — so @everyone, @here or a user mention typed into
// a custom message shows as text but notifies nobody.

const { PermissionFlagsBits } = require('discord.js');

// Discord's limit for a message's text.
const MAX_CONTENT_LENGTH = 2000;

// The longest custom message an admin can set. Leaves room for long
// placeholder values (a stream title, a caption) within MAX_CONTENT_LENGTH.
const MAX_TEMPLATE_LENGTH = 1000;

const PLACEHOLDER_PATTERN = /\{(\w+)\}/g;

// {role} is handled here rather than by the caller, since it's what decides
// where the ping goes.
const ROLE_PLACEHOLDER = 'role';

// Stream alerts ping a list of roles (#98); Instagram and RSS ping one or
// none. Either shape is accepted, so those callers pass their single ID as is.
function toRoleIds(pingRoleIds) {
	return [pingRoleIds].flat().filter(Boolean);
}

// The allowedMentions for an alert: its ping roles and nothing else.
function pingMentions(pingRoleIds) {
	return { parse: [], roles: toRoleIds(pingRoleIds) };
}

// Returns the message text, or undefined when there's nothing to say (no
// custom message and no ping role). The ping, every role together, goes where
// {role} appears, or at the start when the message doesn't use it.
//
// Placeholders are filled in one pass, so a stream title that happens to
// contain "{role}" is posted as written, never expanded into a ping.
function renderAlertContent(template, values, pingRoleIds) {
	const ping = toRoleIds(pingRoleIds).map((id) => `<@&${id}>`).join(' ');
	if (!template) return ping || undefined;

	let placedPing = false;
	const text = template.replace(PLACEHOLDER_PATTERN, (match, key) => {
		if (key === ROLE_PLACEHOLDER) {
			placedPing = true;
			return ping;
		}
		return Object.hasOwn(values, key) ? String(values[key] ?? '') : match;
	});

	const content = (placedPing || !ping ? text : `${ping} ${text}`).trim();
	if (!content) return undefined;
	return content.length > MAX_CONTENT_LENGTH ? `${content.slice(0, MAX_CONTENT_LENGTH - 1)}…` : content;
}

// The placeholders in a template that the feature doesn't fill in, so the
// command can warn the admin about a typo like {titel} before it's posted.
function unknownPlaceholders(template, known) {
	const allowed = new Set([...known, ROLE_PLACEHOLDER]);
	return [...new Set([...template.matchAll(PLACEHOLDER_PATTERN)].map(([match, key]) => (allowed.has(key) ? null : match)).filter(Boolean))];
}

// Whether pinging this role in `channel` notifies anyone: the role is
// mentionable, or the bot has Mention @everyone, @here, and All Roles there,
// server-wide or through the channel's own override (#102). Without a
// channel, only the server-wide permission counts.
function pingWillNotify(role, channel) {
	if (role.mentionable) return true;
	const me = role.guild.members.me;
	return (channel ? channel.permissionsFor(me) : me.permissions).has(PermissionFlagsBits.MentionEveryone);
}

// The warning for a ping role that won't notify anyone, or null. `name` is
// how to show the role: a mention in Discord, @name on the dashboard.
function unmentionableWarning(role, channel, name = `${role}`) {
	if (pingWillNotify(role, channel)) return null;
	const where = channel ? ` in #${channel.name}` : '';
	return `${name} isn't mentionable, so the ping won't notify anyone. Turn on "Allow anyone to @mention this role" in its settings, or give the bot Mention @everyone, @here, and All Roles${where}. Only the ping roles are ever pinged, never @everyone.`;
}

module.exports = { MAX_TEMPLATE_LENGTH, ROLE_PLACEHOLDER, renderAlertContent, pingMentions, pingWillNotify, unmentionableWarning, unknownPlaceholders };
