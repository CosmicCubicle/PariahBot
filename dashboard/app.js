'use strict';

// PariahBot admin dashboard. Plain DOM, no framework or build step. Every
// value that came from Discord, a feed or an admin is set as text (h() below
// never uses innerHTML), so a server, channel or feed name can't inject markup.

const state = { user: null, guilds: [], view: 'status', guild: null, tab: 'general' };

// --- Small helpers -------------------------------------------------------------

function h(tag, props = {}, ...children) {
	const el = document.createElement(tag);
	for (const [key, value] of Object.entries(props ?? {})) {
		if (value === undefined || value === null || value === false) continue;
		if (key === 'class') el.className = value;
		else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
		else if (['value', 'checked', 'disabled', 'selected'].includes(key)) el[key] = value;
		else el.setAttribute(key, value === true ? '' : value);
	}
	for (const child of children.flat(Infinity)) {
		if (child === null || child === undefined || child === false) continue;
		el.append(child instanceof Node ? child : document.createTextNode(String(child)));
	}
	return el;
}

const $ = (id) => document.getElementById(id);

let toastTimer = null;
function toast(message, isError = false) {
	const el = $('toast');
	el.textContent = message;
	el.className = `toast show${isError ? ' error' : ''}`;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => { el.className = 'toast'; }, isError ? 7000 : 3500);
}

