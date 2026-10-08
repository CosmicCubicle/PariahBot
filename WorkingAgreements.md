# PariahBot Working Agreements

Rules for anyone changing this repo, whether a person or an AI tool. Each
rule comes with **why** it exists and **how to apply** it, so edge cases can
be judged on purpose rather than by the letter.

These are the hard rules. Day-to-day style and process live in
[CodeStandards.md](CodeStandards.md). If the two ever disagree, this file
wins and CodeStandards.md should be fixed.

---

## 1. Persistent state lives in SQLite

Anything that must survive a restart, or be shared across events, lives in
the SQLite database at `data/pariahbot.sqlite`, opened in
[state/db.js](state/db.js). No command or event handler holds state in
module-level `Map`/`Set`/objects, in JSON files, or in any other on-disk
format.

**Why:** the bot restarts often (deploys, the auto-update sync job, systemd
recovering from a crash). In-memory state is lost on every restart, and
side files drift from the database.

**How to apply:**

- Add new tables with `db.exec(...)` in `state/db.js`.
- Add a module under `state/` for each logical domain that wraps its tables
  with prepared statements (`db.prepare(...)`) and exports plain functions.
  See [state/voiceChannels.js](state/voiceChannels.js) and
  [state/guildSettings.js](state/guildSettings.js).
- Commands never write raw SQL.
- Use `INSERT ... ON CONFLICT DO UPDATE` for upsert-style settings, matching
  `state/guildSettings.js`.
- Short-lived values needed only for one interaction are fine as local
  variables. This rule is about anything that has to persist or be looked up
  later.

### The one in-memory exception

[lib/autoDelete.js](lib/autoDelete.js) keeps its list of live messages per
channel in a module-level `Map`. This is deliberate.

**Why:** Discord already owns that data, and the list is just a cache of it,
rebuilt from channel history on startup. Storing it would create a second
copy that drifts. A message someone deletes by hand would stay in our table
forever, whereas the cache simply notices it's gone at the next cleanup
pass. The per-channel *configuration* (counts, durations) still lives in
SQLite, in [state/autoDeleteChannels.js](state/autoDeleteChannels.js).

**How to apply:** use this pattern only when Discord is genuinely the source
of truth and the data is cheap to rebuild. Everything else goes in SQLite.
Any new exception has to be added here, with its reasoning.

### The Twitch app token

[lib/twitch.js](lib/twitch.js) keeps its Twitch API access token in a
module-level variable.

**Why:** it's a credential Twitch issues on demand, so a restart just
requests a fresh one. Saving it would mean writing a live secret into the
database file, where anyone who can read the file could use it. Who has
already been announced (`last_stream_id`) is real state, so it *is* stored,
in `streamer_links`.

**How to apply:** this covers short-lived credentials that the issuing
service can always replace. It doesn't cover anything the bot itself
decides or would need to remember.

> `lib/captcha.js` currently also keeps a module-level `Map`
> (`pendingChallenges`). It isn't recorded as an exception yet. See
> [CodeStandards.md § 15](CodeStandards.md#15-known-deviations-in-current-code).

## 2. Stay scoped to the invoking guild

The bot runs in many servers against one shared database (see
[ProjectContext.md](ProjectContext.md)). Every feature must stay scoped to
the guild it was invoked from.

**Why:** a lookup that isn't scoped lets one server's admin read or change
another server's configuration. `/voice remove` once let an admin unregister
a hub belonging to a different server.

**How to apply:**

- Discord IDs (channel, message, role, user) are globally unique, so a table
  keyed by one of them is already guild-safe.
- Discord's `channel`/`role`/`user` command option types are resolved against
  the invoking guild, so those values can be trusted.
- **String options cannot be trusted.** A typed-in ID, even one offered by
  autocomplete, can name something in another server entirely. Discord does
  not check that a submitted value came from the suggestions. Check anything
  looked up from a string option against `interaction.guildId`, in one of
  two ways:
  - in the query (`WHERE ... AND guild_id = ?`), like `removeHub` in
    [state/voiceChannels.js](state/voiceChannels.js)
  - right after the lookup, like `requireMenu` in
    [commands/roles.js](commands/roles.js)

## 3. Never let the bot remove its own moderators

[lib/honeypot.js](lib/honeypot.js) is the only code path that bans or kicks
anyone. Every change to it must keep the admin and mod-role skip check
(`isAdmin` from [lib/permissions.js](lib/permissions.js)) ahead of the
removal.

**Why:** a moderator who wanders into the trap channel must never be removed
by their own bot.

**How to apply:** any new code that removes members follows the same rule,
and is added to this section and to
[ProjectContext.md § 4](ProjectContext.md#4-destructive-actions).

## 4. DM before removing

When the bot removes someone, the notification DM goes out *before* the ban
or kick. The DM itself is best-effort.

**Why:** once a user is banned, the bot can't open a DM channel with them.
A user with closed DMs is normal, so a failed DM must not block the removal.

**How to apply:** send the DM first, wrap it in `.catch(() => null)`, and
then remove the user.
