# PariahBot

PariahBot is a small Discord bot foundation built with Discord.js. It dynamically loads slash commands, records command activity locally, and can optionally post command logs to Discord channels.

## Features

- Dynamic slash-command loading from `commands/`.
- `/help` generated from the commands currently registered with the bot.
- `/ping` for bot and Discord API latency.
- Human-readable command audit log at `logs/commands.log`.
- Optional Discord channels for successful and failed command logs.
- Optional systemd deployment with periodic GitHub synchronization.

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

`LOG_CHANNEL_ID` is used for both successful and failed commands unless the more specific success or error channel is set. The bot needs permission to view and send messages in configured channels.

## Discord Application Setup

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Create its bot and copy the token into `DISCORD_TOKEN`.
3. Copy the application ID into `CLIENT_ID`.
4. Add the `bot` and `applications.commands` scopes when installing it in a server.
5. Give it permission to view channels, send messages, embed links, attach files, and read message history.

The bot only requests the Guilds gateway intent, so no privileged gateway intents are required.

## Commands

| Command | Description |
| --- | --- |
| `/help` | Lists every currently registered command and its options. |
| `/ping` | Reports bot and Discord API latency. |

Add new command modules to `commands/`. Run `npm run deploy` after changing command definitions.

## Host Installation

The deployment scripts target a Linux host using `systemd` and install the bot at `/opt/PariahBot`:

```bash
git clone https://github.com/CosmicCubicle/PariahBot.git
cd PariahBot
sudo ./deploy/install-host.sh
```

Run onboarding after installation:

```bash
/opt/PariahBot/deploy/onboard.sh
```

The installer creates `hom.env` from `.env.example`, installs Node.js 24 with `nvm`, installs production dependencies, registers `pariahbot.service`, and schedules the GitHub sync script every 15 minutes.

Useful operations:

```bash
sudo systemctl status pariahbot.service
sudo systemctl restart pariahbot.service
sudo journalctl -u pariahbot.service -f
tail -f /opt/PariahBot/logs/commands.log
```

To sync immediately instead of waiting for the scheduled job:

```bash
/opt/PariahBot/deploy/sync-pariahbot.sh
```