async function api(path, body) {
	const options = body === undefined
		? {}
		: { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PariahBot-Dashboard': '1' }, body: JSON.stringify(body) };
	const response = await fetch(path, options);
	const data = await response.json().catch(() => ({}));
	if (response.status === 401) {
		showLogin();
		throw new Error('Your session ended — sign in again.');
	}
	if (!response.ok) throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
	return data;
}

// Runs a dashboard action, reports the result, and reloads the server so the
// page shows what's actually stored.
async function act(action, body, button) {
	if (button) button.disabled = true;
	try {
		const { message } = await api(`/api/guilds/${state.guild.id}/actions/${action}`, body);
		toast(message);
		await openGuild(state.guild.id, false);
	} catch (error) {
		toast(error.message, true);
	} finally {
		if (button) button.disabled = false;
	}
}

function confirmThen(question, fn) {
	return (event) => {
		if (window.confirm(question)) fn(event);
	};
}

function formatDate(iso) {
	return iso ? new Date(iso).toLocaleString() : '—';
}

function formatUptime(seconds) {
	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	return [days && `${days}d`, (days || hours) && `${hours}h`, `${minutes}m`].filter(Boolean).join(' ');
}

function channelName(id) {
	if (!id) return 'None';
	const channel = state.guild.channels.find((c) => c.id === id);
	return channel ? `#${channel.name}` : `Deleted channel (${id})`;
}

function roleName(id) {
	if (!id) return 'None';
	const role = state.guild.roles.find((r) => r.id === id);
	return role ? `@${role.name}` : `Deleted role (${id})`;
}

function userLabel(name, id) {
	return name ? `${name}` : `User ${id}`;
}

function channelSelect(selectedId, noneLabel) {
	return h('select', {},
		noneLabel ? h('option', { value: '' }, noneLabel) : null,
		state.guild.channels.map((channel) => h('option', { value: channel.id, selected: channel.id === selectedId },
			`#${channel.name}${channel.canPost ? '' : ' (bot can’t post)'}`)));
}

function roleSelect(selectedId, noneLabel) {
	return h('select', {},
		noneLabel ? h('option', { value: '' }, noneLabel) : null,
		state.guild.roles.map((role) => h('option', { value: role.id, selected: role.id === selectedId }, `@${role.name}`)));
}

function field(label, control, narrow = false) {
	return h('div', { class: `field${narrow ? ' narrow' : ''}` }, h('label', {}, label), control);
}

function card(title, description, ...content) {
	return h('section', { class: 'card' }, h('h2', {}, title), description ? h('p', { class: 'muted' }, description) : null, content);
}

function pill(on, onText = 'On', offText = 'Off') {
	return h('span', { class: `pill ${on ? 'on' : 'off'}` }, on ? onText : offText);
}

function table(headers, rows, empty) {
	if (!rows.length) return h('p', { class: 'muted' }, empty);
	return h('table', {}, h('thead', {}, h('tr', {}, headers.map((header) => h('th', {}, header)))), h('tbody', {}, rows));
}

function btn(label, kind, onclick) {
	return h('button', { class: kind, type: 'button', onclick }, label);
}

// --- Sign-in, navigation and status ---------------------------------------

function showLogin() {
	state.user = null;
	$('account').replaceChildren();
	$('nav').replaceChildren();
	$('main').replaceChildren(h('div', { class: 'center' }, h('div', { class: 'card' },
		h('h2', {}, 'Sign in'),
		h('p', { class: 'muted' }, "For the bot's owner, and admins of the servers it's in. You'll see the servers you're an admin in."),
		h('a', { href: '/login' }, h('button', { class: 'primary', type: 'button' }, 'Sign in with Discord')))));
}

function renderAccount() {
	const { user } = state;
	const avatar = user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : null;
	// Wrapped in h(), which skips null: replaceChildren would show "null" for
	// an account with no avatar.
	$('account').replaceChildren(h('span', { class: 'account' },
		avatar ? h('img', { src: avatar, alt: '' }) : null,
		h('span', {}, user.isOwner ? `${user.username} (owner)` : user.username),
		btn('Sign out', 'secondary', async () => {
			await fetch('/logout', { method: 'POST', headers: { 'X-PariahBot-Dashboard': '1' } });
			showLogin();
		}),
	));
}

function renderNav() {
	const navButton = (label, active, onclick, icon) => h('button', { class: active ? 'active' : '', type: 'button', onclick }, icon, h('span', {}, label));
	// replaceChildren takes nodes only: an array becomes the text
	// "[object HTMLButtonElement],…" and null becomes "null". So the list is
	// built here, filtered, and spread.
	const items = [
		// Status covers every server and the host, so only the owner gets it.
		state.user.isOwner ? navButton('Status', state.view === 'status', () => showStatus(), h('span', { class: 'icon' }, '●')) : null,
		h('h3', {}, `Servers (${state.guilds.length})`),
		...state.guilds.map((guild) => navButton(
			guild.name,
			state.view === 'guild' && state.guild?.id === guild.id,
			() => openGuild(guild.id),
			guild.icon ? h('img', { src: guild.icon, alt: '' }) : h('span', { class: 'icon' }, guild.name.slice(0, 2)),
		)),
	];
	$('nav').replaceChildren(...items.filter(Boolean));
}

async function showStatus() {
	state.view = 'status';
	renderNav();
	let status;
	try {
		status = await api('/api/status');
	} catch (error) {
		toast(error.message, true);
		return;
	}
	const stat = (label, value) => h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value));
	const integration = (label, on) => h('div', {}, pill(on, 'Configured', 'Not set up'), ' ', label);

	$('main').replaceChildren(
		h('h1', {}, 'Status'),
		h('p', { class: 'muted' }, `Signed in as the owner of ${status.bot.tag}.`),
		card('Bot', null, h('div', { class: 'grid' },
			stat('Account', status.bot.tag),
			stat('Up for', formatUptime(status.uptimeSeconds)),
			stat('Discord latency', status.pingMs >= 0 ? `${status.pingMs} ms` : '—'),
			stat('Servers', status.guilds),
			stat('Memory', `${status.memoryMb} MB`),
			stat('Version', status.commit ?? 'unknown'),
			stat('Node', status.node),
			stat('Pending temporary bans', status.pendingTempBans),
		)),
		card('Integrations', 'Set in hom.env on the host — see the wiki for each.',
			integration('Twitch', status.integrations.twitch),
			integration('YouTube', status.integrations.youtube),
			integration('Instagram', status.integrations.instagram),
			integration('Command log channel', status.integrations.logChannel)),
		card('RSS feeds with errors', null, table(
			['Server', 'Feed', 'Error'],
			status.feedErrors.map((feed) => h('tr', {}, h('td', {}, feed.guild), h('td', {}, feed.title), h('td', { class: 'bad' }, feed.error))),
			'All feeds are working.',
		)),
	);
}

