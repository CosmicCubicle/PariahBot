# PariahBot Team

Who works on this repo and who it's built for.

---

## Maintainers

- Code owners are listed in [.github/CODEOWNERS](.github/CODEOWNERS)
  (`@CosmicCubicle`, `@thatmatthallett`). Every PR needs their review.
- Several people contribute features. Check `git log` for who built which
  part, and ask them before redesigning it.

## How the team works

- Development is AI-assisted. AI-written commits keep their
  `Co-Authored-By:` trailer, and the same rules apply whether a person or a
  tool wrote the change (see [WorkingAgreements.md](WorkingAgreements.md)).
- The team expects PR descriptions to explain **why** a change was made,
  **how it was checked**, and **what was deliberately left out** (see
  [CodeStandards.md § 14](CodeStandards.md#14-git-and-pull-requests)).

## Who the bot is for

- **Server admins and moderators** who self-host the bot. Every error
  message and setup reply is written for them. It should say what went wrong
  *and* how to fix it, in Discord terms they'll recognise (for example,
  Server Settings → Roles).
- **Regular members**, who use the self-service features (`/vc`, role menus,
  verification, giveaways, `/level`). They never see admin-only
  configuration.
