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
- banned words
- moderation (kick, ban, temporary ban, timeout)
- giveaways
- activity levels
- Twitch and YouTube alerts
- Instagram post alerts
- RSS and Atom feeds
- admin alerts

Slash commands are loaded automatically from `commands/`.

The bot calls three outside services, each optional and off unless the host
sets its credentials:
- Twitch's and YouTube's APIs, for stream and upload alerts
- Instagram's Graph API, for post alerts

It also fetches **whatever RSS or Atom feed addresses** server admins add
with `/rss`. That needs no credentials, so it's always on. Because those
addresses are user-supplied, they're only ever fetched through
`lib/safeFetch.js`, which won't connect to the host's own network (see
[WorkingAgreements.md § 6](WorkingAgreements.md#6-never-fetch-a-user-supplied-address-directly)).
Feeds are parsed without an XML library, like YouTube's. They're checked
every 10 minutes, and each URL is fetched once however many servers follow
it.

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
- **The host installs with `npm ci --omit=dev` and has no C/C++ toolchain**
  (`deploy/setup.sh` doesn't install one).
  This is why `better-sqlite3` is pinned to a version that ships prebuilt
  binaries (see the comment in `state/db.js`).
- **Node 24 is the minimum version.**

**Why it matters:** "it worked on my machine with a fresh database" is not
enough verification.

## 4. Destructive actions

Two code paths ban or kick anyone:

- [lib/honeypot.js](lib/honeypot.js), automatically
- [lib/moderation.js](lib/moderation.js), when a moderator uses `/mod` or a
  right-click action

Both follow the two rules in
[WorkingAgreements.md § 3 and § 4](WorkingAgreements.md#3-never-let-the-bot-remove-its-own-moderators):
skip admins and mod roles, and DM before removing. `/mod` also requires the
moderator to outrank the target, as Discord's own kick and ban do.

**Every moderation action is recorded** as a case in `mod_cases`, for
`/mod history`. That covers `/mod`, the right-click actions, automatic
timeouts from repeated warnings, temporary bans ending, and honeypot
removals. Cases are kept indefinitely, because they're the server's record.
`/mod remove-case` deletes one (a mistaken warning, say) without undoing the
action, and that removal is itself reported through the admin alerts.

**Temporary bans** are stored in SQLite (`temp_bans`), not just as timers, so
a restart doesn't turn them permanent. The unban is scheduled again at
startup, and runs straight away if it fell due while the bot was offline.

The default "remove" is a **softban**: ban, then immediately unban.

**Why:** a plain kick leaves the spam behind. Banning with
`deleteMessageSeconds` is what actually cleans up the messages, and the
unban lets a real person rejoin.

## 5. No privileged gateway intents

The bot uses only Discord's non-privileged intents (`Guilds`,
`GuildVoiceStates`, `GuildMessages`, `AutoModerationExecution`).

**Why it matters:** privileged intents need extra approval in the Discord
developer portal, which every self-hoster would have to repeat. Features
are designed around this limit. For example, the captcha uses a persistent
"Start verification" button rather than listening for members joining,
which would need the privileged Guild Members intent.

Banned words are the biggest case. Reading message text needs the privileged
Message Content intent, so the bot never sees what members write. Instead it
creates **Discord AutoMod rules** from the server's chosen lists and words
(`lib/bannedWords.js`), and Discord does the blocking:
- **Blocked before anyone sees it,** even while the bot is offline.
- **Reported by the bot,** through admin alerts, from the AutoMod execution
  event. The event gives the matched word but not the whole message.
- **Costs the Manage Server permission,** which AutoMod rules need.
- **Uses at most two of the server's AutoMod rules:** the one *keyword
  preset* rule Discord allows (its own profanity, sexual content and slur
  lists) and one of the six *keyword* rules (the bot's shipped lists plus
  custom words, capped at 1,000 together).

## 6. The admin dashboard

An optional web page (`lib/dashboard/`, `dashboard/`) where the bot's
**owner** sees its status and changes most settings for every server. It
runs inside the bot process, so it uses the live database and Discord
connection directly.

- **Off unless the host sets `DASHBOARD_PORT`.** `deploy/setup.sh` asks
  about it.
- **It listens on 127.0.0.1.** Other computers reach it through an SSH
  tunnel, which also means Discord's OAuth redirect can be
  `http://localhost:…`. A self-hosted bot usually has no public HTTPS
  address, the same constraint as § 1's polling.
- **Sign-in is Discord OAuth (`identify`), owner only.** That's the
  application's owner, or its team members, rechecked on every request.
  Per-server admins aren't supported: the dashboard reaches every server
  the bot is in.
- **Sessions are signed cookies, not stored state,** so they need no
  exception to WorkingAgreements.md § 1. The key is derived from
  `DISCORD_CLIENT_SECRET`, so rotating that secret signs everyone out.
- **Changes need a custom header and a matching Origin, and the Host header
  is checked.** Every ID the page sends is checked against its server
  (WorkingAgreements.md § 2). Every change goes in the command audit log as
  `dashboard <action>`.
- **What it doesn't do:** post setup messages (captcha, honeypot, role
  menus), or act against members. Those stay in Discord, where a
  moderator's judgement and permissions apply. Voice is the one area where
  it creates and deletes channels: adding, removing and restoring hubs,
  and closing temp channels. The same rules apply as for `/voice`, through
  `lib/voiceHubs.js` and `lib/tempVoice.js`.

## 7. Documentation lives in the wiki

Detailed docs (setup, configuration, the full command reference,
permissions, troubleshooting) live in the GitHub wiki. The README is kept as
a landing page: features, quick start, the command table and the project
layout. See [References.md](References.md) for links.

**Why it matters:** the wiki is a separate git repo. A change that affects
documented behaviour needs a wiki push alongside the PR, and the PR
description should say so.

## 8. Open items

- Streamer alerts support Twitch (live) and YouTube (live and uploads). A
  third platform, such as Kick, needs:
  - an entry in `PLATFORMS` in `lib/streamPlatforms.js`
  - an API client in `lib/`
  - a poller in `lib/streamAlerts.js`
  
  `streamer_links` and `stream_announcements` are already keyed by platform.
- The streamer list has two sources that work side by side: members with the
  streamer role self-link, and admins add channels directly. Admin-added
  channels alert regardless of roles, and don't need a member in the server.
- Social alerts (#18) shipped as Instagram post alerts (#37), with their
  own channel and `/instagram` command rather than a `/streamers` platform,
  because posts aren't streams and don't involve the streamer role. Another
  social platform would get a new issue and follow the Instagram pattern.
- Every YouTube upload is announced, including Shorts. There's no per-channel
  or per-kind filter yet, and uploads go to the same channel as live alerts.
- Code that doesn't meet the standards yet is listed in
  [CodeStandards.md § 15](CodeStandards.md#15-known-deviations-in-current-code).