// --- A server --------------------------------------------------------------------

const TABS = [
	['general', 'General'],
	['bannedWords', 'Banned words'],
	['alerts', 'Stream, Instagram & RSS'],
	['autoDelete', 'Auto-delete'],
	['moderation', 'Moderation'],
	['voice', 'Voice'],
	['other', 'Giveaways & more'],
];

async function openGuild(guildId, resetTab = true) {
	try {
		state.guild = await api(`/api/guilds/${guildId}`);
	} catch (error) {
		toast(error.message, true);
		return;
	}
	state.view = 'guild';
	if (resetTab) state.tab = 'general';
	renderNav();
	renderGuild();
}

function renderGuild() {
	const guild = state.guild;
	const tabs = h('div', { class: 'tabs', role: 'tablist' }, TABS.map(([key, label]) => h('button', {
		class: state.tab === key ? 'active' : '', type: 'button', role: 'tab',
		onclick: () => { state.tab = key; renderGuild(); },
	}, label)));
	const sections = { general: generalTab, bannedWords: bannedWordsTab, alerts: alertsTab, autoDelete: autoDeleteTab, moderation: moderationTab, voice: voiceTab, other: otherTab };
	$('main').replaceChildren(
		h('h1', {}, guild.name),
		h('p', { class: 'muted' }, `${guild.memberCount} members · ID ${guild.id}`),
		tabs,
		sections[state.tab](),
	);
}

function permissionWarnings() {
	const p = state.guild.permissions;
	const missing = [
		[!p.manageGuild, 'Manage Server', 'banned words'],
		[!p.kickMembers, 'Kick Members', '/mod kick'],
		[!p.banMembers, 'Ban Members', 'bans and the honeypot'],
		[!p.moderateMembers, 'Timeout Members', 'timeouts and automatic timeouts'],
		[!p.manageChannels, 'Manage Channels', 'voice channels and setup'],
		[!p.manageRoles, 'Manage Roles', 'role menus, verification and channel permissions'],
		[!p.manageMessages, 'Manage Messages', 'auto-delete'],
	].filter(([isMissing]) => isMissing);
	if (!missing.length) return null;
	return h('div', { class: 'warning' },
		h('strong', {}, 'The bot is missing permissions here: '),
		missing.map(([, name, use]) => `${name} (${use})`).join(', '),
		'. Add them to its PariahBot role in Server Settings → Roles.');
}

function generalTab() {
	const guild = state.guild;
	const alertChannel = channelSelect(guild.alerts.channelId, 'Default channel');
	const recipientId = h('input', { placeholder: 'Discord user ID' });
	const memberRole = roleSelect(guild.serverRoles.memberRoleId, 'None');
	const streamerRole = roleSelect(guild.serverRoles.streamerRoleId, 'None');
	const modRole = roleSelect(null, null);

	return h('div', {},
		permissionWarnings(),
		card('Admin alerts', 'Where the bot reports honeypot removals, moderation actions, blocked words and deleted voice hubs.',
			h('div', { class: 'row' },
				field('Alert channel', alertChannel),
				btn('Save', 'primary', (e) => act('alerts.setChannel', { channelId: alertChannel.value || null }, e.target))),
			guild.alerts.defaultChannelId && !guild.alerts.channelId
				? h('p', { class: 'muted' }, `Using the default channel ${channelName(guild.alerts.defaultChannelId)}.`) : null,
			h('h3', {}, 'DM recipients'),
			h('div', { class: 'chips' }, guild.alerts.recipients.length
				? guild.alerts.recipients.map((r) => h('span', { class: 'chip' }, userLabel(r.name, r.id),
					h('button', { type: 'button', title: 'Remove', onclick: (e) => act('alerts.removeRecipient', { userId: r.id }, e.target) }, '×')))
				: h('span', { class: 'muted' }, 'Nobody is DMed alerts.')),
			h('div', { class: 'row' },
				field('Add by user ID', recipientId),
				btn('Add', 'secondary', (e) => act('alerts.addRecipient', { userId: recipientId.value.trim() }, e.target)))),
		card('Server roles', 'The roles other features depend on.',
			h('div', { class: 'row' },
				field('Member role (granted by verification)', memberRole),
				btn('Save', 'primary', (e) => act('roles.setMember', { roleId: memberRole.value || null }, e.target))),
			h('div', { class: 'row' },
				field('Streamer role (can self-link for stream alerts)', streamerRole),
				btn('Save', 'primary', (e) => act('roles.setStreamer', { roleId: streamerRole.value || null }, e.target))),
			h('h3', {}, 'Mod roles'),
			h('p', { class: 'muted' }, 'Members with any of these can use admin commands, and are never targeted by moderation or the honeypot.'),
			h('div', { class: 'chips' }, guild.serverRoles.modRoleIds.length
				? guild.serverRoles.modRoleIds.map((id) => h('span', { class: 'chip' }, roleName(id),
					h('button', { type: 'button', title: 'Remove', onclick: (e) => act('roles.removeMod', { roleId: id }, e.target) }, '×')))
				: h('span', { class: 'muted' }, 'No mod roles — only Administrators.')),
			h('div', { class: 'row' }, field('Add a mod role', modRole), btn('Add', 'secondary', (e) => act('roles.addMod', { roleId: modRole.value }, e.target)))),
	);
}

