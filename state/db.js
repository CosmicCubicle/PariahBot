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

	-- Superseded guild_settings.mod_role_id (a single role) — mod status is now
	-- membership in any of these. See the migration below for existing installs.
	CREATE TABLE IF NOT EXISTS guild_mod_roles (
		guild_id TEXT NOT NULL,
		role_id  TEXT NOT NULL,
		PRIMARY KEY (guild_id, role_id)
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

	-- Dropdown role-selection menus only — reaction roles were removed.
	CREATE TABLE IF NOT EXISTS role_menus (
		message_id TEXT PRIMARY KEY,
		guild_id   TEXT NOT NULL,
		channel_id TEXT NOT NULL
	);

	-- role_id is the primary uniqueness key — a role can only appear once per menu.
	-- descriptor is optional secondary text shown under the role's own name.
	CREATE TABLE IF NOT EXISTS role_menu_options (
		message_id TEXT NOT NULL,
		role_id    TEXT NOT NULL,
		descriptor TEXT,
		PRIMARY KEY (message_id, role_id)
	);

	-- max_messages/live_seconds: 0 means "not used" — at least one must be
	-- nonzero for a row to exist at all (enforced by the command layer, not
	-- here). The live message list itself isn't stored: see lib/autoDelete.js.
	CREATE TABLE IF NOT EXISTS autodelete_channels (
		channel_id   TEXT PRIMARY KEY,
		guild_id     TEXT NOT NULL,
		max_messages INTEGER NOT NULL DEFAULT 0,
		live_seconds INTEGER NOT NULL DEFAULT 0
	);

	-- last_xp_at enforces the per-message XP cooldown (see lib/leveling.js) —
	-- stored here rather than in memory so the cooldown survives a restart.
	CREATE TABLE IF NOT EXISTS user_levels (
		guild_id   TEXT NOT NULL,
		user_id    TEXT NOT NULL,
		xp         INTEGER NOT NULL DEFAULT 0,
		level      INTEGER NOT NULL DEFAULT 0,
		last_xp_at TEXT,
		PRIMARY KEY (guild_id, user_id)
	);
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

// Set via /setup member-role. /roles apply-channel-defaults falls back to
// @everyone until this is set.
if (!hasColumn('guild_settings', 'member_role_id')) {
	db.exec('ALTER TABLE guild_settings ADD COLUMN member_role_id TEXT');
}

// Set via /setup streamer-role. No consumer yet — stored for future use.
if (!hasColumn('guild_settings', 'streamer_role_id')) {
	db.exec('ALTER TABLE guild_settings ADD COLUMN streamer_role_id TEXT');
}

// /security captcha. There's no separate "enabled" flag on purpose: a set
// screening_channel_id *is* "captcha is on", and disabling clears it. The
// sticky-disabled flag alerts needs (default_alerts_disabled) only exists
// because alerts auto-provision themselves on startup — these don't.
// screening_message_id tracks the persistent Verify message so re-running
// setup refreshes it instead of posting a second one.
if (!hasColumn('guild_settings', 'screening_channel_id')) {
	db.exec('ALTER TABLE guild_settings ADD COLUMN screening_channel_id TEXT');
}
if (!hasColumn('guild_settings', 'screening_message_id')) {
	db.exec('ALTER TABLE guild_settings ADD COLUMN screening_message_id TEXT');
}

// /security honeypot. honeypot_action is 'kick' (softban, the default) or
// 'ban'; it's only meaningful while honeypot_channel_id is set.
if (!hasColumn('guild_settings', 'honeypot_channel_id')) {
	db.exec('ALTER TABLE guild_settings ADD COLUMN honeypot_channel_id TEXT');
}
if (!hasColumn('guild_settings', 'honeypot_action')) {
	db.exec("ALTER TABLE guild_settings ADD COLUMN honeypot_action TEXT NOT NULL DEFAULT 'kick'");
}

// Installs that already had role_menus/role_menu_options from before the
// reaction-roles removal hit CREATE TABLE IF NOT EXISTS as a no-op above, same
// as every other case on this page. role_menus.type was NOT NULL, so simply
// leaving it in place would break every future insert (nothing populates it
// any more) — it has to actually be dropped, not just ignored like a nullable
// leftover column would be. Dropping role_menu_options' old emoji/label at the
// same time for the same reason this whole block exists: don't leave schema
// debris an old install and a fresh one disagree about. Requires SQLite 3.35+
// for DROP COLUMN (better-sqlite3 12.11.1 bundles 3.53).
if (hasColumn('role_menus', 'type')) {
	db.exec('ALTER TABLE role_menus DROP COLUMN type');
}
if (hasColumn('role_menu_options', 'emoji')) {
	// The old reaction-roles unique index on (message_id, emoji) has to go first —
	// SQLite refuses to drop a column an index still references.
	db.exec('DROP INDEX IF EXISTS idx_role_menu_options_emoji');
	db.exec('ALTER TABLE role_menu_options DROP COLUMN emoji');
}
if (hasColumn('role_menu_options', 'label')) {
	db.exec('ALTER TABLE role_menu_options DROP COLUMN label');
}
if (!hasColumn('role_menu_options', 'descriptor')) {
	db.exec('ALTER TABLE role_menu_options ADD COLUMN descriptor TEXT');
}

// mod_role_id (a single role) is superseded by guild_mod_roles (any number of
// roles) — copy over any guild that already had one set, then null the column
// out. That second step is what makes this a genuinely one-time migration
// rather than something that reruns every startup: without it, a guild that
// used /setup mod-role remove to deliberately drop that original role would
// have it silently reinserted the next time the bot restarts, since this
// block has no other memory of "already migrated" to check against.
// mod_role_id is left in the schema unused rather than dropped: it's nullable,
// so unlike role_menus.type earlier there's no constraint it could violate by
// staying, and INSERT OR IGNORE + this UPDATE are both safe to re-run.
db.exec(`
	INSERT OR IGNORE INTO guild_mod_roles (guild_id, role_id)
	SELECT guild_id, mod_role_id FROM guild_settings WHERE mod_role_id IS NOT NULL;

	UPDATE guild_settings SET mod_role_id = NULL WHERE mod_role_id IS NOT NULL;
`);

module.exports = db;
