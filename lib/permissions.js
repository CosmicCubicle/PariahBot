const { PermissionFlagsBits } = require('discord.js');
const guildSettings = require('../state/guildSettings');

// A "mod" for voice-ownership overrides (currently just /vc claim) is anyone
// with Manage Channels — guild admins already run the hub-management side of
// /voice — or anyone holding the guild's configured mod role, if one's been
// set. Checked live off the member's current roles/permissions rather than
// stored per-channel, so a role change takes effect immediately everywhere
// this is checked, and a member who loses mod status stops benefiting from
// (or being protected by) it right away.
function isMod(member, guildId) {
	if (member.permissions.has(PermissionFlagsBits.ManageChannels)) return true;

	const modRoleId = guildSettings.getModRole(guildId);
	return modRoleId ? member.roles.cache.has(modRoleId) : false;
}

// Gate for the bot's administrative commands (/voice, /roles, /setup, /alerts):
// real Discord Administrator permission, or membership in the guild's
// configured mod role (see /setup mod-role) — deliberately narrower than
// isMod above, which also accepts plain Manage Channels for the unrelated
// /vc claim override.
function isAdmin(member, guildId) {
	if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;

	const modRoleId = guildSettings.getModRole(guildId);
	return modRoleId ? member.roles.cache.has(modRoleId) : false;
}

function requireAdmin(interaction) {
	if (!isAdmin(interaction.member, interaction.guildId)) {
		throw new Error('You need Administrator permission or the mod role to use this command.');
	}
}

module.exports = { isMod, isAdmin, requireAdmin };
