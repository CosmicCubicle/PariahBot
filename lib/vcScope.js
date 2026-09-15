const voiceStore = require('../state/voiceChannels');

// Every /vc subcommand is scoped the same way: caller must currently be
// connected to a tracked temp channel, and must run the command inside that
// channel's own chat (voice channels carry their own text chat now) rather
// than from anywhere else in the server. Centralized here so that scoping
// rule only has one place to change, instead of seven near-identical checks.
function resolveCallerChannel(interaction) {
	const voiceChannel = interaction.member?.voice?.channel;
	if (!voiceChannel) {
		throw new Error('You need to be connected to a temporary voice channel to use this.');
	}

	if (interaction.channelId !== voiceChannel.id) {
		throw new Error(`Run this in ${voiceChannel}'s own chat — that's where its owner controls live.`);
	}

	const record = voiceStore.getTempChannel(voiceChannel.id);
	if (!record) {
		throw new Error("The voice channel you're in isn't a temporary channel managed by PariahBot.");
	}

	return { channel: voiceChannel, record };
}

function requireOwner(interaction, record) {
	if (record.ownerId !== interaction.user.id) {
		throw new Error('Only the channel owner can do that.');
	}
}

module.exports = { resolveCallerChannel, requireOwner };
