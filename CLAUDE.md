# CLAUDE.md

Self-hosted, single-guild Discord bot (TypeScript ESM, Node >= 22.5, discord.js 14, built-in `node:sqlite`). It tracks message/reaction/voice/activity stats, posts weekly stats, converts embed links, announces free games, and serves a Hono dashboard with Discord OAuth. Charts are rendered to PNG with `@resvg/resvg-js`. User-facing docs and setup live in `README.md`; this file covers working in the code.

## Module map (`src/`)
- `index.ts`: startup wiring (db, client, web server, weekly scheduler) and shutdown.
- `config.ts`: env vars into `config` (required vars throw at import; `guildId`, `databasePath`, ...).
- `bot.ts`: client and intents, slash command definitions, per-guild registration, event handlers, `/backfill`.
- `db.ts`: `BotDatabase`, the only SQL access (schema, migrations, queries, key/value `bot_state` table).
- `stats.ts`: pure time/week/timezone math and leaderboard formatting.
- `weekly.ts` / `cards.ts`: Components V2 message builders (weekly stats; leaderboard and activity).
- `chart.ts`: SVG-to-PNG daily chart (resvg uses system fonts; the Dockerfile installs DejaVu).
- `scheduler.ts`: 30s tick that posts last week's stats once per week (`weekly:<guild>` state key).
- `embeds/`: `providers.ts` (pure link detection and rewriting), `converter.ts` (webhook repost of the converted link).
- `freegames/`: `types.ts`, `filters.ts` (`isBetaTitle`, `matchesFilters`, `filterGames`), `freestuff.ts` (FreeStuff webhook verify + normalizer), `cards.ts`, `form.ts` (dashboard form parsing), `actions.ts` (`announceInGuild`, `announceEverywhere`, `titleDedupeKey`).
- `web/server.ts`: Hono routes, OAuth, settings POST handlers. `web/views.ts`: server-rendered HTML and CSS.
- `builder/` (self-building): `parse.ts` (agent reply/json parsing, naming, usage formatting, admin check; pure), `cards.ts` (Components V2 cards, pure), `opencode.ts` (`@opencode/client` wrapper: warm location, git worktree via shell, session, prompt-and-wait, usage), `runner.ts` (one-job-at-a-time orchestration: plan Q&A, build, PR tracking via GitHub API every 2 min, restart recovery), `handler.ts` (messageCreate: admin @mention starts a job thread; thread replies feed the runner). Jobs live in `build_jobs`; settings via `getBuilderSettings` (bot_state). Needs `OPENCODE_PASSWORD`; agents are defined in `.opencode/agents/`.
- `smoke.ts`: offline test script.

## Commands
- `npm run dev`: `tsx watch src/index.ts`. Needs env vars; `tsx` does not load `.env` by itself.
- Run locally with a throwaway DB, so the real `data/bot.db` is untouched:
  `DATABASE_PATH=/tmp/bojan-dev.db npx tsx --env-file=.env src/index.ts`
- `npm run build`: `tsc -p tsconfig.json`. This is the typecheck; there is no linter. Run it before finishing.
- `npm run smoke`: offline tests in `src/smoke.ts` (temp DB, no Discord token). Known weekday-dependent flaky failures: "last week total", "current week total", "top channels last week" and "per-day counts". Don't chase these unless you touched week math.
- `npm start` runs `dist/index.js`. Docker: `docker compose up -d --build`; the `data/` volume holds the DB.

