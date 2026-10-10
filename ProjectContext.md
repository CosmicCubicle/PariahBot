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
- Twitch and YouTube alerts
- Instagram post alerts
- admin alerts

Slash commands are loaded automatically from `commands/`.

The only outside services the bot calls are Twitch's and YouTube's APIs, for
stream and upload alerts, and Instagram's Graph API, for post alerts. Each
platform is optional and stays off unless the host sets its credentials.

- **Both are polled** (Twitch every minute, YouTube every two minutes)
  rather than using push notifications (Twitch EventSub, YouTube
  PubSubHubbub). Push needs a public HTTPS address, which a self-hosted bot
  usually doesn't have.
- **YouTube's API has a daily quota** (10,000 units by default), so it's used
  sparingly. Each channel's free RSS feed finds recent videos, and one cheap
  `videos.list` call per 50 videos says which are live. Searching for live
  streams directly costs 100 units per call, which would use up the quota
  with a handful of channels. The current approach handles roughly 100
  followed channels per bot.
- **The feed can't see every live stream.** It only holds a channel's 15
  newest videos, and only the last 7 days are checked, so 24/7 or
  long-running streams, and streams buried under newer uploads, are
  invisible to it. A second, slower check (every 15 minutes) reads each
  channel's `/live` page, which points at whatever it's streaming now,
  however old. The result is confirmed through the API before anything is
  announced. The trade-offs:
  - **Bandwidth:** it's an ordinary web page of about 1.3 MB. Reading stops
    once the needed link appears, so roughly 150–200 KB is transferred per
    channel per check.
  - **Fragility:** it isn't an official API. If YouTube changes the page,
    this check quietly finds nothing and alerts fall back to what the feed
    can see.
- **Instagram has no free public feed**, so it goes through the Graph API's
  Business Discovery, polled every 10 minutes. With a token for the host's
  own Business/Creator account, it reads any public Business or Creator
  account's recent posts by username, one call per account. The trade-offs:
  - **Personal and age-gated accounts can't be followed**, and stories
    aren't available.
  - **The token is a System User token**, from the host's Meta business
    portfolio. It never expires and its data access never lapses, so it
    never needs renewing. A Page token made from a person's login looks
    equivalent but isn't: its data access lapses after 90 days, and
    renewing it needs that person to re-approve the app in a browser. The
    bot never refreshes the token, so it never writes a live secret into
    the database (see WorkingAgreements.md § 1).
  - **Lookups are by username.** A renamed account has to be re-added. The
    stored account ID stops a username someone else took over from posting
    a stranger's posts.
- **Announcement records are kept until 30 days after a stream was last
  seen**, not 30 days after it was announced. Otherwise a stream running
  longer than a month would be announced again.

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

- Streamer alerts support Twitch (live) and YouTube (live and uploads). A
  third platform, such as Kick, needs:
  - an entry in `PLATFORMS` in `commands/streamers.js`
  - an API client in `lib/`
  - a poller in `lib/streamAlerts.js`
  
  `streamer_links` and `stream_announcements` are already keyed by platform.
- The streamer list has two sources that work side by side: members with the
  streamer role self-link, and admins add channels directly. Admin-added
  channels alert regardless of roles, and don't need a member in the server.
- Social alerts (#18): Instagram is done (#37), with its own channel and
  `/instagram` command rather than a `/streamers` platform, because posts
  aren't streams and don't involve the streamer role. Another social
  platform would follow the Instagram pattern.
- Every YouTube upload is announced, including Shorts. There's no per-channel
  or per-kind filter yet, and uploads go to the same channel as live alerts.
- Code that doesn't meet the standards yet is listed in
  [CodeStandards.md § 15](CodeStandards.md#15-known-deviations-in-current-code).