function bannedWordsTab() {
	const bw = state.guild.bannedWords;
	const words = h('textarea', { placeholder: 'badword, bad phrase, *scamsite*' });
	return h('div', {},
		state.guild.permissions.manageGuild ? null : h('div', { class: 'warning' }, 'The bot needs Manage Server here to manage AutoMod rules.'),
		card('Banned words', 'Discord AutoMod blocks matching messages before anyone sees them. Each block is reported in the admin alerts.',
			h('div', { class: 'row' },
				h('span', {}, 'Status: ', pill(bw.enabled)),
				btn(bw.enabled ? 'Turn off' : 'Turn on', bw.enabled ? 'danger' : 'primary', (e) => act('bannedWords.setEnabled', { enabled: !bw.enabled }, e.target))),
			h('h3', {}, 'Lists'),
			h('div', { class: 'checks' }, bw.available.map((list) => h('label', {},
				h('input', { type: 'checkbox', checked: bw.lists.includes(list.key), onchange: (e) => act('bannedWords.setList', { key: list.key, enabled: e.target.checked }, e.target) }),
				h('span', {}, h('strong', {}, list.label), ' ', h('span', { class: 'muted' }, `— ${list.description}`)))))),
		card(`Custom words (${bw.words.length} of ${bw.maxWords})`, 'Whole-word, any case. * is a wildcard at either end.',
			h('div', { class: 'chips' }, bw.words.length
				? bw.words.map((word) => h('span', { class: 'chip' }, word,
					h('button', { type: 'button', title: 'Remove', onclick: (e) => act('bannedWords.removeWord', { word }, e.target) }, '×')))
				: h('span', { class: 'muted' }, 'None yet.')),
			h('div', { class: 'row' }, field('Add words (comma-separated)', words), btn('Add', 'primary', (e) => act('bannedWords.addWords', { words: words.value }, e.target)))),
	);
}

function alertSettingsCard(title, description, prefix, settings, placeholders, extra) {
	const channel = channelSelect(settings.channelId, 'Off');
	const role = roleSelect(settings.roleId, 'No ping');
	const message = h('textarea', { value: settings.message ?? '', placeholder: `Optional. Placeholders: ${placeholders}` });
	return card(title, description,
		extra,
		h('div', { class: 'row' },
			field('Channel', channel),
			field('Ping role', role),
			btn('Save', 'primary', (e) => act(`${prefix}.setChannel`, { channelId: channel.value || null, roleId: role.value || null }, e.target))),
		h('div', { class: 'row' },
			field('Custom message (the ping role is still pinged)', message),
			btn('Save message', 'secondary', (e) => act(`${prefix}.setMessage`, { message: message.value }, e.target))));
}

