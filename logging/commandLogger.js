const fs = require('node:fs');
const path = require('node:path');
const { EmbedBuilder } = require('discord.js');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'commands.log');

const SUCCESS_CHANNEL_ID = process.env.LOG_CHANNEL_SUCCESS_ID || process.env.LOG_CHANNEL_ID || null;
const ERROR_CHANNEL_ID = process.env.LOG_CHANNEL_ERROR_ID || process.env.LOG_CHANNEL_ID || null;

function ensureLogDir() {
	if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function flattenOptions(options) {
	if (!options?.length) return [];
	// Subcommands and subcommand groups nest their real arguments one or two
	// levels deep instead of carrying a value themselves.
	return options.flatMap((option) => (option.options?.length ? flattenOptions(option.options) : [option]));
}

function formatOptions(interaction) {
	const options = flattenOptions(interaction.options?.data);
	if (!options.length) return '';
	return options.map((opt) => `${opt.name}=${opt.value}`).join(', ');
}

function formatCommandName(interaction) {
	const parts = [interaction.commandName];
	const group = interaction.options?.getSubcommandGroup?.(false);
	if (group) parts.push(group);
	const subcommand = interaction.options?.getSubcommand?.(false);
	if (subcommand) parts.push(subcommand);
	return parts.join(' ');
}

function buildEntry(interaction, status, durationMs, error) {
	return {
		timestamp: new Date().toISOString(),
		command: formatCommandName(interaction),
		options: formatOptions(interaction),
		user: `${interaction.user.tag} (${interaction.user.id})`,
		guild: interaction.guild ? `${interaction.guild.name} (${interaction.guild.id})` : 'DM',
		channel: interaction.channel?.name ?? interaction.channelId,
		status,
		durationMs,
		error: error?.message,
	};
}

function toHumanLine(entry) {
	const options = entry.options ? ` (${entry.options})` : '';
	const errorSuffix = entry.error ? ` — error: ${entry.error}` : '';
	return `[${entry.timestamp}] ${entry.status.toUpperCase()} /${entry.command}${options} by ${entry.user} in #${entry.channel} (${entry.guild}) — ${entry.durationMs}ms${errorSuffix}`;
}

function toEmbed(entry) {
	const embed = new EmbedBuilder()
		.setTitle(`/${entry.command}`)
		.setColor(entry.status === 'error' ? 0xed4245 : 0x57f287)
		.addFields(
			{ name: 'Status', value: entry.status.toUpperCase(), inline: true },
			{ name: 'Duration', value: `${entry.durationMs}ms`, inline: true },
			{ name: 'User', value: entry.user, inline: true },
			{ name: 'Location', value: `#${entry.channel} (${entry.guild})` },
		)
		.setTimestamp(new Date(entry.timestamp));

	if (entry.options) embed.addFields({ name: 'Options', value: entry.options });
	if (entry.error) embed.addFields({ name: 'Error', value: entry.error });

	return embed;
}

async function sendToDiscordChannel(client, channelId, entry) {
	if (!channelId || !client) return;
	try {
		const channel = client.channels.cache.get(channelId) ?? (await client.channels.fetch(channelId));
		if (channel?.isTextBased()) {
			await channel.send({ embeds: [toEmbed(entry)] });
		}
	} catch (error) {
		console.error(`Failed to send command log to Discord channel ${channelId}:`, error.message);
	}
}

async function logCommand(entry, client) {
	ensureLogDir();
	fs.appendFileSync(LOG_FILE, `${toHumanLine(entry)}\n`);

	const channelId = entry.status === 'error' ? ERROR_CHANNEL_ID : SUCCESS_CHANNEL_ID;
	await sendToDiscordChannel(client, channelId, entry);
}

module.exports = { logCommand, buildEntry };
