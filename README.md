# bojan-discord-bot

A self-hosted Discord bot for one server, in TypeScript with a built-in SQLite
database (`node:sqlite` — no native dependencies, requires Node >= 22.5).

## Features

- **Message + reaction stats in SQLite** — every message is recorded (guild,
  channel, user, timestamp), and every reaction is recorded with both sides:
  the message author (reactions *received*) and the reactor (reactions
  *given*), plus the emoji. Tables: `messages`, `reactions`, `settings`,
  `embed_log`, `bot_state`, `activity_sessions`, `voice_sessions`. Reactions
  can also be backfilled with `/backfill`.
- **Presence / activity tracking** — with the privileged **Presence Intent**
  enabled, the bot records what members are playing/listening to/watching
  (e.g. "Playing World of Warcraft") as sessions in the `activity_sessions`
  table: each session gets a start, end and duration. Custom statuses are
  tracked by their text (e.g. "Svoboda osvobaja"). A change in an activity's
  details/state (e.g. a LoL game mode switch) starts a new session, so
  `/activity <name>` can break time down by mode. `/stats` shows the
  member's current activity and their top activities by total time. Only
  visible while the bot is running and the member is not offline/invisible —
  Discord offers no presence history to backfill.
- **Voice channel time tracking** — with the **Guild Voice States** intent the
  bot records join/leave/channel-switch as sessions in the `voice_sessions`
  table (start, end, channel), including members already in voice when the bot
  starts (counted from startup). `/stats` shows total time in voice, "in voice
  now" and the member's top voice channels.
- **Weekly stats message** — on a configurable day/hour (per guild timezone,
  weeks run Monday–Sunday) the bot posts last week's recap to a configured
  channel: total messages and reactions, top-5 messagers, top-5 channels,
  top-3 reactions given / received, and a per-day message bar chart.