## Rules and conventions
- **All settings are configured only in the dashboard** (`web/server.ts` and `web/views.ts`). Never add settings slash commands. Slash commands are read-only (leaderboard, activity, ...); the one exception is the admin-only `/backfill` action.
- Single guild: use `config.guildId`. Commands are registered per guild by PUTting the full command array in `registerCommands` (`bot.ts`); a new command must be added to the `commands` array there, or it won't register.
- Database: go through `BotDatabase`. The schema is in the `CREATE TABLE IF NOT EXISTS` block in `db.ts`. Add columns to existing tables via a migration: check `PRAGMA table_info(<table>)`, then `ALTER TABLE ... ADD COLUMN ... DEFAULT ...` (see `free_settings.include_beta`). Also update the `CREATE TABLE` so fresh DBs match. Use the `bot_state` key/value table (`getState`/`setState`) for flags such as "already sent" or "seeded".
- Discord messages use Components V2: build a `ContainerBuilder` and return `flags: MessageFlags.IsComponentsV2`. Text across all TextDisplays is capped at 4000 chars (`TEXT_BUDGET = 3800` in `cards.ts`; trim lines, never the headings). Use no-mention `allowedMentions` by default (`NO_MENTIONS` / `{ parse: [] }`). The only exception is the free-games ping role, `{ roles: [role] }`.
- Logging: `console.log/error/warn` with a `[tag]` prefix (`[bot]`, `[db]`, `[web]`, `[scheduler]`, `[freegames]`, `[embeds]`). Include the guild id where relevant. Background loops catch per guild and per item so one failure doesn't stop the rest.
- HTML: every dynamic value in `web/views.ts` goes through `escapeHtml`, including attributes.
- Keep pure logic (parsing, normalizing, filtering, formatting, builders) in exported functions that take plain data, so `smoke.ts` can import them. Add smoke tests for new logic; smoke checks are plain assertions in `src/smoke.ts`.
- ESM with NodeNext-style imports: relative imports end in `.js` (`from './db.js'`).
- Don't add dependencies without good reason; the dependency list is deliberately tiny.

## Free games
- Source: the FreeStuff webhook only, no polling (Epic's free games arrive through it with store `epic`) (`POST /webhooks/freestuff` in `web/server.ts`, logic in `freestuff.ts`, enabled by `FREESTUFF_PUBLIC_KEY`; push-only, no REST key). FreeStuff cards show `-# via FreeStuff`. Console products from FreeStuff are skipped.
- **Dedupe**: every announce marks both `g.key` and `titleDedupeKey(g)` (`t:<platform>:<store>:<normalized title>`) in `free_posted`, and skips a game if either is posted. Use `announceInGuild` / `markGamesPosted` / `isGamePosted` from `actions.ts`, not raw `markFreePosted`. The webhook is signature-verified (Ed25519), replay-guarded, answers 204 first and announces asynchronously.
- Everything is normalized to `FreeGame` (`types.ts`): `key` is a stable id (`fs:<id>`), `kind` is `game | dlc | beta`, `platform` is `pc | mobile`, and `store` is one of `ALL_STORES`. Beta/playtest/demo keys are detected by `isBetaTitle`.
- Filters (`FreeSettings`: `stores`, `includeDlc`, `includeBeta` (default off), `includeMobile`) are applied by `matchesFilters` / `filterGames`. A new filter needs: the type, a DB column plus migration, `form.ts` parsing, the dashboard view, and the smoke tests.
- **No backlog**: webhooks only deliver new announcements, so nothing is seeded on enabling the feature or changing filters. Announce dedupe uses `markFreePosted` / `isFreePosted`. The dashboard status shows whether `FREESTUFF_PUBLIC_KEY` is set and the announced count.

## Discord requirements
- Gateway intents (`bot.ts`): regular intents Guilds, GuildMessages, GuildMessageReactions, GuildVoiceStates; privileged intents MessageContent, GuildMembers, GuildPresences. The privileged ones must be enabled in the developer portal.
- Bot permissions: View Channels, Send Messages, Read Message History, Embed Links, Attach Files (weekly chart PNG), Manage Messages (embed converter deletes or suppresses the original), Manage Webhooks (embed converter reposts), Create Public Threads + Send Messages in Threads (self-building request threads). OAuth scopes `bot` + `applications.commands`. The dashboard allows Administrators or `ADMIN_ROLE_ID`. Setup details are in `README.md`; env vars are in `.env.example`.
