# PariahBot References

External resources, and the files in this repo to copy from when building
something similar.

---

## Project resources

- **Repository:** https://github.com/CosmicCubicle/PariahBot
- **Wiki** (a separate git repo; push it alongside any PR that changes
  documented behaviour):
  - [Home](https://github.com/CosmicCubicle/PariahBot/wiki)
  - [Bot Setup](https://github.com/CosmicCubicle/PariahBot/wiki/Bot-Setup):
    Discord application, permissions, invite link
  - [Host Installation](https://github.com/CosmicCubicle/PariahBot/wiki/Host-Installation):
    `systemd` deployment and the auto-update job
  - [Configuration](https://github.com/CosmicCubicle/PariahBot/wiki/Configuration):
    every `hom.env` variable
  - [Server Configuration](https://github.com/CosmicCubicle/PariahBot/wiki/Server-Configuration):
    configuring the bot inside Discord
  - [Commands](https://github.com/CosmicCubicle/PariahBot/wiki/Commands):
    every subcommand and option
  - [Permissions](https://github.com/CosmicCubicle/PariahBot/wiki/Permissions):
    every permission and intent, which feature needs it, and who can run
    each command (checked on every docs update, see CodeStandards.md § 12)
  - [Banned Words](https://github.com/CosmicCubicle/PariahBot/wiki/Banned-Words):
    the lists, custom words and how the AutoMod rules are managed
  - [Streamer Alerts](https://github.com/CosmicCubicle/PariahBot/wiki/Streamer-Alerts):
    Twitch and YouTube credentials, setup and quota
  - [Instagram Alerts](https://github.com/CosmicCubicle/PariahBot/wiki/Instagram-Alerts):
    the Meta app, System User token and server setup, step by step
  - [Troubleshooting](https://github.com/CosmicCubicle/PariahBot/wiki/Troubleshooting)

## Outside APIs

- **Instagram Graph API, Business Discovery** (`lib/instagram.js`):
  [Business Discovery](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/business-discovery.md)
  and [getting started with Facebook Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/get-started.md).
  Meta's app dashboard changes often. When it no longer matches the
  wiki's Instagram Alerts page, update the page.

## Bots features are modeled on

Read these before extending the matching feature. Where PariahBot differs
from them, it's on purpose.

- **riking/AutoDelete** is the model for `/autodelete`: rolling deletion by
  message count and/or age.
- **RiskyMH/honeypot** is the model for `/security honeypot`. Its 13
  experimental options were left out on purpose.

## Files to copy from

| Building... | Start from |
| --- | --- |
| A slash command with subcommands | [commands/autodelete.js](commands/autodelete.js) |
| A `state/` module with mapped rows | [state/voiceChannels.js](state/voiceChannels.js) |
| Upsert-style per-guild settings | [state/guildSettings.js](state/guildSettings.js) |
| A guarded schema migration | the `hasColumn` blocks in [state/db.js](state/db.js) |
| A guild check in the query | `removeHub` in [state/voiceChannels.js](state/voiceChannels.js) |
| A guild check after a lookup | `requireMenu` in [commands/roles.js](commands/roles.js) |
| Buttons, including clicks from a DM | [lib/hubDesync.js](lib/hubDesync.js) |
| A shared precondition check | [lib/vcScope.js](lib/vcScope.js) |
| Best-effort event handling | [events/messageCreate.js](events/messageCreate.js) |
| A destructive action | [lib/honeypot.js](lib/honeypot.js), or `checkTarget` in [lib/moderation.js](lib/moderation.js) for one a moderator runs |
| A right-click (context menu) command with a form | [commands/kickMember.js](commands/kickMember.js) and `openActionModal` in [lib/moderation.js](lib/moderation.js) |
| Something scheduled that must survive restarts | temporary bans in [lib/moderation.js](lib/moderation.js), or [lib/giveaways.js](lib/giveaways.js) |
| Managing Discord AutoMod rules without overwriting an admin's edits | `syncGuild` in [lib/bannedWords.js](lib/bannedWords.js) |
