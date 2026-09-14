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
`);

module.exports = db;
