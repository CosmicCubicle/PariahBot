const { PermissionFlagsBits } = require('discord.js');
const voiceStore = require('../state/voiceChannels');
const guildSettings = require('../state/guildSettings');

// Live temporary voice channels: who owns them, handing them over, closing
// them, and which /vc controls their owners may use. Shared by /vc and the
// admin dashboard.

// The /vc owner controls an admin can switch off, by key. /vc claim isn't
// here on purpose: it's what lets an abandoned channel be taken over, so it
// stays on.
const OWNER_CONTROLS = {
	name: { label: 'Rename', command: '/vc name' },
	limit: { label: 'User limit', command: '/vc limit' },
	lock: { label: 'Lock and unlock', command: '/vc lock and /vc unlock' },
	kick: { label: 'Kick', command: '/vc kick' },
	transfer: { label: 'Transfer ownership', command: '/vc transfer' },
};

function requireOwnerControl(guildId, control) {
	if (!guildSettings.getGuildSettings(guildId).ownerControls[control]) {
		throw new Error(`Server admins have turned off ${OWNER_CONTROLS[control].command} for channel owners.`);
	}
}

// Moves both the channel's permission overwrite (the old owner's grant is
// removed, the new owner gets a fresh one — create() replaces rather than
// merges) and our record of who owns it.
async function transferOwnership(channel, fromId, toId) {
	await channel.permissionOverwrites.delete(fromId).catch(() => null);
	await channel.permissionOverwrites.create(toId, {
		ManageChannels: true,
		MoveMembers: true,
		Connect: true,
	}, { reason: 'Temp channel ownership transferred' });
	voiceStore.setTempChannelOwner(channel.id, toId);
}

function isLocked(channel) {
	return Boolean(channel.permissionOverwrites.cache.get(channel.guild.id)?.deny.has(PermissionFlagsBits.Connect));
}

// Everything about the guild's open temp channels, for the dashboard. A record
// whose channel is gone is skipped; the next cleanup drops it.
function listTempChannels(guild) {
	return voiceStore.listTempChannelsForGuild(guild.id).flatMap((record) => {
		const channel = guild.channels.cache.get(record.channelId);
		if (!channel) return [];
		const owner = guild.members.cache.get(record.ownerId);
		return [{
			channelId: channel.id,
			name: channel.name,
			hubChannelId: record.hubChannelId,
			ownerId: record.ownerId,
			ownerName: owner?.displayName ?? null,
			members: [...channel.members.values()].map((member) => ({ id: member.id, name: member.displayName })),
			userLimit: channel.userLimit,
			locked: isLocked(channel),
			createdAt: record.createdAt,
		}];
	});
}

function requireTempChannel(guild, channelId) {
	const record = voiceStore.getTempChannel(String(channelId));
	const channel = record && record.guildId === guild.id ? guild.channels.cache.get(record.channelId) : null;
	if (!channel) throw new Error("That isn't an open temporary channel in this server.");
	return { record, channel };
}

// Deleting the channel disconnects everyone in it. The record is dropped only
// once the channel is really gone, as in lib/tempChannelCleanup.js.
async function closeTempChannel(guild, channelId, reason) {
	const { channel } = requireTempChannel(guild, channelId);
	const name = channel.name;
	await channel.delete(reason);
	voiceStore.removeTempChannel(channel.id);
	return name;
}

// Admin-side transfer (the dashboard): the new owner has to be in the channel,
// as with /vc transfer.
async function transferTempChannel(guild, channelId, userId) {
	const { record, channel } = requireTempChannel(guild, channelId);
	const member = channel.members.get(String(userId));
	if (!member) throw new Error('The new owner has to be in the channel.');
	if (member.id === record.ownerId) throw new Error('They already own it.');
	await transferOwnership(channel, record.ownerId, member.id);
	return { channel, member };
}

module.exports = {
	OWNER_CONTROLS,
	requireOwnerControl,
	transferOwnership,
	isLocked,
	listTempChannels,
	closeTempChannel,
	transferTempChannel,
};
