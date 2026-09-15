const db = require('./db');

function mapMenu(row) {
	if (!row) return null;
	return {
		messageId: row.message_id,
		guildId: row.guild_id,
		channelId: row.channel_id,
	};
}

function mapOption(row) {
	if (!row) return null;
	return {
		messageId: row.message_id,
		roleId: row.role_id,
		descriptor: row.descriptor,
	};
}

const insertMenuStmt = db.prepare(`
	INSERT INTO role_menus (message_id, guild_id, channel_id)
	VALUES (@messageId, @guildId, @channelId)
`);

function createMenu({ messageId, guildId, channelId }) {
	insertMenuStmt.run({ messageId, guildId, channelId });
}

const selectMenuStmt = db.prepare('SELECT * FROM role_menus WHERE message_id = ?');

function getMenu(messageId) {
	return mapMenu(selectMenuStmt.get(messageId));
}

const deleteMenuOptionsStmt = db.prepare('DELETE FROM role_menu_options WHERE message_id = ?');
const deleteMenuStmt = db.prepare('DELETE FROM role_menus WHERE message_id = ?');

// Wrapped in a transaction so a menu is never left with orphaned options (or
// vice versa) if the process dies mid-delete.
const deleteMenuTxn = db.transaction((messageId) => {
	deleteMenuOptionsStmt.run(messageId);
	deleteMenuStmt.run(messageId);
});

function deleteMenu(messageId) {
	deleteMenuTxn(messageId);
}

const selectMenusForGuildStmt = db.prepare('SELECT * FROM role_menus WHERE guild_id = ? ORDER BY message_id');

function listMenusForGuild(guildId) {
	return selectMenusForGuildStmt.all(guildId).map(mapMenu);
}

const upsertOptionStmt = db.prepare(`
	INSERT INTO role_menu_options (message_id, role_id, descriptor)
	VALUES (@messageId, @roleId, @descriptor)
	ON CONFLICT(message_id, role_id) DO UPDATE SET
		descriptor = excluded.descriptor
`);

function addOption({ messageId, roleId, descriptor }) {
	upsertOptionStmt.run({ messageId, roleId, descriptor: descriptor ?? null });
}

const deleteOptionStmt = db.prepare('DELETE FROM role_menu_options WHERE message_id = ? AND role_id = ?');

function removeOption(messageId, roleId) {
	return deleteOptionStmt.run(messageId, roleId).changes > 0;
}

const selectOptionsStmt = db.prepare('SELECT * FROM role_menu_options WHERE message_id = ? ORDER BY rowid');

function getOptions(messageId) {
	return selectOptionsStmt.all(messageId).map(mapOption);
}

const selectOptionByRoleStmt = db.prepare('SELECT * FROM role_menu_options WHERE message_id = ? AND role_id = ?');

function getOptionByRole(messageId, roleId) {
	return mapOption(selectOptionByRoleStmt.get(messageId, roleId));
}

module.exports = {
	createMenu,
	getMenu,
	deleteMenu,
	listMenusForGuild,
	addOption,
	removeOption,
	getOptions,
	getOptionByRole,
};