function alertsTab() {
	const { streams, instagram, rss } = state.guild;
	const platform = h('select', {}, streams.platforms.map((p) => h('option', { value: p.key, disabled: !p.configured }, `${p.label}${p.configured ? '' : ' (not set up)'}`)));
	const account = h('input', { placeholder: 'Twitch username or YouTube @handle' });
	const igAccount = h('input', { placeholder: 'username or instagram.com link' });
	const feedUrl = h('input', { placeholder: 'https://example.com/feed' });
	const feedChannel = channelSelect(null, null);
	const feedRole = roleSelect(null, 'No ping');
	const feedMessage = h('input', { placeholder: 'Optional. {feed} {title} {url} {role}' });

	return h('div', {},
		alertSettingsCard('Stream alerts', 'Twitch live, and YouTube live and uploads.', 'streams', streams, '{name} {title} {url} {platform} {role}',
			h('p', {}, streams.platforms.map((p) => [pill(p.configured, `${p.label} configured`, `${p.label} not set up`), ' ']))),
		card(`Streamers (${streams.links.length})`, null,
			table(['Channel', 'Platform', 'Member', 'Added by', ''], streams.links.map((link) => h('tr', {},
				h('td', {}, link.accountName),
				h('td', {}, link.platform),
				h('td', {}, link.userId ? userLabel(link.memberName, link.userId) : '—'),
				h('td', {}, link.manual ? 'Admin' : 'Streamer role'),
				h('td', {}, btn('Remove', 'danger', confirmThen(`Remove ${link.accountName}?`, (e) => act('streams.remove', { platform: link.platform, accountId: link.accountId }, e.target)))))), 'No streamers yet.'),
			h('div', { class: 'row' }, field('Platform', platform, true), field('Add a channel', account), btn('Add', 'primary', (e) => act('streams.add', { platform: platform.value, account: account.value }, e.target)))),
		alertSettingsCard('Instagram', instagram.configured ? 'New posts and reels from followed accounts.' : 'Instagram isn’t set up on the host — see the wiki’s Instagram Alerts page.', 'instagram', instagram, '{name} {title} {url} {platform} {role}', null),
		card(`Instagram accounts (${instagram.accounts.length})`, null,
			table(['Account', 'Since', ''], instagram.accounts.map((a) => h('tr', {},
				h('td', {}, `@${a.username}`),
				h('td', {}, formatDate(a.addedAt)),
				h('td', {}, btn('Remove', 'danger', confirmThen(`Stop following @${a.username}?`, (e) => act('instagram.remove', { accountId: a.accountId }, e.target)))))), 'No accounts yet.'),
			h('div', { class: 'row' }, field('Follow an account', igAccount), btn('Add', 'primary', (e) => act('instagram.add', { account: igAccount.value }, e.target)))),
		card(`RSS feeds (${rss.feeds.length} of ${rss.max})`, 'Each feed posts to its own channel. Only items published after adding are posted.',
			table(['Feed', 'Channel', 'Last checked', ''], rss.feeds.map((feed) => h('tr', {},
				h('td', {}, h('div', {}, feed.title), h('div', { class: 'muted' }, feed.url), feed.lastError ? h('div', { class: 'bad' }, feed.lastError) : null),
				h('td', {}, channelName(feed.channelId), feed.roleId ? h('div', { class: 'muted' }, `pings ${roleName(feed.roleId)}`) : null),
				h('td', {}, formatDate(feed.lastCheckedAt)),
				h('td', {}, btn('Remove', 'danger', confirmThen(`Stop following ${feed.title}?`, (e) => act('rss.remove', { feedId: feed.id }, e.target)))))), 'No feeds yet.'),
			h('div', { class: 'row' }, field('Feed address', feedUrl), field('Channel', feedChannel)),
			h('div', { class: 'row' }, field('Ping role', feedRole), field('Custom message', feedMessage),
				btn('Add feed', 'primary', (e) => act('rss.add', { url: feedUrl.value, channelId: feedChannel.value, roleId: feedRole.value || null, message: feedMessage.value }, e.target)))),
	);
}