- **Free games announcements** — [FreeStuff](https://freestuffbot.xyz) (API v2)
  pushes new temporarily-free games (Epic, Steam, GOG, itch.io, Ubisoft, EA,
  mobile, ...) to a signed webhook (see "FreeStuff webhook" below). For each
  new one the bot posts a Components V2 card (title, short description,
  ~~price~~ **FREE** until the end time, store, image, link button, optional
  role ping, "via FreeStuff") to a configured channel. Only new announcements
  are delivered, so there is no backlog to catch up on. The same game arriving
  twice is announced only once (matched by platform, store and normalized
  title). Filters, per guild: PC full games only by default with all stores
  enabled; DLC/loot, beta/playtest/demo keys (detected by title, e.g.
  "… Playtest Steam Key"; `includeBeta`), and mobile are opt-in, and
  individual stores can be switched off (store toggles apply to PC games).
  Announced games are tracked in `free_posted`. Settings (channel, ping role,
  stores, DLC/beta/mobile) live in the **dashboard** (settings table
  `free_settings`, "Free games" section) — there is no Discord command to
  change them. The section also shows whether the webhook is enabled and how
  many games were already announced.
- **Slash commands**
  - `/leaderboard [limit]` — all-time boards: top message senders, top
    reaction givers (with their 3 most used emoji), most reacted-to users
  - `/stats [user]` — all-time stats for a member: messages (total, share),
    reactions given/received, their most used emoji, the emojis most used on
    their messages, last message seen, currently played activity ("now
    playing"), top activities by total tracked time, total time in voice
    channels, "in voice now" and top voice channels
  - `/activity <name> [user]` — per-activity stats card (total time, session
    count, average session, per-day bar chart for the last 7 days, breakdown
    by details/status e.g. LoL game mode, recent sessions). `name` autocompletes
    from recorded activities (games, apps, custom statuses like `opencode`)
  - `/backfill [channel] [days]` — (admin) seed the database from channel
    history: messages **and** their reactions (it pages through the users who
    reacted to each message, so this is slower than a plain message backfill
    and rate-limited by Discord on big servers; use `days` to bound it).
    All text channels by default. Safe to re-run — messages and reactions are
    deduplicated by Discord id, so anything already counted live is not
    counted twice. Progress is posted ephemerally while it runs.
  - All settings (including weekly stats and free games) are configured in the
    dashboard only; there are no settings slash commands.
- **Admin dashboard** — a Hono web server (same process) with **Discord OAuth2
  login**; only server administrators (or a configured admin role) get in.
  Shows bot status (ping, uptime, DB size), this-week and all-time
  leaderboards, recent embed conversions, and a settings form (stats channel,
  weekly day/hour/timezone, embed-conversion channels), and a separate
  "Free games" section (announcement channel, ping role, stores, DLC / beta /
  mobile, status line). JSON API at
  `/api/stats.json` (includes `freeGames` settings).
- **URL converter (embeddo-style)** — in the channels you pick, messages
  containing a supported social link are reposted via a webhook **as the
  original user**, with the link rewritten to an embed-friendly mirror and
  the original message removed so nothing doubles up — in all cases (bare
  link or with surrounding text), **except** links inside code blocks or
  inline code (`...`), which are never converted. Like
  [embeddo](https://github.com/aikenahac/embeddo), the rewrites are:
  `x.com`/`twitter.com` → `fxtwitter.com`, `instagram.com`/`instagr.am` →
  `kkinstagram.com`, `tiktok.com` → `kktiktok.com`, `reddit.com` →
  `vxreddit.com`. Discord's own embedder then fetches the mirror, which gives
  rich embeds *with playable video* (building the embed ourselves lost the
  play button). Platforms not in the list (YouTube, Spotify, …) already get
  good native embeds and are left alone. Requires the **Message Content**
  intent and, in conversion channels, **Manage Webhooks** + **Manage
  Messages**. Skips and conversions are logged (`docker compose logs`,
  `[embeds]` lines).

## Setup

1. Create an application at <https://discord.com/developers/applications>:
   - Bot tab: add a bot, copy the token; enable the privileged intents
     **Message Content**, **Server Members**, **Guild Messages**,
     **Presences** (for activity/game tracking), plus the regular
     **Guild Message Reactions** intent (for reaction stats).
   - OAuth2 tab: add redirect URI `http://localhost:3000/auth/callback`
     (use your public `DASHBOARD_URL` in production), scopes
     `identify guilds` (Discord removed the old `guilds.member` scope; admin is
     checked via the `/users/@me/guilds/{id}/member` endpoint instead).
   - Invite the bot to your server with the `bot applications.commands` scope.
2. Copy `.env.example` to `.env` and fill it in (`DISCORD_TOKEN`, `CLIENT_ID`,
   `CLIENT_SECRET`, `GUILD_ID`, `DASHBOARD_URL`, `SESSION_SECRET`, ...).
3. Run:

   ```bash
   npm install
   npm run dev        # tsx watch, for development
   # or production:
   npm run build && npm start
   ```

4. Open the dashboard at `http://localhost:3000` and sign in with Discord.
   Pick the weekly-stats channel and the channels for embed conversion there.

## Run on a server (Docker)

The image is plain `node:26-alpine` — no native modules, because SQLite comes
from Node itself. Build and run:

```bash
cp .env.example .env   # fill in real values, never commit .env
docker compose up -d --build
curl http://localhost:3001/health   # {"ok":true,...}
docker compose logs -f              # watch the bot
docker compose down                 # stop
```

The SQLite database lives in the named Docker volume `bojan-data` (mounted at
`/app/data`, owned by the non-root `node` user), so it survives container
rebuilds and needs no `chown`. Run exactly one replica — SQLite is
single-writer.

After editing `.env`, use `docker compose up -d` (it recreates the container
and reloads `env_file`); `docker compose restart` keeps the old environment.

Without Docker, on any machine with Node >= 22.5:

```bash
npm ci && npm run build && npm start    # with .env in place
# keep it alive with systemd, pm2, supervisord, ...
```

### Connecting your Discord bot

1. <https://discord.com/developers/applications> → New Application → **Bot**
   tab: Add Bot, copy the token → `DISCORD_TOKEN`. Enable the privileged
   intents **Server Members**, **Guild Messages**, **Message Content** and
   **Presences** (needed to see what members are playing).
2. **OAuth2 → General**: copy Application ID → `CLIENT_ID` and Client Secret →
   `CLIENT_SECRET`. Add redirect URI `<your DASHBOARD_URL>/auth/callback`
   (e.g. `http://localhost:3000/auth/callback` locally,
   `https://dash.yourdomain.com/auth/callback` on the server — Discord requires
   HTTPS except for localhost).
3. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`, bot
   permissions: View Channels, Send Messages, Read Message History,
   **Manage Messages** (the embed converter deletes the original message),
   **Manage Webhooks** (it reposts via webhook), Embed Links, **Attach Files**
   (the weekly stats post uploads a chart image), **Create Public Threads** and
   **Send Messages in Threads** (self-building feature requests, see below).
   Open the URL and invite the bot to your server.
4. `GUILD_ID`: enable Discord Developer Mode, right-click your server →
   Copy Server ID.
5. `SESSION_SECRET`: `openssl rand -hex 32`.
6. On the server set `DASHBOARD_URL` to the public URL and put a reverse proxy
   with TLS in front of port 3000, e.g. Caddy:

   ```
   dash.yourdomain.com {
       reverse_proxy localhost:3000
   }
   ```

   The bot needs no inbound ports — only outbound HTTPS to Discord. Port 3000
   is just the dashboard.

## Self-building (feature requests)

An admin can @mention the bot with a feature request. The bot opens a thread, asks a headless
[OpenCode](https://opencode.ai) agent to plan it, relays questions and replies, and, once the plan is approved,
lets a build agent implement it, push a `bot/<job>` branch and open a PR with auto-merge. GitHub CI and branch
protection gate the merge; Dokploy then redeploys from `main`.

```
Discord thread <-> bot --HTTP (Basic auth)--> opencode container (feature-plan / feature-build agents)
                                                  |  git worktree of this repo, gh CLI
                                                  v
                                       PR -> CI (.github/workflows/ci.yml) -> auto-merge -> Dokploy redeploy
```

The agents are defined in `.opencode/agents/` (`feature-plan` is read-only, `feature-build` can edit and run
shell, both hidden from the normal agent list). The agent container is the `opencode` service in
`docker-compose.yml`, built from `docker/opencode/`. It publishes no ports; the bot reaches it at
`http://opencode:4096` on the compose network.

Enable it, pick the model (default `opencode-go/glm-5.3`) and check agent-server status and OpenCode Go plan usage in
the dashboard's **Self-building** section. The **Feature requests** page (`/dashboard/requests`) lists every request
with tokens and an estimated cost; OpenCode reports no cost for Go models, so it is computed from Go's published list
prices (`https://opencode.ai/inference/go/v1/models`), not what a Go subscription actually charges.

Setup:

1. Add these variables to `.env` (Dokploy: the Environment tab); see `.env.example`. Compose passes only these to the
   agent container.
   - `OPENCODE_API_KEY`: your [OpenCode Go](https://opencode.ai/docs/console/go/) API key (model `opencode-go/glm-5.3`).
   - `OPENCODE_PASSWORD`: a long random shared secret (`openssl rand -hex 32`), shared by the bot and the agent.
     Clients use HTTP Basic auth with user `opencode`. If empty, the agent container idles and self-building is off.
   - `GH_TOKEN`: a fine-grained personal access token limited to this repository, with Contents: Read and write
     and Pull requests: Read and write.
   - `REPO_URL`, `GIT_EMAIL`: optional overrides.
2. In the GitHub repo settings: enable "Allow auto-merge", and add a branch protection rule (or ruleset) for `main`
   that requires pull requests and the `build` status check from the CI workflow. Without required checks, auto-merge
   would merge immediately.
3. Dokploy: put the values in the compose app's Environment tab (it writes `.env` next to the compose file);
   no domain or port is needed for the `opencode` service. Pushes to `main` redeploy both services; the `opencode-workspace`
   and `opencode-state` volumes keep the clone and session history across redeploys.
4. CI runs `npm run build` as a hard gate. `npm run smoke` is also run, but only failures outside the known
   weekday-dependent checks (listed in `CLAUDE.md`) fail the job.

Security: only server administrators can trigger a request (enforced by the bot). The agent container never
receives bot secrets (compose passes it only its own five variables, not the whole `.env`; the bot does see
`GH_TOKEN` and `OPENCODE_API_KEY` through `.env`), has no published port, requires the shared password, and its token can
only touch this repository. The build agent is denied reading `.env*`, pushing to `main`, force-pushing and editing
`.github/workflows` or `.opencode/`; branch protection is the real enforcement, so keep it enabled.

## Offline smoke test

```bash
npm run smoke
```

exercises the database layer, timezone/week math, URL detection and the
free-games normalizers/filters (inline fixtures) without a
Discord token.

## Layout

```
src/
  index.ts            entry point: db + bot + web + scheduler
  config.ts           env parsing
  db.ts               node:sqlite schema + typed queries
  stats.ts            timezone-aware week math + formatting
  bot.ts              discord.js client, events, slash commands
  scheduler.ts        weekly stats poster
  embeds/providers.ts oEmbed/OpenGraph metadata per platform
  embeds/converter.ts webhook repost + delete original (embeddo-style)
  freegames/types.ts    FreeGame / FreeSettings types, store labels
  freegames/filters.ts  beta detection + per-guild filters
  freegames/cards.ts    Components V2 announcement card
  freegames/actions.ts  shared per-guild announce, title dedupe
  freegames/freestuff.ts FreeStuff webhook signature check + product normalizer
  freegames/form.ts     dashboard form parser
  web/server.ts       Hono dashboard, Discord OAuth2, signed-cookie sessions
  web/views.ts        HTML templates
  smoke.ts            offline test
```

## Notes

- Single-process design: SQLite via `node:sqlite` is synchronous and fast
  enough for one server; if you ever shard the bot across processes, switch
  `db.ts` to Postgres (the query layer is small and isolated).
- The dashboard binds `0.0.0.0` on `DASHBOARD_PORT`; put it behind a reverse
  proxy with HTTPS if you expose it publicly, and set `DASHBOARD_URL` to the
  public https URL (it is used for the OAuth redirect).

## FreeStuff webhook (optional)

FreeStuff's free tier has no pull access, so it is webhook-only. To enable it:

1. In the FreeStuff dashboard, create a webhook pointing at
   `DASHBOARD_URL/webhooks/freestuff` (it must be reachable from the internet)
   and copy its public key.
2. Set `FREESTUFF_PUBLIC_KEY` (base64) in `.env` and restart. Unset = the route
   returns 404 and the feature is off.

The route verifies the Ed25519 signature (Standard Webhooks style), rejects
stale timestamps and replayed `Webhook-Id`s, requires compatibility date
`2026-11-15` (otherwise 409 so FreeStuff resends in that format), and answers
204 immediately; announcements are sent afterwards through the same filters as
the other sources. Timed free-weekends, subscription catalogs (Prime, Game
Pass, PlayStation), assets and flagged products are ignored.
