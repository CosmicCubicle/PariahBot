const guildSettings = require('../state/guildSettings');

// "Only admins and the bot can post" relies on Discord's own Administrator
// permission bypassing channel overwrites entirely — an explicit deny here
// only ever affects non-Administrator members. See the role-assignment plan
// for why a broader mod-role allowance isn't wired in yet.
async function applyChannelDefaults(channel, guildId) {
	const { memberRoleId } = guildSettings.getGuildSettings(guildId);
	const everyoneId = channel.guild.roles.everyone.id;
	const targetRoleId = memberRoleId ?? everyoneId;
	const botId = channel.client.user.id;
	const reason = 'Apply Role Assignment Channel Defaults';

	if (targetRoleId === everyoneId) {
		await channel.permissionOverwrites.edit(everyoneId, { ViewChannel: true, SendMessages: false }, { reason });
	} else {
		await channel.permissionOverwrites.edit(everyoneId, { ViewChannel: false }, { reason });
		await channel.permissionOverwrites.edit(targetRoleId, { ViewChannel: true, SendMessages: false }, { reason });
	}

	await channel.permissionOverwrites.edit(botId, { ViewChannel: true, SendMessages: true }, { reason });

	return targetRoleId;
}

module.exports = { applyChannelDefaults };
