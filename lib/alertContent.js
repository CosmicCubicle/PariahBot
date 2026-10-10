// The text line posted above an alert embed: the ping role, optionally inside
// an admin's custom message. Shared by stream alerts and Instagram alerts so
// both fill in placeholders and place the ping the same way.
//
// Only the configured role is ever pinged — the callers pass allowedMentions
// with that role alone — so @everyone, @here or a user mention typed into a
// custom message shows as text but notifies nobody.

// Discord's limit for a message's text.
const MAX_CONTENT_LENGTH = 2000;

// The longest custom message an admin can set. Leaves room for long
// placeholder values (a stream title, a caption) within MAX_CONTENT_LENGTH.
const MAX_TEMPLATE_LENGTH = 1000;

const PLACEHOLDER_PATTERN = /\{(\w+)\}/g;

// {role} is handled here rather than by the caller, since it's what decides
// where the ping goes.
const ROLE_PLACEHOLDER = 'role';

// Returns the message text, or undefined when there's nothing to say (no
// custom message and no ping role). The ping goes where {role} appears, or at
// the start when the message doesn't use it.
//
// Placeholders are filled in one pass, so a stream title that happens to
// contain "{role}" is posted as written, never expanded into a ping.
function renderAlertContent(template, values, pingRoleId) {
	const ping = pingRoleId ? `<@&${pingRoleId}>` : '';
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

module.exports = { MAX_TEMPLATE_LENGTH, ROLE_PLACEHOLDER, renderAlertContent, unknownPlaceholders };
