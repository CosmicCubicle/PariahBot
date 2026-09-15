const { PermissionFlagsBits } = require('discord.js');
const guildSettings = require('../state/guildSettings');

// A "mod" for voice-ownership overrides (currently just /vc claim) is anyone
// with Manage Channels — guild admins already run the hub-management side of
// /voice — or anyone holding any of the guild's configured mod roles (see
// /setup mod-role). Checked live off the member's current roles/permissions
// rather than stored per-channel, so a role change takes effect immediately
// everywhere this is checked, and a member who loses mod status stops
// benefiting from (or being protected by) it right away.
function isMod(member, guildId) {
	if (member.permissions.has(PermissionFlagsBits.ManageChannels)) return true;

	return guildSettings.listModRoles(guildId).some((roleId) => member.roles.cache.has(roleId));
}

// Gate for the bot's administrative commands (/voice, /roles, /setup, /alerts):
// real Discord Administrator permission, or membership in any of the guild's
// configured mod roles (see /setup mod-role) — deliberately narrower than
// isMod above, which also accepts plain Manage Channels for the unrelated
// /vc claim override.
function isAdmin(member, guildId) {
	if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;

	return guildSettings.listModRoles(guildId).some((roleId) => member.roles.cache.has(roleId));
}

function requireAdmin(interaction) {
	if (!isAdmin(interaction.member, interaction.guildId)) {
		throw new Error('You need Administrator permission or a mod role to use this command.');
	}
}

module.exports = { isMod, isAdmin, requireAdmin };