function autoDeleteTab() {
	const channel = channelSelect(null, null);
	const count = h('input', { type: 'number', min: '1', placeholder: 'e.g. 100' });
	const duration = h('input', { placeholder: 'e.g. 24h, 7d' });
	return card('Auto-delete', 'Each message is deleted once it’s older than the duration, or once that many newer messages exist. Pinned messages are never deleted.',
		table(['Channel', 'Keep at most', 'Delete after', ''], state.guild.autoDelete.map((entry) => h('tr', {},
			h('td', {}, channelName(entry.channelId)),
			h('td', {}, entry.maxMessages ? `${entry.maxMessages} messages` : '—'),
			h('td', {}, entry.duration ?? '—'),
			h('td', {}, btn('Turn off', 'danger', (e) => act('autoDelete.remove', { channelId: entry.channelId }, e.target))))), 'Not on in any channel.'),
		h('div', { class: 'row' }, field('Channel', channel), field('Count', count, true), field('Duration', duration, true),
			btn('Save', 'primary', (e) => act('autoDelete.set', { channelId: channel.value, count: count.value || null, duration: duration.value || null }, e.target))));
}

function moderationTab() {
	const m = state.guild.moderation;
	const count = h('input', { type: 'number', min: '2', max: '20', value: m.escalation?.count ?? 3 });
	const within = h('input', { value: m.escalation?.within ?? '', placeholder: 'e.g. 7d' });
	const timeout = h('input', { value: m.escalation?.timeout ?? '', placeholder: 'e.g. 1h' });
	const note = h('input', { value: m.appealNote ?? '', placeholder: 'e.g. Appeal at https://example.com/appeal' });

	return h('div', {},
		card('Automatic timeouts', 'Time a member out once they reach this many warnings within the window — and again on each further warning.',
			h('p', {}, 'Now: ', m.escalation ? m.escalation.description : 'Off'),
			h('div', { class: 'row' }, field('Warnings', count, true), field('Within', within, true), field('Timeout', timeout, true),
				btn('Save', 'primary', (e) => act('moderation.setEscalation', { count: Number(count.value), within: within.value, timeout: timeout.value }, e.target)),
				m.escalation ? btn('Turn off', 'danger', (e) => act('moderation.setEscalation', { off: true }, e.target)) : null)),
		card('Ban appeal note', 'A line added to the end of every ban DM.',
			h('div', { class: 'row' }, field('Note', note),
				btn('Save', 'primary', (e) => act('moderation.setAppealNote', { note: note.value }, e.target)),
				m.appealNote ? btn('Clear', 'secondary', (e) => act('moderation.setAppealNote', { note: null }, e.target)) : null)),
		card('Temporary bans', null, table(['Member', 'Ends', 'Reason'], m.tempBans.map((ban) => h('tr', {},
			h('td', {}, userLabel(ban.userName, ban.userId)), h('td', {}, formatDate(ban.unbanAt)), h('td', {}, ban.reason ?? '—'))), 'None pending.')),
		card('Recent cases', 'The latest 25 moderation actions. Removing a case deletes the record only — it doesn’t undo the action. Use /mod history in Discord for one member’s full record.',
			table(['Case', 'Action', 'Member', 'By', 'When', 'Reason', ''], m.recentCases.map((c) => h('tr', {},
				h('td', {}, `#${c.id}`),
				h('td', {}, c.label, c.duration ? h('div', { class: 'muted' }, c.duration) : null),
				h('td', {}, userLabel(c.userName, c.userId)),
				h('td', {}, c.moderatorName ?? c.moderatorId),
				h('td', {}, formatDate(c.createdAt)),
				h('td', {}, c.reason ?? '—'),
				h('td', {}, btn('Remove', 'danger', confirmThen(`Remove case #${c.id}? The action itself isn't undone.`, (e) => act('moderation.removeCase', { caseId: c.id }, e.target)))))), 'No cases yet.')),
	);
}

function categorySelect(selectedId, noneLabel) {
	return h('select', {},
		h('option', { value: '' }, noneLabel),
		state.guild.voice.categories.map((category) => h('option', { value: category.id, selected: category.id === selectedId }, category.name)));
}

