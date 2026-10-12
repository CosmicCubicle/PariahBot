require('dotenv').config({ path: 'hom.env' });
const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, Events, GatewayCloseCodes, Partials } = require('discord.js');
const { gatewayIntents, messageContentEnabled, disallowedIntentsHelp } = require('./lib/intents');
const serverLog = require('./lib/serverLog');

// What each intent is for is listed in lib/intents.js.
const client = new Client({
	intents: gatewayIntents(),
	// Without these, discord.js drops the event unless the member or message
	// happens to be cached: a member who left without the bot having seen them
	// since it started, or the edit or deletion of an older message, would never
	// reach the server log. Handlers that get one check .partial.
	partials: [Partials.GuildMember, Partials.Message],
	// Only with message text switched on (SERVER_LOG_MESSAGE_CONTENT): the cache
	// discord.js already keeps of recent messages is what lets the server log show
	// a deleted message's text, or an edit's "before". Bounded by age, and emptied
	// of servers not logging messages. See WorkingAgreements.md § 1.
	...(messageContentEnabled() ? { sweepers: serverLog.messageCacheSweepers() } : {}),
});

client.commands = new Collection();

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.js'));

for (const file of commandFiles) {
	const command = require(path.join(commandsPath, file));
	client.commands.set(command.data.name, command);
}

const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter((file) => file.endsWith('.js'));

for (const file of eventFiles) {
	const event = require(path.join(eventsPath, file));
	if (event.once) {
		client.once(event.name, (...args) => event.execute(...args, client));
	} else {
		client.on(event.name, (...args) => event.execute(...args, client));
	}
}

// Discord refusing a privileged intent the Developer Portal hasn't allowed
// otherwise shows up only as a disconnect, with the bot sitting there offline.
// Say what to change, and exit, so systemd or Docker reports it as failed.
client.on(Events.ShardDisconnect, (event) => {
	if (event.code !== GatewayCloseCodes.DisallowedIntents) return;
	console.error(disallowedIntentsHelp());
	process.exit(1);
});

client.login(process.env.DISCORD_TOKEN);
