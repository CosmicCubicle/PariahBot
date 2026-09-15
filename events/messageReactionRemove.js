const { Events } = require('discord.js');
const { resolveReactionRoleOption } = require('../lib/roleMenus');

module.exports = {
	name: Events.MessageReactionRemove,
	async execute(reaction, user) {
		if (user.bot) return;

		try {
			if (reaction.partial) await reaction.fetch();
			if (reaction.message.partial) await reaction.message.fetch();
		} catch (error) {
			console.error('Failed to fetch a partial reaction for role assignment:', error.message);
			return;
		}

		const option = resolveReactionRoleOption(reaction);
		if (!option) return;

		const member = await reaction.message.guild.members.fetch(user.id).catch(() => null);
		if (!member || !member.roles.cache.has(option.roleId)) return;

		await member.roles.remove(option.roleId, 'Reaction role removed via PariahBot').catch((error) => {
			console.error(`Failed to remove reaction role ${option.roleId} from ${user.id}:`, error.message);
		});
	},
};