function limitInput(value) {
	return h('input', { type: 'number', min: '0', max: String(state.guild.voice.maxLimit), value: String(value) });
}

// One card per hub: its settings, editable, or — if its channel was deleted —
// the choice to forget it or recreate it.
function hubCard(hub) {
	if (!hub.exists) {
		return h('section', { class: 'card' },
			h('h2', {}, `Deleted hub (${hub.channelId})`),
			h('div', { class: 'warning' }, 'This hub’s voice channel was deleted in Discord. Forget it, or recreate the channel with the same settings.'),
			h('div', { class: 'row' },
				btn('Restore', 'primary', (e) => act('voice.restoreHub', { hubId: hub.channelId }, e.target)),
				btn('Forget', 'danger', confirmThen('Forget this hub?', (e) => act('voice.pruneHub', { hubId: hub.channelId }, e.target)))));
	}
	const template = h('input', { value: hub.nameTemplate, maxlength: '100' });
	const defaultLimit = limitInput(hub.defaultLimit);
	const minLimit = limitInput(hub.minLimit);
	const maxLimit = limitInput(hub.maxLimit);
	const category = categorySelect(hub.categoryId, 'The hub’s own category');
	return h('section', { class: 'card' },
		h('h2', {}, hub.name),
		h('div', { class: 'row' }, field('Temp channel name — {owner} is the owner’s name', template)),
		h('div', { class: 'row' },
			field('Default limit (0 = none)', defaultLimit, true),
			field('Owners can set from', minLimit, true),
			field('…up to', maxLimit, true),
			field('Temp channels go in', category)),
		h('div', { class: 'row' },
			btn('Save', 'primary', (e) => act('voice.editHub', {
				hubId: hub.channelId,
				nameTemplate: template.value,
				defaultLimit: defaultLimit.value,
				minLimit: minLimit.value,
				maxLimit: maxLimit.value,
				categoryId: category.value || null,
			}, e.target)),
			btn('Remove hub', 'danger', confirmThen(`Remove the hub and delete #${hub.name}?`, (e) => act('voice.removeHub', { hubId: hub.channelId }, e.target)))),
		h('p', { class: 'muted' }, 'Changes apply to temp channels created from now on.'));
}

function voiceTab() {
	const voice = state.guild.voice;
	const hubIds = new Set(voice.hubs.map((hub) => hub.channelId));
	const existing = h('select', {}, voice.voiceChannels.filter((c) => !hubIds.has(c.id)).map((c) => h('option', { value: c.id }, c.name)));
	const existingCategory = categorySelect(null, 'The hub’s own category');
	const newName = h('input', { placeholder: '➕ Join to Create' });
	const newCategory = categorySelect(null, 'No category');

	return h('div', {},
		card('Live temporary channels', 'Every temp channel open right now. Closing one disconnects everyone in it and deletes it.',
			table(['Channel', 'Owner', 'In it', 'Limit', ''], voice.tempChannels.map((temp) => {
				const others = temp.members.filter((m) => m.id !== temp.ownerId);
				const newOwner = h('select', {}, others.map((m) => h('option', { value: m.id }, m.name)));
				return h('tr', {},
					h('td', {}, temp.name, temp.locked ? h('div', { class: 'muted' }, '🔒 locked') : null),
					h('td', {}, userLabel(temp.ownerName, temp.ownerId)),
					h('td', {}, temp.members.length ? temp.members.map((m) => m.name).join(', ') : h('span', { class: 'muted' }, 'empty')),
					h('td', {}, temp.userLimit || 'none'),
					h('td', {},
						others.length ? h('div', { class: 'row' }, newOwner, btn('Transfer', 'secondary', (e) => act('voice.transferTemp', { channelId: temp.channelId, userId: newOwner.value }, e.target))) : null,
						btn('Close', 'danger', confirmThen(`Close #${temp.name}? Everyone in it is disconnected.`, (e) => act('voice.closeTemp', { channelId: temp.channelId }, e.target)))));
			}), 'No temp channels are open.')),
		card('Owner controls', 'Which /vc commands temp channel owners may use. /vc claim always works, so an abandoned channel can be taken over.',
			h('div', { class: 'checks' }, voice.ownerControls.map((control) => h('label', {},
				h('input', { type: 'checkbox', checked: control.allowed, onchange: (e) => act('voice.setOwnerControl', { control: control.key, allowed: e.target.checked }, e.target) }),
				h('span', {}, h('strong', {}, control.label), ' ', h('span', { class: 'muted' }, control.command)))))),
		voice.hubs.length ? voice.hubs.map(hubCard) : card('Hubs', null, h('p', { class: 'muted' }, 'No hubs yet. Add one below.')),
		card('Add a hub', 'Members who join a hub get their own temporary voice channel.',
			h('h3', {}, 'Use an existing voice channel'),
			existing.options.length
				? h('div', { class: 'row' }, field('Voice channel', existing), field('Temp channels go in', existingCategory),
					btn('Make it a hub', 'primary', (e) => act('voice.addHub', { channelId: existing.value, categoryId: existingCategory.value || null }, e.target)))
				: h('p', { class: 'muted' }, 'Every voice channel is already a hub.'),
			h('h3', {}, 'Or create a new one'),
			h('div', { class: 'row' }, field('Name', newName), field('Category', newCategory),
				btn('Create hub', 'primary', (e) => act('voice.createHub', { name: newName.value, categoryId: newCategory.value || null }, e.target)))),
	);
}

