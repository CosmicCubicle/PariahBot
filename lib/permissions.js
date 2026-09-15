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

module.exports = { isMod };
