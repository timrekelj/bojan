# bojan-discord-bot

A self-hosted Discord bot for one server, in TypeScript with a built-in SQLite
database (`node:sqlite` — no native dependencies, requires Node >= 22.5).

## Features

- **Message + reaction stats in SQLite** — every message is recorded (guild,
  channel, user, timestamp), and every reaction is recorded with both sides:
  the message author (reactions *received*) and the reactor (reactions
  *given*), plus the emoji. Tables: `messages`, `reactions`, `settings`,
  `embed_log`, `bot_state`. Reactions can also be backfilled with `/backfill`.
- **Weekly stats message** — on a configurable day/hour (per guild timezone,
  weeks run Monday–Sunday) the bot posts last week's top-10 to a configured
  channel.
- **Slash commands**
  - `/leaderboard [limit]` — all-time top message senders
  - `/stats [user]` — all-time stats for a member: messages (total, share),
    reactions given/received, most used emoji, last message seen
  - `/setstats #channel` — (admin) choose the weekly stats channel
  - `/backfill [channel] [days]` — (admin) seed the database from channel
    history: messages **and** their reactions (it pages through the users who
    reacted to each message, so this is slower than a plain message backfill
    and rate-limited by Discord on big servers; use `days` to bound it).
    All text channels by default. Safe to re-run — messages and reactions are
    deduplicated by Discord id, so anything already counted live is not
    counted twice. Progress is posted ephemerally while it runs.
- **Admin dashboard** — a Hono web server (same process) with **Discord OAuth2
  login**; only server administrators (or a configured admin role) get in.
  Shows bot status (ping, uptime, DB size), this-week and all-time
  leaderboards, recent embed conversions, and a settings form (stats channel,
  weekly day/hour/timezone, embed-conversion channels). JSON API at
  `/api/stats.json`.
- **URL converter (embeddo-style)** — in the channels you pick, messages
  containing a social link (X/Twitter, Instagram, TikTok, YouTube, Reddit,
  Facebook, Threads, Spotify, SoundCloud) are reposted via a webhook with a
  rich embed (oEmbed where the platform allows it keyless, OpenGraph scraping
  as fallback) and the original message is deleted so the plain link preview
  doesn't double up. Inspired by https://github.com/aikenahac/embeddo

## Setup

1. Create an application at <https://discord.com/developers/applications>:
   - Bot tab: add a bot, copy the token; enable the privileged intents
     **Message Content**, **Server Members**, **Guild Messages**, plus the
     regular **Guild Message Reactions** intent (for reaction stats).
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
   Pick the weekly-stats channel and the channels for embed conversion there
   (or with `/setstats`).

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

Without Docker, on any machine with Node >= 22.5:

```bash
npm ci && npm run build && npm start    # with .env in place
# keep it alive with systemd, pm2, supervisord, ...
```

### Connecting your Discord bot

1. <https://discord.com/developers/applications> → New Application → **Bot**
   tab: Add Bot, copy the token → `DISCORD_TOKEN`. Enable the privileged
   intents **Server Members**, **Guild Messages** and **Message Content**.
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

exercises the database layer, timezone/week math and URL detection without a
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
