# PariahBot

PariahBot is a self-hosted Discord bot that consolidates several single-purpose bots into one: temporary voice channels, self-service role menus, per-channel message auto-deletion, and admin alerting. It is built with Discord.js, loads slash commands dynamically, and keeps all per-server state in a local SQLite database.

## Features

- **Temporary voice channels** — join-to-create hubs, owner self-service controls (`/vc`), automatic cleanup when a channel empties, and detection/recovery for hubs whose channel was deleted.
- **Self-service role menus** — admins publish a dropdown; members open a personal, pre-checked menu and pick their own roles.
- **Message auto-deletion** — per channel, on a rolling basis: each message is deleted after a set age, or once a set number of newer messages exist, whichever comes first. Pinned messages are never deleted.
- **Per-server role configuration** — member, mod (any number), and streamer roles, each settable to an existing role or created on the spot.
- **Member verification (captcha)** — new members pick a specific option from a randomized dropdown in a screening channel; passing grants them the server's member role. Optionally gates the rest of the server behind verification.
- **Honeypot** — a trap channel that removes anyone who posts in it (softban by default, or ban), with admins and mod roles always skipped.
- **Admin alerts** — routed to a channel and/or DMs, with an auto-provisioned default channel per server.
- **Command audit log** — human-readable log at `logs/commands.log`, optionally mirrored to Discord channels.
- Dynamic slash-command loading from `commands/`, with `/help` generated from whatever is currently registered.
- Optional `systemd` deployment with periodic GitHub synchronization.

All per-server data is stored in SQLite (`data/pariahbot.sqlite`) and scoped by guild, so one server's configuration never affects another's.

## Requirements

- Node.js 24 or newer (LTS).
- A Discord application with a bot token and application ID.
- A guild ID is optional, but makes command registration immediate for one test server.
- `better-sqlite3` is pinned to `12.11.1` in `package.json` — the last release with a prebuilt binary; 13.0.0+ compiles from source on every install instead. If the Node requirement above is ever raised, re-check that package's GitHub releases for a version whose prebuilds cover the new minimum before bumping it (see the comment in `state/db.js`).

## Local Setup

Install dependencies and copy the example environment file:

```bash
npm install
cp .env.example hom.env
```

Set `DISCORD_TOKEN`, `CLIENT_ID`, and optionally `GUILD_ID` in `hom.env`, then register commands and start the bot:

```bash
npm run deploy
npm start
```

Keep `hom.env` private. It is ignored by Git and should have mode `600` on Linux hosts.

## Configuration

```dotenv
DISCORD_TOKEN=your-bot-token
CLIENT_ID=your-application-id
GUILD_ID=your-test-server-id
LOG_CHANNEL_ID=
LOG_CHANNEL_SUCCESS_ID=
LOG_CHANNEL_ERROR_ID=
```

The three `LOG_CHANNEL_*` values are optional. `LOG_CHANNEL_ID` is used for both successful and failed commands unless the more specific success or error channel is set. The bot needs permission to view and send messages in configured channels.

Everything else — alert destinations, voice hubs, role menus, auto-delete settings, mod roles — is configured per server through slash commands, not environment variables.

