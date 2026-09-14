const { Events, ChannelType, PermissionFlagsBits } = require('discord.js');
const voiceStore = require('../state/voiceChannels');

function buildChannelName(nameTemplate, member) {
	return nameTemplate.replace('{owner}', member.displayName).slice(0, 100);
}

async function createTempChannel(member, hub, hubChannel) {
	const guild = member.guild;
	const categoryId = hub.categoryId ?? hubChannel.parentId ?? null;
	const category = categoryId ? guild.channels.cache.get(categoryId) : null;

	// Channel creation via the API doesn't inherit a category's permission
	// overwrites the way dragging a channel into one does in the Discord client,
	// so they're copied explicitly before layering on the owner's extra controls.
	const categoryOverwrites = category
		? category.permissionOverwrites.cache.map((overwrite) => ({
			id: overwrite.id,
			type: overwrite.type,
			allow: overwrite.allow,
			deny: overwrite.deny,
		}))
		: [];

	const tempChannel = await guild.channels.create({
		name: buildChannelName(hub.nameTemplate, member),
		type: ChannelType.GuildVoice,
		parent: categoryId ?? undefined,
		userLimit: hub.defaultLimit,
		permissionOverwrites: [
			...categoryOverwrites,
			{
				// Only permissions the bot itself actually holds — Discord rejects the
				// whole channel creation if an overwrite tries to grant one it doesn't.
				// Mute/Deafen Members deliberately excluded: nothing planned for owners
				// needs them (kick uses disconnect, ban uses a Connect-deny overwrite),
				// and moderation heavier than that should involve a mod, not be pure
				// owner self-service (see pariahbot-temp-voice-channels memory).
				id: member.id,
				allow: [
					PermissionFlagsBits.ManageChannels,
					PermissionFlagsBits.MoveMembers,
				],
			},
		],
	});

	voiceStore.createTempChannel({
		channelId: tempChannel.id,
		guildId: guild.id,
		hubChannelId: hub.channelId,
		ownerId: member.id,
		minLimit: hub.minLimit,
		maxLimit: hub.maxLimit,
	});

	try {
		await member.voice.setChannel(tempChannel);
	} catch (error) {
		console.error(`Failed to move ${member.user.tag} into temp channel ${tempChannel.id}:`, error.message);
	}
}

async function cleanupIfEmpty(channel) {
	if (!channel || !voiceStore.isTempChannel(channel.id)) return;
	if (channel.members.size > 0) return;

	// Unregister first: the database write is local and effectively can't fail,
	// while the Discord API call below can (already deleted, rate limit) — so the
	// channel is reliably gone from our tracking either way. Same ordering as
	// /voice setup remove, for the same reason.
	voiceStore.removeTempChannel(channel.id);
	try {
		await channel.delete('Temporary voice channel emptied.');
	} catch (error) {
		// 10003 = Unknown Channel — already gone (e.g. deleted manually), nothing to do.
		if (error.code !== 10003) console.error(`Failed to delete empty temp channel ${channel.id}:`, error.message);
	}
}

module.exports = {
	name: Events.VoiceStateUpdate,
	async execute(oldState, newState) {
		const changedChannel = oldState.channelId !== newState.channelId;

		// Both checks run independently, unconditionally on each other: moving
		// directly from an existing temp channel into a hub is a single event that
		// needs to both clean up the one they left and create the one they joined.
		if (changedChannel && newState.channelId && newState.member) {
			const hub = voiceStore.getHub(newState.channelId);
			if (hub) {
				try {
					await createTempChannel(newState.member, hub, newState.channel);
				} catch (error) {
					console.error(`Failed to create temp voice channel for ${newState.member.user.tag}:`, error.message);
				}
			}
		}

		if (changedChannel && oldState.channelId) {
			try {
				await cleanupIfEmpty(oldState.channel);
			} catch (error) {
				console.error(`Failed to clean up channel ${oldState.channelId}:`, error.message);
			}
		}
	},
};
