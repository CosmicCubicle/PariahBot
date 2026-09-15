# PariahBot

Discord bot built with Discord.js. Slash commands are loaded dynamically from `commands/`.

## State

All stateful data (anything that must survive a restart or be shared across events) lives in the SQLite database at `data/pariahbot.sqlite`, opened in `state/db.js`. No command or event handler should hold state in memory (module-level `Map`/`Set`/objects), in JSON files, or in any other on-disk format.

- Add new tables via `db.exec(...)` in `state/db.js`.
- Add a module under `state/` per logical domain (see `state/voiceChannels.js`, `state/guildSettings.js`) that wraps the table with prepared statements (`db.prepare(...)`) and exports plain functions — commands should never write raw SQL themselves.
- Use `INSERT ... ON CONFLICT DO UPDATE` for upsert-style settings, matching the pattern in `state/guildSettings.js`.
- Ephemeral, request-scoped values (e.g. a value only needed for the duration of one interaction) are fine as local variables — this rule is about anything that needs to persist or be looked up later.
