# PariahBot Project Context

What this project is, the constraints it runs under, and decisions that
can't be worked out from the code alone. Read this before making design
choices. The rules that follow from it are in
[WorkingAgreements.md](WorkingAgreements.md).

---

## 1. What PariahBot is

PariahBot is a self-hosted Discord bot built with Discord.js. It replaces
several single-purpose bots with one:

- temporary voice channels
- role menus
- message auto-deletion
- anti-spam (captcha and honeypot)
- giveaways
- activity levels
- Twitch go-live alerts
- admin alerts

Slash commands are loaded automatically from `commands/`.

The bot only calls one outside service: Twitch's API, for go-live alerts.
That feature is optional and stays off unless the host sets Twitch
credentials. It polls Twitch every minute rather than using Twitch's
push notifications (EventSub), because those need a public HTTPS address
that a self-hosted bot usually doesn't have.

Several features are modeled on existing open-source bots, and the
differences from them are deliberate. See [References.md](References.md).

## 2. One database, many servers

The bot runs in multiple Discord servers against one shared SQLite database.

**Why it matters:** every feature has to stay scoped to the server it was
invoked from. See
[WorkingAgreements.md § 2](WorkingAgreements.md#2-stay-scoped-to-the-invoking-guild).

## 3. Deployment and live data

- **Production runs on a Linux host** set up by
  [deploy/setup.sh](deploy/setup.sh). The bot runs under `systemd`, and an
  optional sync job pulls updates from git automatically.
- **The live database already exists and has real data.** A schema change
  that only works on a fresh install will break production. Migrations have
  to be guarded and run only once (see CodeStandards.md § 6).
- **The host installs with `npm ci --omit=dev` and has no C/C++ toolchain.**
  This is why `better-sqlite3` is pinned to a version that ships prebuilt
  binaries (see the comment in `state/db.js`).
- **Node 24 is the minimum version.**

**Why it matters:** "it worked on my machine with a fresh database" is not
enough verification.

## 4. Destructive actions

[lib/honeypot.js](lib/honeypot.js) is the only code path in this bot that
bans or kicks anyone. Its two rules (skip admins and mod roles, and DM
before removing) are in
[WorkingAgreements.md § 3 and § 4](WorkingAgreements.md#3-never-let-the-bot-remove-its-own-moderators).

The default "remove" is a **softban**: ban, then immediately unban.

**Why:** a plain kick leaves the spam behind. Banning with
`deleteMessageSeconds` is what actually cleans up the messages, and the
unban lets a real person rejoin.

## 5. No privileged gateway intents

The bot uses only Discord's non-privileged intents (`Guilds`,
`GuildVoiceStates`, `GuildMessages`).

**Why it matters:** privileged intents need extra approval in the Discord
developer portal, which every self-hoster would have to repeat. Features
are designed around this limit. For example, the captcha uses a persistent
"Start verification" button rather than listening for members joining,
which would need the privileged Guild Members intent.

## 6. Documentation lives in the wiki

Detailed docs (setup, configuration, the full command reference,
permissions, troubleshooting) live in the GitHub wiki. The README is kept as
a landing page: features, quick start, the command table and the project
layout. See [References.md](References.md) for links.

**Why it matters:** the wiki is a separate git repo. A change that affects
documented behaviour needs a wiki push alongside the PR, and the PR
description should say so.

## 7. Open items

- Streamer alerts support Twitch only. A second platform (YouTube, Kick)
  would add a `platform` column to `streamer_links`, not a new table.
- Code that doesn't meet the standards yet is listed in
  [CodeStandards.md § 15](CodeStandards.md#15-known-deviations-in-current-code).
