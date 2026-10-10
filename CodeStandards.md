# PariahBot Code Standards

How code is written, verified and shipped in this repo. These are the
conventions the existing code already follows. Where a rule exists because
something broke in production, the reason is given so the rule isn't
"simplified" away later.

The hard rules (state, guild isolation, destructive actions, fetching
user-supplied addresses safely, never publishing
a real bot instance) are in
[WorkingAgreements.md](WorkingAgreements.md). If the two ever disagree, WorkingAgreements.md wins and
this file should be fixed.

---

## 1. Environment and tooling

- **Node 24+**, **CommonJS** (`require` / `module.exports`). No ESM, no
  TypeScript, no build step.
- Import Node built-ins with the `node:` prefix: `require('node:fs')`,
  `require('node:crypto')`.
- Configuration comes from `hom.env`, loaded by `dotenv`. Any new variable goes
  into `.env.example` too, with a comment if it's optional. A missing entry
  there means `cp .env.example hom.env` produces an incomplete config.
- Run `npm run deploy` after changing any command's `data` definition. Set
  `GUILD_ID` while testing so registration is instant.
- **`better-sqlite3` is pinned on purpose** (see the comment in
  [state/db.js](state/db.js)). Don't bump it without first confirming the new
  version ships prebuilt binaries for the Node floor. The deploy host has no
  C/C++ toolchain.
- Production installs with `npm ci --omit=dev`. A dev-only audit advisory
  (for example in `nodemon`) is not a reason to run `npm audit fix --force`.
- Keep dependencies minimal. Before adding a package, check whether a few
  lines of code would do (the duration parser in `lib/autoDelete.js` is
  hand-written for this reason).

## 2. Formatting

There is no linter or formatter config, so match the existing style by hand:

- **Tabs** for indentation (JS, SQL inside template strings, and shell).
- **Single quotes.** Use double quotes only when the string contains an
  apostrophe (`"You're not..."`). Use template literals only for
  interpolation or multi-line SQL.
- **Semicolons**, and **trailing commas** on multi-line arrays, objects and
  argument lists.
- Always parenthesize arrow-function parameters: `(row) => row.user_id`.
- When an expression wraps, put the operator at the **start** of the
  continuation line (`|| await handler(...)`, `+ 'more text'`).
- Use numeric separators for large literals (`2_147_000_000`). Write
  durations as arithmetic (`5 * 60 * 1000`, `60 * 60`).
- Name module-level constants in `UPPER_SNAKE_CASE` (`EMBED_COLOR`,
  `CHALLENGE_TTL_MS`, `BUTTON_PREFIX`). Include the unit in the name when it
  isn't obvious (`_MS`, `_SECONDS`).
- Everything else is `camelCase` in JS and `snake_case` in SQL.

## 3. Where code goes

