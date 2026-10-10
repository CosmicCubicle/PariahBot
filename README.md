# PariahBot

PariahBot is a self-hosted Discord bot that consolidates several single-purpose
bots into one: temporary voice channels, self-service role menus, message
auto-deletion, anti-spam, banned words, giveaways, activity levels, Twitch and YouTube
alerts, Instagram post alerts, and admin alerting. Built
with Discord.js, it loads slash commands dynamically and keeps all per-server
state in a local SQLite database.

📖 **[Full documentation is in the wiki](https://github.com/CosmicCubicle/PariahBot/wiki)** —
setup, configuration, per-server walkthroughs and troubleshooting.

## Features

- **Temporary voice channels** — join-to-create hubs, owner self-service controls (`/vc`), automatic cleanup when a channel empties, and detection/recovery for hubs whose channel was deleted.
- **Self-service role menus** — admins publish a dropdown; members open a personal, pre-checked menu and pick their own roles.
- **Member verification (captcha)** — new members pick a specific option from a randomized dropdown in a screening channel; passing grants them the member role. Optionally gates the rest of the server behind verification.
- **Honeypot** — a trap channel that removes anyone who posts in it (softban by default, or ban), with admins and mod roles always skipped.
- **Banned words** — blocks messages containing words from ready-made lists (Discord's profanity, sexual content and slur lists, plus scams, harassment and drugs) and the server's own custom words, using Discord AutoMod, so nobody sees them. Each block is reported through the admin alerts. Needs the bot to have Manage Server.
- **Message auto-deletion** — per channel, on a rolling basis: each message is deleted after a set age, or once a set number of newer messages exist, whichever comes first. Pinned messages are never deleted.
- **Giveaways** — timed giveaways that members enter with a button, with winners drawn automatically when they end.
- **Activity levels** — XP from messages, with `/level rank` and a server leaderboard.
- **Twitch and YouTube alerts** — members with the streamer role link their own Twitch or YouTube channel, and admins can add any channel directly (no role needed). The bot posts an alert, optionally pinging a role, when any of them goes live, and when a YouTube channel uploads a new video. Each platform needs its API credentials in `hom.env`.
- **Instagram post alerts** — admins follow any number of public Instagram Business or Creator accounts, and the bot shares each new post and reel in a dedicated channel, optionally pinging a role. Needs a Meta System User token in `hom.env`; see the wiki's [Instagram Alerts](https://github.com/CosmicCubicle/PariahBot/wiki/Instagram-Alerts) page.
- **Per-server role configuration** — member, mod (any number), and streamer roles, each settable to an existing role or created on the spot.
- **Admin alerts** — routed to a channel and/or DMs, with an auto-provisioned default channel per server.
- **Command audit log** — human-readable log at `logs/commands.log`, optionally mirrored to Discord channels.

All per-server data is stored in SQLite (`data/pariahbot.sqlite`) and scoped by
guild, so one server's configuration never affects another's.

## Quick start

Requires **Node.js 24+** and a Discord application (token + application ID).

```bash
git clone https://github.com/CosmicCubicle/PariahBot.git
cd PariahBot
npm install
cp .env.example hom.env     # then fill in DISCORD_TOKEN and CLIENT_ID
npm run deploy              # register slash commands
npm start
```

Deploying to a Linux host with `systemd` instead:

```bash
sudo ./deploy/setup.sh
```

Both paths are covered in detail in the wiki:

- **[Bot Setup](https://github.com/CosmicCubicle/PariahBot/wiki/Bot-Setup)** — Discord application, permissions, invite link
- **[Permissions](https://github.com/CosmicCubicle/PariahBot/wiki/Permissions)** — every permission the bot needs and which feature it's for
- **[Host Installation](https://github.com/CosmicCubicle/PariahBot/wiki/Host-Installation)** — `systemd` deployment and the optional auto-update job
- **[Configuration](https://github.com/CosmicCubicle/PariahBot/wiki/Configuration)** — every `hom.env` variable
- **[Server Configuration](https://github.com/CosmicCubicle/PariahBot/wiki/Server-Configuration)** — configuring the bot inside Discord, in a working order
- **[Banned Words](https://github.com/CosmicCubicle/PariahBot/wiki/Banned-Words)** — the lists, custom words, exemptions and reporting
- **[Streamer Alerts](https://github.com/CosmicCubicle/PariahBot/wiki/Streamer-Alerts)** — Twitch and YouTube credentials and setup
- **[Instagram Alerts](https://github.com/CosmicCubicle/PariahBot/wiki/Instagram-Alerts)** — the Meta app, System User token and setup
- **[Troubleshooting](https://github.com/CosmicCubicle/PariahBot/wiki/Troubleshooting)** — when something silently does nothing

> ⚠️ **Two things that trip up most setups:** the bot's role must sit **above**
> any role it hands out, and `GUILD_ID` in `hom.env` restricts commands to a
> single server — leave it empty to register globally.

## Commands

**(Admin)** requires Discord's Administrator permission or membership in a mod
role (`/setup mod-role add`). Manage Channels alone is not sufficient.

| Command | Description |
| --- | --- |
| `/help` | Lists every currently registered command and its options. |
| `/ping` | Reports bot and Discord API latency. |
| `/level` | `rank` for your (or someone's) level and XP, `leaderboard` for the server top 10. |
| `/vc` | Controls for the temporary voice channel you currently own: `name`, `limit`, `lock`, `unlock`, `kick`, `claim`, `transfer`. |
| `/voice` | (Admin) Voice hub management: `add`, `create`, `remove`, `list`, `audit`, `disable-owner-kick`, `enable-owner-kick`. |
| `/roles` | (Admin) Dropdown role menus: `dropdown create`, `dropdown add-role`, `dropdown remove-role`, `list`, `apply-channel-defaults`. |
| `/setup` | (Admin) Server roles: `member-role`, `mod-role` (`add`, `remove`, `list`, `clear`), `streamer-role`. |
| `/security` | (Admin) Anti-spam: `captcha setup`/`disable`, `honeypot setup`/`disable`, `status`. The verification itself is open to everyone. |
| `/bannedwords` | (Admin) Banned words via Discord AutoMod: `enable`, `disable`, `list add`/`remove`, `word add`/`remove`, `status`. |
| `/autodelete` | (Admin) Per-channel message auto-deletion: `set`, `disable`, `status`. |
| `/alerts` | (Admin) Where admin alerts go: `channel`, `add-recipient`, `remove-recipient`, `remove-default`, `restore-default`, `test`, `status`. |
| `/streamers` | Twitch and YouTube live and upload alerts. Members with the streamer role: `link`, `unlink`. (Admin): `add`, `channel`, `disable`, `remove`, `list`. |
| `/instagram` | (Admin) Instagram post alerts in a dedicated channel: `add`, `channel`, `disable`, `remove`, `list`. |
| `/giveaway` | (Admin) `create` a timed giveaway, or `end` one early. Members enter from the posted button. |

Full subcommand and option reference:
**[Commands](https://github.com/CosmicCubicle/PariahBot/wiki/Commands)**.

Add new command modules to `commands/` — they're picked up automatically. Run
`npm run deploy` after changing any command definition.

## Project layout

| Path | Contents |
| --- | --- |
| `commands/` | One module per slash command; loaded automatically at startup. |
| `events/` | Discord gateway event handlers (interactions, messages, voice state, ready). |
| `lib/` | Feature logic shared between commands and events. |
| `state/` | SQLite access — `db.js` owns the schema, one module per domain. |
| `logging/` | Command audit logging. |
| `deploy/` | Host setup script. |

## Contributing

Contributions are welcome, from people and from AI tools alike. The same
rules apply to both.

### Read first

| File | What it covers |
| --- | --- |
| [WorkingAgreements.md](WorkingAgreements.md) | The hard rules: state lives in SQLite, every lookup stays scoped to its server, the safeguards on banning and kicking, and never publishing a real bot instance's invite link. These override everything else. |
| [CodeStandards.md](CodeStandards.md) | How code is written, structured, verified and shipped. |
| [ProjectContext.md](ProjectContext.md) | What the bot is, the constraints it runs under, and past decisions. |
| [Team.md](Team.md) · [References.md](References.md) | Who maintains the repo, and which existing files to copy from. |

AI tools pick these up through [AGENTS.md](AGENTS.md).

### Workflow

1. **Open an issue** describing the work, or pick an existing open one.
   Every branch and PR has to trace back to an issue.
2. **Create a branch** from `main` named `<type>_Issue<N>_<description>`:

   | Type | Use for |
   | --- | --- |
   | `feature` | New behaviour |
   | `fix` | A bug |
   | `maintain` | Docs, dependencies, tooling, refactors |

   `<N>` is the issue number, and `<description>` is a few words joined with
   hyphens (Git doesn't allow spaces). For example:
   `feature_Issue17_streamer-alerts`.

   GitHub refuses to create a branch with any other name.
3. **Make the change, following the standards above.**
   - There's no automated test suite, so check your change against a real
     Discord server (see CodeStandards.md § 13).
   - Update the README command table, the wiki and `.env.example` if what
     you changed affects them.
4. **Open a PR into `main`.** Linking is automatic:
   - `Closes #N` is added to the description, so the issue appears in the
     PR's Development panel and closes when the PR merges.
   - A comment linking to the PR is posted on the issue.

   If the work needs several PRs, split it into several issues.
5. **Describe the change in the PR:** why it was needed, what changed, how
   you verified it, and anything you deliberately left out.

### Merge requirements

A PR can merge into `main` only when all of these pass:

- **Linked issue check:** the branch name follows the format and names an
  existing, open issue.
- **Code owner review:** one approval from a
  [code owner](.github/CODEOWNERS), with every review thread resolved.
- **CodeQL:** no code-scanning errors, and no security alerts rated high or
  above.

PRs are **squash-merged**, so the PR title becomes the commit message on
`main`. Write it in the imperative ("Add …", "Fix …").

Full details are in
[CodeStandards.md § 14](CodeStandards.md#14-git-and-pull-requests).