function otherTab() {
	const guild = state.guild;
	return h('div', {},
		card('Active giveaways', null, table(['Prize', 'Channel', 'Winners', 'Entries', 'Ends', ''], guild.giveaways.map((g) => h('tr', {},
			h('td', {}, g.prize), h('td', {}, channelName(g.channelId)), h('td', {}, g.winnerCount), h('td', {}, g.entries), h('td', {}, formatDate(g.endsAt)),
			h('td', {}, btn('End now', 'danger', confirmThen(`End "${g.prize}" now and draw winners?`, (e) => act('giveaways.end', { giveawayId: g.id }, e.target)))))), 'No active giveaways.')),
		card('Security', 'Set these up with /security in Discord; they create channels and post messages.',
			h('div', { class: 'row' },
				h('span', {}, 'Verification: ', guild.security.screeningChannelId ? `on in ${channelName(guild.security.screeningChannelId)}` : 'off'),
				guild.security.screeningChannelId ? btn('Disable', 'danger', confirmThen('Disable verification?', (e) => act('security.disableCaptcha', {}, e.target))) : null),
			h('div', { class: 'row' },
				h('span', {}, 'Honeypot: ', guild.security.honeypotChannelId ? `on in ${channelName(guild.security.honeypotChannelId)} (${guild.security.honeypotAction === 'ban' ? 'ban' : 'softban'})` : 'off'),
				guild.security.honeypotChannelId ? btn('Disable', 'danger', confirmThen('Disable the honeypot?', (e) => act('security.disableHoneypot', {}, e.target))) : null)),
		card('Level leaderboard', null, table(['#', 'Member', 'Level', 'XP'], guild.levels.map((row, index) => h('tr', {},
			h('td', {}, index + 1), h('td', {}, userLabel(row.name, row.userId)), h('td', {}, row.level), h('td', {}, row.xp))), 'Nobody has XP yet.')),
	);
}

// --- Start ---------------------------------------------------------------------------

async function start() {
	try {
		state.user = await api('/api/me');
	} catch {
		showLogin();
		return;
	}
	renderAccount();
	try {
		state.guilds = await api('/api/guilds');
	} catch (error) {
		toast(error.message, true);
	}
	if (state.user.isOwner) {
		showStatus();
	} else if (state.guilds.length) {
		openGuild(state.guilds[0].id);
	} else {
		renderNav();
		$('main').replaceChildren(h('div', { class: 'center' }, h('div', { class: 'card' },
			h('h2', {}, 'No servers to manage'),
			h('p', { class: 'muted' }, "You're not an admin in any server PariahBot is in any more. Server admins need Administrator or a mod role."))));
	}
}

start();