## Discord Application Setup

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Create its bot and copy the token into `DISCORD_TOKEN`.
3. Copy the application ID into `CLIENT_ID`.
4. Add the `bot` and `applications.commands` scopes when installing it in a server.
5. Give it these permissions:
   - View Channels, Send Messages, Embed Links, Attach Files, Read Message History (baseline).
   - Manage Channels and Move Members (temporary voice channels).
   - Manage Roles (role menus and the verification captcha — the bot's own role must also sit **above** any role it hands out).
   - Manage Messages (auto-deletion).
   - Ban Members (the `/security` honeypot — needed even for its default "remove", which is a softban).

The bot requests the Guilds, Guild Voice States (temporary voice channels), and Guild Messages (auto-deletion) gateway intents. None are privileged, so no Developer Portal toggles are required.

## Commands

| Command | Description |
| --- | --- |
| `/help` | Lists every currently registered command and its options. |
| `/ping` | Reports bot and Discord API latency. |
| `/vc` | Controls for the temporary voice channel you currently own: `name`, `limit`, `lock`, `unlock`, `kick`, `claim`, `transfer`. |
| `/voice` | (Admin) Voice hub management: `add`, `create`, `remove`, `list`, `audit`, `disable-owner-kick`, `enable-owner-kick`. |
| `/roles` | (Admin) Dropdown role menus: `dropdown create`, `dropdown add-role`, `dropdown remove-role`, `list`, `apply-channel-defaults`. |
| `/setup` | (Admin) Server roles: `member-role`, `mod-role` (`add`, `remove`, `list`, `clear`), `streamer-role`. |
| `/autodelete` | (Admin) Per-channel message auto-deletion: `set`, `disable`, `status`. |
| `/security` | (Admin) Anti-spam: `captcha setup`/`disable`, `honeypot setup`/`disable`, `status`. The verification itself is open to everyone. |
| `/alerts` | (Admin) Where admin alerts go: `channel`, `add-recipient`, `remove-recipient`, `remove-default`, `restore-default`, `test`, `status`. |

Add new command modules to `commands/`. Run `npm run deploy` after changing command definitions.

### Permissions

Commands marked (Admin) require either Discord's **Administrator** permission or membership in one of the server's mod roles (`/setup mod-role add`). Manage Channels alone is not sufficient.

`/vc` is the exception — it is owner self-service, gated by whether you currently own the temporary voice channel you are connected to. `/vc claim` additionally lets Manage Channels holders and mod-role members take a channel from a non-mod owner.

### Typical first-time server setup

```
/setup mod-role add role:@Moderators
/setup member-role role:@Members
/voice create name:➕ Join to Create
/roles dropdown create channel:#roles role:@Gamer descriptor:Ping for game nights
/autodelete set channel:#spam duration:24h count:100
/security captcha setup adjust_visibility:true
/security honeypot setup
```

### Anti-spam (`/security`)

**Captcha.** `/security captcha setup` posts a verification message in a
screening channel (created for you, or pass `channel:` to use an existing one).
A member presses **Start verification** and is privately asked to pick one
specific option from a dropdown — which option is correct is randomized per
person, so a bot can't pass by blindly clicking the only thing on screen.
Passing grants the member role.

It **requires a member role to already be set** (`/setup member-role`) — that's
the role it hands out, so setup refuses without one and tells you how to fix
it. It also checks the bot's own role sits above it, since otherwise every
verification would fail.

`adjust_visibility: true` additionally removes `View Channels` from
`@everyone` and grants it to the member role, so unverified members see only
the screening channel. That's a server-wide change, so it's off by default and
the bot tells you exactly what it altered. Undo it by giving `@everyone`
`View Channels` back in Server Settings → Roles.

**Honeypot.** `/security honeypot setup` designates a trap channel and posts a
warning in it. Anyone who posts there is removed — by default a *softban*
(banned then immediately unbanned, so Discord deletes their recent messages but
they can rejoin), or `action: ban` to ban outright. Admins and mod-role members
are always skipped, so you can check on the channel safely. Every action is
reported through `/alerts`.

## Host Installation

`deploy/setup.sh` targets a Linux host running `systemd` and installs the bot at `/opt/PariahBot`. Run it with `sudo` from your normal (non-root) user — that user becomes the account the bot runs under:

```bash
git clone https://github.com/CosmicCubicle/PariahBot.git
cd PariahBot
sudo ./deploy/setup.sh
```

The script:

1. Installs system packages (`build-essential`, `ca-certificates`, `curl`, `ffmpeg`, `git`, `python3`).
2. Copies the repo to `/opt/PariahBot` (when run from elsewhere) and gives it to the invoking user.
3. Installs Node.js 24 via `nvm` and production dependencies (`npm ci --omit=dev`).
4. Creates `/opt/PariahBot/hom.env` from `.env.example` on first run (mode `600`), then prompts for the bot token, application ID, and guild ID. The token prompt is hidden, and rerunning keeps existing values unless you enter new ones.
5. Registers and enables `pariahbot.service`.
6. Offers to install the Git sync job described below.
7. Registers the slash commands and starts the service.

Rerunning it is safe — existing configuration is preserved and each step is idempotent.

### Git sync job

Answering yes to the cron prompt installs `/usr/local/sbin/pariahbot-sync` plus a narrowly scoped sudoers rule (`/etc/sudoers.d/pariahbot-sync`, allowing only `systemctl restart pariahbot.service`) and schedules it every 15 minutes. Each run fetches the tracked branch and, only if the remote moved, hard-resets to it, reinstalls dependencies when `package-lock.json` changed, re-registers commands when `commands/` changed, and restarts the service. Output is appended to `/opt/PariahBot/sync.log`.

Answering no removes both files if they already exist.

To sync immediately instead of waiting for the schedule, run it as the bot user:

```bash
/usr/local/sbin/pariahbot-sync
```

### Useful operations

```bash
sudo systemctl status pariahbot.service
sudo systemctl restart pariahbot.service
sudo journalctl -u pariahbot.service -f
tail -f /opt/PariahBot/logs/commands.log
tail -f /opt/PariahBot/sync.log
```

## Project Layout

| Path | Contents |
| --- | --- |
| `commands/` | One module per slash command; loaded automatically at startup. |
| `events/` | Discord gateway event handlers (interactions, messages, voice state, ready). |
| `lib/` | Feature logic shared between commands and events. |
| `state/` | SQLite access — `db.js` owns the schema, one module per domain. |
| `logging/` | Command audit logging. |
| `deploy/` | Host setup script. |

See `CLAUDE.md` for the conventions to follow when adding to any of these.
