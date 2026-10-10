const { isAdmin } = require('../permissions');

// Who can manage which server in the admin dashboard.
//
// - The bot's owner (the application's owner, or its team members) can manage
//   every server, and is the only one who sees the Status page.
// - Anyone else can manage exactly the servers where they're an admin by the
//   bot's own rule, isAdmin — Administrator, or an admin role from
//   /setup admin-role — the same check the admin-only slash commands use.
//   Mods (mod roles) don't get the dashboard: it reaches /setup, /security
//   and the policy settings, which are admin-only.
//
// Checked live on every request (CodeStandards.md § 8), with the member
// fetched fresh from Discord rather than read from the cache: without the
// privileged Guild Members intent the bot isn't told when someone's roles
// change, so a cached member can be out of date. Taking away someone's admin
// role ends their dashboard access to that server straight away.

async function fetchFreshMember(guild, userId) {
	return guild.members.fetch({ user: userId, force: true }).catch(() => null);
}

async function canManage(user, guild) {
	if (user.isOwner) return true;
	const member = await fetchFreshMember(guild, user.id);
	return Boolean(member && isAdmin(member, guild.id));
}

// Every server this user may manage, alphabetical.
async function manageableGuilds(client, user) {
	const guilds = [...client.guilds.cache.values()].sort((a, b) => a.name.localeCompare(b.name));
	if (user.isOwner) return guilds;
	const allowed = [];
	for (const guild of guilds) {
		if (await canManage(user, guild)) allowed.push(guild);
	}
	return allowed;
}

module.exports = { canManage, manageableGuilds };
