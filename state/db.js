const fs = require('node:fs');
const path = require('node:path');

// Pinned to 12.11.1: the last release before better-sqlite3 13.0.0 removed
// prebuild-install entirely, so every install of 13.x+ compiles from source
// via node-gyp on every machine, needing a C/C++ toolchain this project's
// deploy host doesn't provision. 12.11.1 still ships a prebuilt binary and
// covers this project's Node floor (see README "Requirements"). When that
// floor changes again, re-check better-sqlite3's GitHub releases for a
// version whose prebuilds cover the new floor before bumping this — don't
// assume "latest" still means "has a prebuilt binary."
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'pariahbot.sqlite');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
	CREATE TABLE IF NOT EXISTS guild_settings (
		guild_id    TEXT PRIMARY KEY,
		mod_role_id TEXT
	);

	CREATE TABLE IF NOT EXISTS guild_alert_recipients (
		guild_id TEXT NOT NULL,
		user_id  TEXT NOT NULL,
		PRIMARY KEY (guild_id, user_id)
	);

	CREATE TABLE IF NOT EXISTS hubs (
		channel_id    TEXT PRIMARY KEY,
		guild_id      TEXT NOT NULL,
		category_id   TEXT,
		name_template TEXT NOT NULL DEFAULT '🔊 {owner}''s channel',
		default_limit INTEGER NOT NULL DEFAULT 0,
		min_limit     INTEGER NOT NULL DEFAULT 0,
		max_limit     INTEGER NOT NULL DEFAULT 99
	);

	-- hub_channel_id intentionally has no FK constraint to hubs.channel_id:
	-- removing a hub (Stage 1 checkpoint 2) must not be blocked by, or cascade
	-- into deleting, channels it already spawned that are still in use.
	CREATE TABLE IF NOT EXISTS temp_channels (
		channel_id     TEXT PRIMARY KEY,
		guild_id       TEXT NOT NULL,
		hub_channel_id TEXT NOT NULL,
		owner_id       TEXT NOT NULL,
		created_at     TEXT NOT NULL,
		min_limit      INTEGER NOT NULL,
		max_limit      INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS role_menus (
		message_id TEXT PRIMARY KEY,
		guild_id   TEXT NOT NULL,
		channel_id TEXT NOT NULL,
		type       TEXT NOT NULL CHECK (type IN ('reaction', 'dropdown'))
	);

	-- role_id is the primary uniqueness key (a role can only appear once per menu);
	-- emoji uniqueness for the 'reaction' type is enforced separately below, since a
	-- partial index can't be expressed inline in a CREATE TABLE column constraint.
	-- emoji is only ever set for 'reaction' options; descriptor (optional secondary
	-- text under the role's own name) is only ever set for 'dropdown' options.
	CREATE TABLE IF NOT EXISTS role_menu_options (
		message_id TEXT NOT NULL,
		role_id    TEXT NOT NULL,
		emoji      TEXT,
		descriptor TEXT,
		PRIMARY KEY (message_id, role_id)
	);

	CREATE UNIQUE INDEX IF NOT EXISTS idx_role_menu_options_emoji
		ON role_menu_options (message_id, emoji) WHERE emoji IS NOT NULL;
`);

// CREATE TABLE IF NOT EXISTS only helps for genuinely new tables — it does nothing
// for a column added to a table that already exists in an already-running bot's
// database (guild_settings shipped in Stage 1 checkpoint 1, unused until now). Any
// future column addition to an existing table needs the same kind of guarded
// ALTER TABLE, not just an edit to the CREATE statement above.
function hasColumn(table, column) {
	return db.prepare(`PRAGMA table_info(${table})`).all().some((col) => col.name === column);
}

if (!hasColumn('guild_settings', 'alert_channel_id')) {
	db.exec('ALTER TABLE guild_settings ADD COLUMN alert_channel_id TEXT');
}

// The bot's own auto-provisioned default alert category/channel — distinct from
// alert_channel_id (which only ever holds an admin's explicit choice) so an admin
// override and "what we made as a fallback" never get confused with each other.
// default_alerts_disabled is a separate sticky flag: without it, a guild where an
// admin explicitly removed the default would look identical (both columns null) to
// a guild that never had one, and the next restart would silently recreate it.
if (!hasColumn('guild_settings', 'default_category_id')) {
	db.exec('ALTER TABLE guild_settings ADD COLUMN default_category_id TEXT');
}
if (!hasColumn('guild_settings', 'default_channel_id')) {
	db.exec('ALTER TABLE guild_settings ADD COLUMN default_channel_id TEXT');
}
if (!hasColumn('guild_settings', 'default_alerts_disabled')) {
	db.exec('ALTER TABLE guild_settings ADD COLUMN default_alerts_disabled INTEGER NOT NULL DEFAULT 0');
}
if (!hasColumn('guild_settings', 'owner_kick_disabled')) {
	db.exec('ALTER TABLE guild_settings ADD COLUMN owner_kick_disabled INTEGER NOT NULL DEFAULT 0');
}

// No setter yet — /roles apply-channel-defaults falls back to @everyone until an
// admin command to set this ships.
if (!hasColumn('guild_settings', 'member_role_id')) {
	db.exec('ALTER TABLE guild_settings ADD COLUMN member_role_id TEXT');
}

module.exports = db;