| Directory | Holds | Rules |
| --- | --- | --- |
| `commands/` | One module per slash command | Loaded automatically. Exports `{ data, execute }` plus an optional `autocomplete`. No raw SQL. |
| `events/` | One module per gateway event | Exports `{ name, once?, execute }`. Thin: delegates to `lib/`. |
| `lib/` | Feature logic shared by commands and events | Discord API work, component (button/select) handlers, scheduling. |
| `state/` | SQLite access | `db.js` owns the schema and migrations. One module per domain wraps its tables. |
| `logging/` | Command audit log | |
| `lib/dashboard/` | The admin dashboard's server, sign-in and JSON API | Reuses `state/` and `lib/`. Validation shared with a command lives in `lib/`, not in either. Every ID from the page is checked against its server. |
| `dashboard/` | The dashboard page | Static files only. Build the DOM with `textContent` (the page's `h()`), never `innerHTML`. |
| `deploy/` | Host setup (`setup.sh`) | Idempotent. Safe to re-run. |

When the same check appears in two places, move it into `lib/` (see
`lib/vcScope.js`, which replaced seven near-identical checks in `/vc`). A
module's name and location should match what it does. When settings moved
out of `state/voiceChannels.js` into `state/guildSettings.js`, it was because
they never belonged to voice.

## 4. Slash commands

Use [commands/autodelete.js](commands/autodelete.js) as the reference.

- Write one `handle<Subcommand>(interaction)` function per subcommand, and
  dispatch through a `HANDLERS` map. An unknown subcommand throws:

  ```js
  const HANDLERS = { set: handleSet, disable: handleDisable, status: handleStatus };
  // ...
  async execute(interaction) {
  	const subcommand = interaction.options.getSubcommand();
  	const handler = HANDLERS[subcommand];
  	if (!handler) throw new Error(`Unknown /autodelete subcommand: ${subcommand}`);
  	await handler(interaction);
  },
  ```

- **The permission check is the first line** of every admin handler:
  `requireAdmin(interaction);`.
- Start the description of every admin-only command and subcommand with
  `(Admin) `.
- **Report user errors by throwing.** Throw `new Error('...')` with a message
  written for the user. The central handler in
  [events/interactionCreate.js](events/interactionCreate.js) logs it, audits
  it and replies ephemerally. Don't hand-roll error replies in commands.
- **Error messages say how to fix the problem**, not just what's wrong:
  - Good: `"My highest role isn't above @Role — I can't grant it. Move my role above it in Server Settings → Roles."`
  - Not: `"Missing permissions."`
- Make admin and configuration replies **ephemeral** (`ephemeral: true`).
  Only post publicly for content meant for the channel.
- **Defer before slow work.** Discord's reply window is 3 seconds. If a
  handler fetches history, makes many API calls, or loops over members, call
  `await interaction.deferReply({ ephemeral: true })` *before* that work and
  finish with `editReply`. Missing this crashed production once (#11).
- Prefer Discord's typed option kinds (`channel`, `role`, `user`, `integer`
  with `setMinValue`/`setMaxValue`) over free strings. They're validated for
  you and resolved against the invoking guild (see §7).
- Pure actions are subcommands, not boolean flags. `/alerts test` fires on
  Enter. It doesn't need `test: true` typed in.
- Check preconditions up front. For example, verify the bot's role is above a
  role before storing a menu that grants it, rather than letting every later
  use fail with a confusing permissions error.

## 5. Events and component interactions

- Event modules stay thin and call into `lib/`. When order matters, say so in
  a comment (for example: honeypot runs before auto-delete tracking; alert
  infrastructure is set up before dead-hub notices are sent).
- **Background and event work is best-effort.** A failure in one feature must
  not crash the process or stop the next handler. Wrap it and log with a
  feature prefix:

  ```js
  await reapChannel(id).catch((error) => {
  	console.error(`AutoDelete: reap failed for channel ${id}:`, error.message);
  });
  ```

- **Any reply that is itself an error fallback** must be guarded with
  `.catch(() => null)`. The interaction token may already be dead, and an
  uncaught rejection there kills the bot.
- Wrap non-critical side effects (DMs, level-up announcements, editing an old
  message) in `.catch(() => null)`. A user with closed DMs is normal, not an
  error.
- **Buttons and select menus:**
  - Define each `customId` as a constant at the top of the owning `lib/`
    module. For new ones, prefer a namespaced `feature:action[:id]` form
    (`giveaway:enter:<id>`).
  - The handler returns `false` immediately when the `customId` isn't its own,
    and `true` once it has handled the interaction.
  - Register it in the `||` chain in `events/interactionCreate.js`.
  - Remember that a button can be clicked from a DM (alerts are DMed), where
    there is no `guild` or `member`. Resolve both by hand and **fail closed**
    if the clicker has left the server (see `lib/hubDesync.js`).
- **Gateway intents:** only non-privileged intents are used today. Building a
  feature differently to avoid a privileged intent is preferred; the captcha
  uses a persistent button instead of `guildMemberAdd`, and banned words use
  Discord AutoMod instead of reading message text, for this reason.
  Adding an intent needs a comment in `index.js` explaining what needs it.

## 6. State and the database

The rules in [WorkingAgreements.md § 1](WorkingAgreements.md#1-persistent-state-lives-in-sqlite) are mandatory. In short:
everything that persists lives in SQLite, not in module-level
`Map`/`Set`/objects or JSON files. The house style for `state/` modules
follows. Use [state/voiceChannels.js](state/voiceChannels.js) and
[state/guildSettings.js](state/guildSettings.js) as references.

**Statements**

- Prepare every statement once at module load, named with a `Stmt` suffix and
  declared directly above the function that uses it:

  ```js
  const deleteModRoleStmt = db.prepare('DELETE FROM guild_mod_roles WHERE guild_id = ? AND role_id = ?');

  function removeModRole(guildId, roleId) {
  	return deleteModRoleStmt.run(guildId, roleId).changes > 0;
  }
  ```

- Use named parameters (`@guildId`) for statements with more than two or
  three values.
- Upserts use `INSERT ... ON CONFLICT(...) DO UPDATE SET col = excluded.col`.
- Adds that are harmless to repeat use `INSERT OR IGNORE`.

**Return values**

- Map rows to **camelCase objects** before returning them (`mapHub`,
  `getGuildSettings`). Callers never see `snake_case` column names.
- Return `null`, not `undefined`, when nothing is found (`?? null`).
- Mutations that might not match a row return a boolean (`.changes > 0`) so
  the command can say "that wasn't set" instead of claiming success.
- Store booleans as `INTEGER 0/1` and convert with `!!` on the way out. Store
  timestamps as ISO-8601 `TEXT` (`new Date().toISOString()`). Store Discord
  IDs as `TEXT`.
- Name setters by intent: `setX`/`clearX`, `addX`/`removeX`/`listX`,
  `enableX`/`disableX`.

**Schema changes**

- New tables go in the `CREATE TABLE IF NOT EXISTS` block in `state/db.js`,
  with columns aligned.
- **Adding a column to an existing table needs a guarded `ALTER TABLE`**
  (`if (!hasColumn(...))`). `CREATE TABLE IF NOT EXISTS` does nothing on a
  live database, so editing only the `CREATE` statement silently breaks every
  existing install.
- Before dropping a column, drop any index that references it. SQLite refuses
  the `DROP COLUMN` otherwise.
- **Migrations must be idempotent *and* one-time.** A data migration that
  re-runs on every startup will undo admin choices (for example, re-adding a
  mod role someone removed). Clear the source after copying so a re-run is a
  no-op.
- Comment every non-obvious column. Cover sentinels (`0 means "not used"`),
  why a flag is "sticky", and why an FK is deliberately missing.
- Treat a configured value as the on/off switch where you can (a set
  `screening_channel_id` *is* "captcha is on"), rather than adding a separate
  `enabled` flag that can disagree with it.

## 7. Guild isolation

The bot runs in many servers against one database. Every lookup must stay
scoped to `interaction.guildId`.

- Options of type `channel`, `role` and `user` are already resolved against
  the invoking guild, so they're safe.
- **String options are not safe**, even with autocomplete. Anything looked up
  from a string ID must be checked against the guild, either in SQL
  (`WHERE id = ? AND guild_id = ?`) or immediately after the lookup:

  ```js
  if (!menu || menu.guildId !== interaction.guildId) throw new Error('...');
  ```

- Every per-guild table has a `guild_id` column, even when the primary key is
  a globally unique snowflake. This is what makes listing and scoped deletes
  possible.

## 8. Permissions

- Admin commands use `requireAdmin` from
  [lib/permissions.js](lib/permissions.js): Discord Administrator **or** any
  configured mod role. Plain Manage Channels is *not* enough.
- `isMod` (which accepts Manage Channels or a mod role) exists only for the
  narrower `/vc claim` ownership override. Don't use it to gate admin
  commands.
- Check permissions **live** from the member's current roles. Don't cache
  them per user or per channel.
- The bot's role must be above any role it grants or anyone it removes. Check
  this up front and name the fix in the error.
- The wiki's [Permissions](https://github.com/CosmicCubicle/PariahBot/wiki/Permissions)
  page is the one place that lists every permission and intent, which
  feature uses each, and who can run each command. It has two permission
  sets: **Recommended** (the standard invite) and **Required** (the ones the
  code actually uses). If a feature needs a new bot permission:
  - add it to the **Required** table and the **By feature** table, with the
    feature that needs it
  - make sure the **Recommended** set includes it too
  - recalculate both invite numbers on the
    [Bot Setup](https://github.com/CosmicCubicle/PariahBot/wiki/Bot-Setup) page
- The bot's permissions belong on its own **PariahBot** role, the one the
  invite creates. Never ask server admins to give it a shared "Bots" role
  instead.

## 9. Destructive actions

[lib/honeypot.js](lib/honeypot.js) and [lib/moderation.js](lib/moderation.js)
are the **only** code paths that ban or kick. If you add another, it has to
follow the same invariants and be recorded in WorkingAgreements.md:

1. **Admins and mod-role members are always skipped**, checked before any
   removal.
2. **DM before removing**, best-effort. After a ban the bot can't open a DM.
3. Pass a `reason` on every moderation API call, so the server's audit log
   explains itself.
4. Report the outcome through `sendAlert`, including failures.

Channel and permission-overwrite changes that lock things down must also say
how to undo them in the reply. Make sure the bot can't lock *itself* out: it
can only set a permission bit it already holds (see
`ensureBotRetainsConnect` in `commands/vc.js`).

## 10. Discord presentation

- Embed colors are module constants from the Discord palette:
  - `0x5865f2` (blurple): informational
  - `0x57f287` (green): success
  - `0xed4245` (red): warnings, alerts, failures
  - `0xf1c40f` (yellow): giveaways
  - `0x9146ff` (Twitch purple): Twitch alerts
  - `0xff0033` (YouTube red): YouTube alerts
  - `0xe1306c` (Instagram pink): Instagram alerts
  - `0xf26522` (RSS orange): RSS feed items
- Discord's limits are real and they throw when exceeded: embed field names
  ≤ 256 characters, values ≤ 1024, ≤ 25 select-menu options. Put
  growing content in field *values*, and check counts before adding.
- Use Discord timestamp markup (`<t:unix:F>`) for times, so each viewer sees
  their own timezone.
- Use `crypto.randomInt` from `node:crypto` for anything a user could
  benefit from predicting (winners, XP, challenges), not `Math.random`.

## 11. Comments

Comments in this repo explain **why**, not what. Write one when:

- The code looks wrong or over-complicated but is deliberate (the pinned
  dependency, the missing FK, the in-memory `Map`).
- Order matters (DM before ban, defer before fetch).
- An alternative was considered and rejected, so nobody "fixes" it back.
- Another file has to be kept consistent with this one. Reference it by path:
  `see lib/autoDelete.js`, `see commands/voice.js's handleRemove`.

Mark the one guard that must never be removed explicitly in the code (see
the admin skip in `lib/honeypot.js`). Don't add comments that restate the
code.

## 12. Documentation that ships with a change

A feature isn't done until the docs match it:

- **README:** the features list and the command table (new command or
  subcommand).
- **Wiki:** detailed setup, the full command reference, bot permissions,
  troubleshooting.
- **Every docs update checks the wiki's Permissions page** against the
  change, not just changes that obviously touch permissions. Update it when
  a change:
  - adds or removes a permission or gateway intent
  - moves a feature onto a different permission
  - adds a feature or command
  - changes who can run a command

  Say in the PR description that it was checked. The wiki is a separate repo, so push it alongside the PR
  and say so in the PR description.
- **WorkingAgreements.md / ProjectContext.md:** any new invariant, any new exception to the state rule, and
  any new destructive path.
- **`.env.example`:** any new environment variable.
- **Code comments** that point at the README or wiki must still resolve
  after a docs move.

## 13. Verification

There is no automated test suite (`npm test` is a placeholder), so
verification is manual. The PR description must say what was checked.

- Start the bot and confirm every command loads and `npm run deploy`
  succeeds.
- Exercise the change **against a real Discord server**, not just by reading
  the code. Buttons must render and work end to end.
- For schema migrations, run against a copy of a database with the **old**
  schema (including its indexes and constraints). Then **restart a second
  time** to prove the migration is one-time and doesn't undo later changes.
- For permission or isolation changes, try the abuse case: a free-typed ID
  from another guild, or a non-admin invoking an admin command.
- For dependency bumps, run `npm audit --omit=dev` and do one real API round
  trip.

## 14. Git and pull requests

- **Every piece of work starts with a GitHub issue.** Open one first if it
  doesn't exist yet.
- **Branch names follow `<type>_Issue<N>_<description>`:**
  - `<type>` is `feature` (new behavior), `fix` (a bug) or `maintain` (docs,
    dependencies, tooling, refactors).
  - `<N>` is the open issue the work is for.
  - `<description>` is a few words joined with hyphens. Git doesn't allow
    spaces.

  For example: `feature_Issue17_streamer-alerts`, `fix_Issue12_slash-ban-perms`,
  `maintain_Issue26_require-linked-issues`.

  GitHub enforces this in two places:
  - The `BranchNamingConvention` ruleset refuses to create a branch with any
    other name.
  - The required **Linked issue** check (in
    [.github/workflows/linked-issue.yml](.github/workflows/linked-issue.yml))
    fails a PR whose branch doesn't name an existing, open issue.
- **PRs link to their issue automatically.** The Linked issue check adds
  `Closes #N` to the PR description if it isn't already there, which puts the
  issue in the PR's Development panel and closes it on merge. It also posts a
  comment on the issue linking back to the PR. Every PR closes its issue when
  merged, so if the work needs several PRs, split it into several issues.
- Branch from `main` and open a PR. Changes are **squash-merged**, so the PR
  title becomes the commit subject (`... (#N)`).
- [CODEOWNERS](.github/CODEOWNERS) review is required.
- **Subject:** imperative mood, says what changed for the user ("Add
  /security: member verification captcha and honeypot", "Scope hub removal
  to the acting guild").
- **Body:** wrapped prose explaining:
  - **why** the change was needed (link the incident or bug if there was one)
  - what changed, file by file where it helps
  - **what was verified and how**
  - **what was deliberately left out, and why**
- Keep each commit to one logical change. Fold a fix found during review into
  the PR as its own commit with its own explanation.
- AI-assisted commits keep their `Co-Authored-By:` trailer.
- Never commit `hom.env`, `data/`, `logs/` or `sync.log` (they're already in
  `.gitignore`).

## 15. Known deviations in current code

Code that doesn't meet the standards above, and why. Don't copy it into new
code. If you find more, add it here, and fix it when you're next working in
that area.

- **`customId` formats** are mixed (`securityVerifyStart`,
  `voice-hub-prune`, `giveaway:enter:`). Existing ones can't be renamed
  without breaking messages already posted, so leave them. New ones follow
  §5.
