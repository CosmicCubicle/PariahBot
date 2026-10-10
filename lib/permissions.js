const { PermissionFlagsBits } = require('discord.js');
const guildSettings = require('../state/guildSettings');

// PariahBot's three levels, checked live off the member's current roles and
// permissions — never cached — so a role change takes effect straight away
// (CodeStandards.md § 8):
//
//   Admin: Discord's Administrator permission, or any admin role
//          (/setup admin-role). Admin-only: /setup, /security, the admin
//          dashboard, /mod config and remove-case, and /bannedwords' on/off
//          and lists.
//   Mod:   any mod role (/setup mod-role), plus every admin. Everything else
//          that's staff-only.
//   User:  everyone else.
//
// Admins and mods together are "staff": the bot never acts against them
// (WorkingAgreements.md § 3).

function hasAnyRole(member, roleIds) {
	return roleIds.some((roleId) => member.roles.cache.has(roleId));
}

function isAdmin(member, guildId) {
	if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
	return hasAnyRole(member, guildSettings.listAdminRoles(guildId));
}

function isMod(member, guildId) {
	return isAdmin(member, guildId) || hasAnyRole(member, guildSettings.listModRoles(guildId));
}

// /vc claim's override, kept as it was before the admin/mod split: mods, or
// anyone with Manage Channels (who could edit the channel by hand anyway).
function canOverrideVoiceOwner(member, guildId) {
	return member.permissions.has(PermissionFlagsBits.ManageChannels) || isMod(member, guildId);
}

function requireAdmin(interaction) {
	if (!isAdmin(interaction.member, interaction.guildId)) {
		throw new Error("This is for admins: Discord's Administrator permission or an admin role (`/setup admin-role`). Mod roles can't use it.");
	}
}

function requireMod(interaction) {
	if (!isMod(interaction.member, interaction.guildId)) {
		throw new Error("This is for staff: a mod role, an admin role, or Discord's Administrator permission.");
	}
}

// Every role that counts as staff, for places that grant access by role —
// the verification screening channel stays visible to them (lib/captcha.js).
function staffRoleIds(guildId) {
	return [...new Set([...guildSettings.listAdminRoles(guildId), ...guildSettings.listModRoles(guildId)])];
}

module.exports = { isAdmin, isMod, canOverrideVoiceOwner, requireAdmin, requireMod, staffRoleIds };
