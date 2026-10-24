const { GatewayIntentBits } = require('discord.js');

// The gateway intents the bot asks Discord for, and what to tell the host when
// Discord refuses them. Kept out of index.js so the choice is testable.
//
// Three are privileged, so the host has to switch them on in the Developer
// Portal (Bot → Privileged Gateway Intents) or Discord refuses the login.
// Only the first is asked for unconditionally:
//   - GuildMembers, always: the server log's joins and leaves have no other
//     source (#81). This reverses the original no-privileged-intents rule for
//     this one intent; see ProjectContext.md § 5.
//   - MessageContent, only when SERVER_LOG_MESSAGE_CONTENT is on: the text of
//     edited and deleted messages in the server log. Off, the bot never reads
//     what members write.
//   - GuildPresences, only when MEMBER_COUNT_PRESENCE is on: the online and
//     offline member count channels (#90). Opt-in rather than always, because
//     requesting it would refuse the login on every existing install until
//     that host also switched it on — what adding GuildMembers in #81 did. Off,
//     those two counter types are simply unavailable and the command says so.

function messageContentEnabled(env = process.env) {
	return /^(1|true|yes|on)$/i.test(String(env.SERVER_LOG_MESSAGE_CONTENT ?? '').trim());
}

function presenceEnabled(env = process.env) {
	return /^(1|true|yes|on)$/i.test(String(env.MEMBER_COUNT_PRESENCE ?? '').trim());
}

function gatewayIntents(env = process.env) {
	return [
		GatewayIntentBits.Guilds,
		// /voice and /vc: who joins and leaves voice channels.
		GatewayIntentBits.GuildVoiceStates,
		// /autodelete: receiving messageCreate and fetching channel history to
		// seed tracking. Also the server log's message edits and deletes.
		GatewayIntentBits.GuildMessages,
		// /bannedwords: Discord's AutoMod does the blocking, and this event is
		// how the bot hears about each block to report it (lib/bannedWords.js).
		GatewayIntentBits.AutoModerationExecution,
		// Server log: audit log entries (kicks, bans, role and channel changes)
		// and ban events. Not privileged.
		GatewayIntentBits.GuildModeration,
		// Server log: joins and leaves. Privileged.
		GatewayIntentBits.GuildMembers,
		...(messageContentEnabled(env) ? [GatewayIntentBits.MessageContent] : []),
		// /membercount online and offline counters. Privileged, opt-in.
		...(presenceEnabled(env) ? [GatewayIntentBits.GuildPresences] : []),
	];
}

// Printed when Discord closes the connection with 4014 (Disallowed intents),
// which is what every existing install sees after updating until the host
// switches Server Members Intent on.
function disallowedIntentsHelp(env = process.env) {
	const needed = ['Server Members Intent'];
	if (messageContentEnabled(env)) needed.push('Message Content Intent (because SERVER_LOG_MESSAGE_CONTENT is on)');
	if (presenceEnabled(env)) needed.push('Presence Intent (because MEMBER_COUNT_PRESENCE is on)');
	// Discord doesn't say which intent it refused, so this lists every one the
	// bot asked for: whichever is still off is the one to fix.
	return [
		'Discord refused to connect: the bot asked for a privileged intent this application does not allow.',
		'Fix it in the Discord Developer Portal: your application → Bot → Privileged Gateway Intents.',
		'Make sure each of these is switched on (Discord doesn\'t say which one is missing):',
		...needed.map((name) => `  - ${name}`),
		'then Save Changes and restart the bot. See the wiki\'s Bot Setup page.',
	].join('\n');
}

module.exports = { messageContentEnabled, presenceEnabled, gatewayIntents, disallowedIntentsHelp };
