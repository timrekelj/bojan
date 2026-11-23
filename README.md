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
- **Free games announcements** — the bot polls public sources every 15 minutes
  for games that are temporarily 100% free and posts a Components V2 card
  (title, short description, ~~price~~ **FREE** until the end time, store,
  image, link button, optional role ping) for each new one to a configured
  channel. Sources (no API keys): the **Epic Games Store** free-games
  endpoint (authoritative for Epic) and the
  [GamerPower](https://www.gamerpower.com) giveaways API (Steam, GOG, itch.io,
  Ubisoft, EA, mobile, console, ...); cards and lists that include GamerPower
  items carry a "via GamerPower" attribution, as their terms ask. A source
  failing never breaks the other one. Filters, per guild: PC full games only by
  default with all stores enabled; DLC/loot, beta/playtest/demo keys (detected
  by title, e.g. "… Playtest Steam Key"; `includeBeta`), mobile and console are opt-in, and
  individual stores can be switched off (store toggles apply to PC games).
  Announced games are tracked in `free_posted`; when the channel is first set
  the current backlog is recorded silently so nothing is spammed. Settings
  (channel, ping role, stores, DLC/beta/mobile/console) live in the **dashboard**
  (settings table `free_settings`, "Free games" section) — there is no Discord
  command to change them. Saving a new channel or a more permissive filter
  records the matching backlog silently too. The section also shows how many
  games are free now / already announced and has a "Send test announcement"
  button (posts one current game without recording it). `/free [store]` is a public
  read-only listing of what is free now (matching the guild's filters) plus
  "Up next on Epic".
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
  - `/free [store]` — games that are free right now (filtered by the server's
    free-games settings, optionally narrowed to one store), with an "Up next
    on Epic" section
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
  mobile / console, status line, test announcement). JSON API at
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
curl http://localhost:3000/health   # {"ok":true,...}
docker compose logs -f              # watch the bot
docker compose down                 # stop
```

The SQLite database lives in `./data/` (mounted as a volume), so it survives
container rebuilds. Run exactly one replica — SQLite is single-writer.

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
   **Manage Webhooks** (it reposts via webhook), Embed Links. Open the URL and
   invite the bot to your server.
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
  freegames/sources.ts  Epic + GamerPower fetch, normalizers, merge, filters, cache
  freegames/cards.ts    Components V2 announcement card and /free list
  freegames/poller.ts   15-minute poller that announces new free games
  freegames/actions.ts  seedFreeGames() / sendTestAnnouncement() for the dashboard
  freegames/form.ts     dashboard form parser + "needs backlog seed" diff
  freegames/commands.ts /free command
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
