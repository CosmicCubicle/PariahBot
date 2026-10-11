const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const Database = require('better-sqlite3');
const { useTempDb } = require('./helpers/tempDb');

const { file } = useTempDb('db');

const DB_MODULE = path.resolve(__dirname, '..', 'state', 'db.js');

// Drops state/db.js from the registry so the next require re-runs the whole
// schema and migration block against the same file. That is exactly what a
// restart does, which is what CodeStandards.md § 13 asks to be proven twice.
function requireDbFresh() {
	delete require.cache[DB_MODULE];
	return require(DB_MODULE);
}

function columns(db, table) {
	return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

// The schema as it shipped before reaction roles were removed, including the
// CHECK constraint and the index that made this migration fail three times in
// production. CREATE TABLE IF NOT EXISTS is a no-op against these, so only the
// guarded ALTER TABLEs in state/db.js can fix them.
function seedOldSchema() {
	const old = new Database(file);
	old.exec(`
		CREATE TABLE guild_settings (
			guild_id              TEXT PRIMARY KEY,
			mod_role_id           TEXT,
			banned_words_enabled  INTEGER NOT NULL DEFAULT 0
		);

		CREATE TABLE role_menus (
			message_id TEXT PRIMARY KEY,
			guild_id   TEXT NOT NULL,
			channel_id TEXT NOT NULL,
			type       TEXT NOT NULL CHECK (type IN ('reaction', 'dropdown'))
		);

		CREATE TABLE role_menu_options (
			message_id TEXT NOT NULL,
			role_id    TEXT NOT NULL,
			emoji      TEXT,
			label      TEXT,
			PRIMARY KEY (message_id, role_id)
		);

		CREATE UNIQUE INDEX idx_role_menu_options_emoji ON role_menu_options (message_id, emoji);

		-- g1 had banned words switched on, g2 never touched it. Both have to
		-- survive the move to guild_feature_toggles with the right value.
		INSERT INTO guild_settings (guild_id, mod_role_id, banned_words_enabled) VALUES ('g1', 'legacy-mod-role', 1);
		INSERT INTO guild_settings (guild_id, mod_role_id, banned_words_enabled) VALUES ('g2', NULL, 0);
		INSERT INTO role_menus (message_id, guild_id, channel_id, type) VALUES ('m1', 'g1', 'c1', 'dropdown');
		INSERT INTO role_menu_options (message_id, role_id, emoji, label) VALUES ('m1', 'r1', '🎲', 'Gamer');
	`);
	old.close();
}

test('migrates an old-schema database: drops type/emoji/label, adds descriptor', () => {
	seedOldSchema();
	const db = requireDbFresh();

	assert.ok(!columns(db, 'role_menus').includes('type'), 'role_menus.type was NOT NULL and had to go');
	assert.ok(!columns(db, 'role_menu_options').includes('emoji'));
	assert.ok(!columns(db, 'role_menu_options').includes('label'));
	assert.ok(columns(db, 'role_menu_options').includes('descriptor'));

	// The index referencing emoji has to be dropped first, or SQLite refuses.
	const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
	assert.ok(!indexes.includes('idx_role_menu_options_emoji'));

	// Existing rows survive the column drops.
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM role_menus').get().n, 1);
	assert.equal(db.prepare('SELECT role_id FROM role_menu_options WHERE message_id = ?').get('m1').role_id, 'r1');
});

test('inserts still work after the migration', () => {
	const db = requireDbFresh();
	// The point of dropping role_menus.type rather than ignoring it: nothing
	// populates it any more, so a NOT NULL column would break every insert.
	assert.doesNotThrow(() => {
		db.prepare('INSERT INTO role_menus (message_id, guild_id, channel_id) VALUES (?, ?, ?)').run('m2', 'g1', 'c1');
		db.prepare('INSERT INTO role_menu_options (message_id, role_id, descriptor) VALUES (?, ?, ?)').run('m2', 'r2', 'Ping for game nights');
	});
});

test('copies mod_role_id into guild_mod_roles and clears the column', () => {
	const db = requireDbFresh();
	const roles = db.prepare('SELECT role_id FROM guild_mod_roles WHERE guild_id = ?').all('g1').map((r) => r.role_id);
	assert.deepEqual(roles, ['legacy-mod-role']);
	assert.equal(db.prepare('SELECT mod_role_id FROM guild_settings WHERE guild_id = ?').get('g1').mod_role_id, null);
});

test('the mod-role migration is one-time: a removed role is not resurrected', () => {
	const db = requireDbFresh();
	// Simulates /setup mod-role remove on the role that came from the column.
	db.prepare('DELETE FROM guild_mod_roles WHERE guild_id = ? AND role_id = ?').run('g1', 'legacy-mod-role');

	const after = requireDbFresh();
	const roles = after.prepare('SELECT role_id FROM guild_mod_roles WHERE guild_id = ?').all('g1');
	assert.deepEqual(roles, [], 'nulling mod_role_id is what stops this rerunning every startup');
});

test('moves banned_words_enabled into guild_feature_toggles and drops the column', () => {
	const db = requireDbFresh();

	const rows = db.prepare("SELECT guild_id, enabled FROM guild_feature_toggles WHERE feature = 'bannedWords' ORDER BY guild_id").all();
	assert.deepEqual(rows, [{ guild_id: 'g1', enabled: 1 }, { guild_id: 'g2', enabled: 0 }]);

	assert.ok(!columns(db, 'guild_settings').includes('banned_words_enabled'), 'the old column has to go, or there are two sources of truth');
});

test('the banned-words move is one-time: a later change is not overwritten', () => {
	const db = requireDbFresh();

	// Simulates an admin switching it off after the migration ran. The mod-role
	// migration needed a follow-up UPDATE to avoid resurrecting a removed value;
	// here INSERT OR IGNORE plus the primary key is what prevents it, so this
	// test is what proves that reasoning rather than just asserting it.
	db.prepare("UPDATE guild_feature_toggles SET enabled = 0 WHERE guild_id = 'g1' AND feature = 'bannedWords'").run();

	const after = requireDbFresh();
	const row = after.prepare("SELECT enabled FROM guild_feature_toggles WHERE guild_id = 'g1' AND feature = 'bannedWords'").get();
	assert.equal(row.enabled, 0, 'a restart must not switch a feature back on behind the admin');
});

test('migrations are idempotent across repeated requires', () => {
	// Equivalent to restarting the bot several times.
	for (let i = 0; i < 3; i += 1) {
		assert.doesNotThrow(() => requireDbFresh(), `require #${i + 2} threw`);
	}

	const db = requireDbFresh();
	assert.ok(columns(db, 'role_menu_options').includes('descriptor'));
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM role_menus').get().n, 2);
});

test('PARIAHBOT_DB_FILE is what redirected all of this', () => {
	// Guards the override itself: if it silently stopped working, every test
	// above would be running against the real data/pariahbot.sqlite.
	const db = requireDbFresh();
	assert.equal(path.resolve(db.name), path.resolve(file));
});
