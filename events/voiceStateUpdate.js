const { Events, ChannelType, PermissionFlagsBits } = require('discord.js');
const voiceStore = require('../state/voiceChannels');
const { cleanupIfEmpty, reconcileTempChannels } = require('../lib/tempChannelCleanup');

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
				//
				// Connect is included explicitly for a non-obvious reason: the owner is
				// moved into this channel by the bot (via MoveMembers), never exercising
				// their own Connect, so without an explicit grant they only ever had
				// @everyone's. /vc lock denies @everyone's Connect, and Discord gates
				// using a slash command inside a voice channel's own chat on currently
				// holding Connect there — so without this, locking a channel would strip
				// the owner's ability to run any further /vc command in it, including
				// /vc unlock itself. See lib/vcScope.js's same-channel-chat requirement.
				id: member.id,
				allow: [
					PermissionFlagsBits.ManageChannels,
					PermissionFlagsBits.MoveMembers,
					PermissionFlagsBits.Connect,
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
				// Opportunistic, cache-only, guild-scoped: catches drift the bot missed
				// while offline or during a brief gateway resume, right when someone's
				// actually using the hub — no timer needed. See Stage 1 checkpoint 5b.
				try {
					await reconcileTempChannels(newState.guild);
				} catch (error) {
					console.error(`Failed to reconcile temp channels for guild ${newState.guild.id}:`, error.message);
				}

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
