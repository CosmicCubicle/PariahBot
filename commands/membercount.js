const { SlashCommandBuilder, ChannelType, EmbedBuilder } = require('discord.js');
const counterStore = require('../state/memberCounters');
const { requireAdmin } = require('../lib/permissions');
const features = require('../lib/features');
const counters = require('../lib/memberCounters');

const EMBED_COLOR = 0x5865f2;

// Either adopts a voice channel that already exists, or makes one. Same shape
// as /security's resolveChannel: running the command is the request, and the
// reply always names a channel that was created (WorkingAgreements.md § 7).
async function resolveChannel(interaction, defaultName) {
	const supplied = interaction.options.getChannel('channel');
	const category = interaction.options.getChannel('category');

	if (supplied) {
		if (supplied.type !== ChannelType.GuildVoice) {
			throw new Error('A counter has to be a **voice** channel — members see its name but cannot open it, which is what makes it a label.');
		}
		if (counterStore.getCounter(supplied.id)) {
			throw new Error(`${supplied} is already a counter. Remove it first with \`/membercount remove\`.`);
		}
		return { channel: supplied, created: false };
	}

	counters.requireManageChannels(interaction.guild);
	const channel = await counters.createCounterChannel(interaction.guild, {
		name: defaultName,
		category,
		actor: interaction.user.tag,
	});
	return { channel, created: true };
}

async function handleAdd(interaction) {
	requireAdmin(interaction);
	features.requireEnabled(interaction, 'memberCount');

	const type = interaction.options.getString('type', true);
	const spec = counters.requireAvailableType(type);
	const role = interaction.options.getRole('role');
	const template = interaction.options.getString('template') ?? spec.defaultTemplate;

	if (spec.needsRole && !role) {
		throw new Error('The **Members in a role** counter needs a `role:` to count. Pick one.');
	}
	if (!spec.needsRole && role) {
		throw new Error(`\`role:\` only applies to the **${counters.COUNTER_TYPES.role.label}** counter.`);
	}
	if (!template.includes('{count}')) {
		throw new Error('The template needs `{count}` where the number should go — for example `Members: {count}`.');
	}
	if (counterStore.hasCounter(interaction.guildId, type, role?.id ?? null)) {
		throw new Error(role
			? `There's already a counter for ${role}.`
			: `There's already a **${spec.label}** counter. Remove it first, or change its name with \`/membercount rename\`.`);
	}
	if (counterStore.countForGuild(interaction.guildId) >= counters.MAX_COUNTERS_PER_GUILD) {
		throw new Error(`This server already has ${counters.MAX_COUNTERS_PER_GUILD} counters, which is the limit — each one is a channel that gets renamed on every sweep.`);
	}

	// Creating a channel plus two permission edits plus a rename is more than
	// Discord's three-second window comfortably allows.
	await interaction.deferReply({ ephemeral: true });

	// Fill the member cache first when this type reads it (#105), or the
	// channel gets created showing a count off by most of the server.
	if (spec.needsMemberCache) await counters.ensureMemberCache(interaction.guild);

	const count = counters.countFor(interaction.guild, { type, roleId: role?.id ?? null });
	const firstName = counters.renderName(template, count ?? 0);
	const { channel, created } = await resolveChannel(interaction, firstName);

	try {
		counterStore.addCounter({
			channelId: channel.id,
			guildId: interaction.guildId,
			type,
			roleId: role?.id ?? null,
			nameTemplate: template,
		});
	} catch (error) {
		if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') throw new Error(`${channel} is already a counter.`);
		throw error;
	}

	// Best-effort: a counter that couldn't be locked still counts, it just
	// looks joinable. Worth saying rather than failing the whole command.
	const locked = await counters.lockCounterChannel(channel).then(() => true).catch(() => false);
	await counters.refreshCounter(interaction.client, counterStore.getCounter(channel.id)).catch(() => null);

	const lines = [
		created ? `**I created ${channel}** for this.` : `Using ${channel}.`,
		`It shows **${spec.label}**${role ? ` for ${role}` : ''}, as \`${template}\`.`,
		`Updated every ${counters.REFRESH_INTERVAL_MS / 60000} minutes — Discord rate-limits channel renames, so it can't be live or refreshed by hand.`,
	];
	if (!locked) {
		lines.push('⚠️ I couldn\'t set its permissions, so members may be able to join it. I need **Manage Roles** and **Connect** for that.');
	}

	await interaction.editReply({ content: lines.join('\n') });
}

async function handleRemove(interaction) {
	requireAdmin(interaction);
	features.requireEnabled(interaction, 'memberCount');

	const channel = interaction.options.getChannel('channel', true);
	// The channel itself is left in place: it has whatever name it last had,
	// and deleting someone's channel is not what "remove the counter" means.
	const removed = counterStore.removeCounter(channel.id, interaction.guildId);

	await interaction.reply({
		content: removed
			? `${channel} is no longer a counter. The channel is still there — delete or rename it yourself if you want it gone.`
			: `${channel} isn't a counter in this server.`,
		ephemeral: true,
	});
}

