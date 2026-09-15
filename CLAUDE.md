# PariahBot

Discord bot built with Discord.js. Slash commands are loaded dynamically from `commands/`.

## State

All stateful data (anything that must survive a restart or be shared across events) lives in the SQLite database at `data/pariahbot.sqlite`, opened in `state/db.js`. No command or event handler should hold state in memory (module-level `Map`/`Set`/objects), in JSON files, or in any other on-disk format.

- Add new tables via `db.exec(...)` in `state/db.js`.
- Add a module under `state/` per logical domain (see `state/voiceChannels.js`, `state/guildSettings.js`) that wraps the table with prepared statements (`db.prepare(...)`) and exports plain functions — commands should never write raw SQL themselves.
- Use `INSERT ... ON CONFLICT DO UPDATE` for upsert-style settings, matching the pattern in `state/guildSettings.js`.
- Ephemeral, request-scoped values (e.g. a value only needed for the duration of one interaction) are fine as local variables — this rule is about anything that needs to persist or be looked up later.

### The one in-memory exception

`lib/autoDelete.js` keeps its list of live messages per channel in a module-level `Map`. That is deliberate, not an oversight: the list is a cache of state Discord already owns, rebuilt from channel history on startup rather than persisted. Storing it would create a second copy that drifts — a message someone deletes manually would linger in our table forever — whereas the cache just notices it's gone on the next reap. The per-channel *configuration* it works from (counts, durations) still lives in SQLite, in `state/autoDeleteChannels.js`.

Only reach for this pattern when Discord is genuinely the source of truth and the data is cheap to rebuild. Everything else goes in SQLite.

## Guild isolation

The bot runs in multiple servers against one shared database, so every feature has to stay scoped to the guild it was invoked from.

- Discord snowflakes (channel, message, role, user IDs) are globally unique, so a table keyed by one of those is already guild-safe.
- Discord's `channel`/`role`/`user` command option types are resolved against the invoking guild, so those values can be trusted.
- **String options are not.** A free-typed ID (even one backed by autocomplete) can name an entity in another server entirely — Discord does not enforce that a submitted value came from the suggestions. Anything looked up from a string option must be checked against `interaction.guildId`, either in the query (`WHERE ... AND guild_id = ?`, see `removeHub` in `state/voiceChannels.js`) or right after the lookup (see `requireMenu` in `commands/roles.js`).
