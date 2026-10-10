const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// state/db.js resolves PARIAHBOT_DB_FILE once, at require time, and caches the
// connection in the module registry. So this must run BEFORE anything requires
// a state/ module — hence the call at the top of each DB-backed test file,
// above its requires. `node --test` gives each file its own process, so files
// don't fight over the variable.
function useTempDb(label) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pariahbot-test-${label}-`));
	const file = path.join(dir, 'test.sqlite');
	process.env.PARIAHBOT_DB_FILE = file;
	return { dir, file };
}

module.exports = { useTempDb };