async function handleRename(interaction) {
	requireAdmin(interaction);
	features.requireEnabled(interaction, 'memberCount');

	const channel = interaction.options.getChannel('channel', true);
	const template = interaction.options.getString('template', true);

	if (!template.includes('{count}')) {
		throw new Error('The template needs `{count}` where the number should go — for example `Members: {count}`.');
	}
	if (!counterStore.setTemplate(channel.id, interaction.guildId, template)) {
		throw new Error(`${channel} isn't a counter in this server.`);
	}

	await interaction.deferReply({ ephemeral: true });

	// Re-renders straight away, so it needs the member cache filled for the
	// types that read it (#105).
	const counter = counterStore.getCounter(channel.id);
	if (counters.needsMemberCache([counter])) await counters.ensureMemberCache(interaction.guild);
	await counters.refreshCounter(interaction.client, counter).catch(() => null);

	await interaction.editReply({ content: `${channel} now shows \`${template}\`.` });
}

async function handleList(interaction) {
	requireAdmin(interaction);

	const rows = counterStore.listForGuild(interaction.guildId);

	// Shows live values, so it needs the same member cache the counters do
	// (#105) — otherwise this reports the undercount back as confirmation.
	if (counters.needsMemberCache(rows)) {
		await interaction.deferReply({ ephemeral: true });
		await counters.ensureMemberCache(interaction.guild);
	}
	const lines = rows.map((counter) => {
		const spec = counters.COUNTER_TYPES[counter.type];
		const label = spec?.label ?? counter.type;
		const forRole = counter.roleId ? ` (<@&${counter.roleId}>)` : '';
		const count = counters.countFor(interaction.guild, counter);
		const value = count === null ? '— unavailable' : count.toLocaleString('en-US');
		return `<#${counter.channelId}> — **${label}**${forRole}: ${value}\n \`${counter.nameTemplate}\``;
	});

	const embed = new EmbedBuilder()
		.setTitle('Member count channels')
		.setColor(EMBED_COLOR)
		.setDescription(lines.join('\n') || 'None yet — add one with `/membercount add`.')
		.setFooter({ text: `Updated every ${counters.REFRESH_INTERVAL_MS / 60000} minutes. ${rows.length}/${counters.MAX_COUNTERS_PER_GUILD} used.` });

	// Deferred above only when the member cache had to be fetched, so both
	// paths are possible here.
	if (interaction.deferred) await interaction.editReply({ embeds: [embed] });
	else await interaction.reply({ embeds: [embed], ephemeral: true });
}

const HANDLERS = { add: handleAdd, remove: handleRemove, rename: handleRename, list: handleList };

function typeChoices() {
	return counters.COUNTER_TYPE_KEYS.map((key) => ({ name: counters.COUNTER_TYPES[key].label, value: key }));
}

module.exports = {
	// Switchable feature set this command belongs to (lib/features.js).
	// events/interactionCreate.js refuses it when the guild has it off.
	feature: 'memberCount',
	data: new SlashCommandBuilder()
		.setName('membercount')
		.setDescription('Voice channels whose name shows a live count.')
		.addSubcommand((sub) => sub
			.setName('add')
			.setDescription('(Admin) Add a counter channel.')
			.addStringOption((option) => option
				.setName('type')
				.setDescription('What to count')
				.addChoices(...typeChoices())
				.setRequired(true))
			.addRoleOption((option) => option
				.setName('role')
				.setDescription('Which role to count — only for the "Members in a role" counter')
				.setRequired(false))
			.addChannelOption((option) => option
				.setName('channel')
				.setDescription('An existing voice channel to use (default: I make one)')
				.addChannelTypes(ChannelType.GuildVoice)
				.setRequired(false))
			.addChannelOption((option) => option
				.setName('category')
				.setDescription('Existing category to create it in (default: no category)')
				.addChannelTypes(ChannelType.GuildCategory)
				.setRequired(false))
			.addStringOption((option) => option
				.setName('template')
				.setDescription('Name with {count} where the number goes, e.g. "Members: {count}"')
				.setMaxLength(counters.MAX_NAME_LENGTH)
				.setRequired(false)))
		.addSubcommand((sub) => sub
			.setName('rename')
			.setDescription('(Admin) Change what a counter channel is called.')
			.addChannelOption((option) => option
				.setName('channel')
				.setDescription('The counter channel')
				.addChannelTypes(ChannelType.GuildVoice)
				.setRequired(true))
			.addStringOption((option) => option
				.setName('template')
				.setDescription('Name with {count} where the number goes')
				.setMaxLength(counters.MAX_NAME_LENGTH)
				.setRequired(true)))
		.addSubcommand((sub) => sub
			.setName('remove')
			.setDescription('(Admin) Stop using a channel as a counter. The channel is kept.')
			.addChannelOption((option) => option
				.setName('channel')
				.setDescription('The counter channel')
				.addChannelTypes(ChannelType.GuildVoice)
				.setRequired(true)))
		.addSubcommand((sub) => sub
			.setName('list')
			.setDescription('(Admin) Show this server\'s counters and their current values.')),
	async execute(interaction) {
		const sub = interaction.options.getSubcommand();
		const handler = HANDLERS[sub];
		if (!handler) throw new Error(`Unknown /membercount subcommand: ${sub}`);
		await handler(interaction);
	},
};
