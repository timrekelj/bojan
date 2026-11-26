# CLAUDE.md

Self-hosted, single-guild Discord bot (TypeScript ESM, Node >= 22.5, discord.js 14, built-in `node:sqlite`): message/reaction/voice/activity stats, weekly stats, embed link conversion, free game announcements, Hono dashboard with Discord OAuth, self-building feature requests. Setup docs: `README.md`.

Details for each area are in `docs/architecture.md`; read only the section for the area you are changing (grep for its heading), never the whole file by default.

## Module map (`src/`)
- `index.ts` startup/shutdown; `config.ts` env into `config`; `bot.ts` client, commands, handlers, `/backfill`; `db.ts` `BotDatabase` (only SQL access, `bot_state`); `stats.ts` pure time/leaderboard math.
- `levels.ts` MEE6-style XP (`awardMessageXp`, `awardReactionXp`); `colors.ts` name-colour reaction roles (`rolesToSwap`, `POST /color-settings`); `weekly.ts`/`cards.ts` Components V2 builders; `chart.ts` SVG-to-PNG chart (`@resvg/resvg-js`); `scheduler.ts` weekly + monthly post tick; `monthly.ts` monthly recap/awards builders; `recap.ts` pure award math (night owls, voice buddies, heatmap, ...); `botdeletes.ts` marks the bot's own deletions so they aren't counted.
- `embeds/` (`providers.ts`, `converter.ts`); `freegames/` (`types.ts`, `filters.ts`, `freestuff.ts`, `cards.ts`, `form.ts`, `actions.ts`); `dokploy.ts` deployment pill (`summarizeDeployments`, `fetchDeployments`).
- `web/server.ts` Hono routes, OAuth, POST handlers, loaders (`loadOverview`, `loadLogs`, `loadRequests`, `loadSession`), `/dashboard/live`; `web/views.ts` HTML/CSS (`layout()`, `pagerHtml`, `*Parts()`, `LIVE_SCRIPT`, `CLOUDS_VERSION`).
- `builder/`: `chat.ts` + `chat-parse.ts` chat assistant (`ChatRunner`, `parseChatReply`), `runner.ts` plan/build orchestration (`BuilderRunner`), `handler.ts` messageCreate, `queue.ts`, `parse.ts`, `cards.ts`, `opencode.ts`, `limits.ts`, `reactions.ts`, `images.ts`, `transcript.ts` (pure session view model). Agents: `.opencode/agents/`. Needs `OPENCODE_PASSWORD`.
- `smoke.ts`: offline test script.

## Commands
- `npm run dev`: `tsx watch src/index.ts`. Needs env vars; `tsx` does not load `.env` by itself.
- Run locally with a throwaway DB (real `data/bot.db` stays untouched): `DATABASE_PATH=/tmp/bojan-dev.db npx tsx --env-file=.env src/index.ts`
- `npm run build`: `tsc -p tsconfig.json`, then copies `src/web/assets` to `dist/web/assets`. This is the typecheck; there is no linter. Run it before finishing.
- `npm run smoke`: offline tests in `src/smoke.ts` (temp DB, no Discord token). Known weekday-dependent flaky failures: "last week total", "current week total", "top channels last week" and "per-day counts". Don't chase these unless you touched week math.
- `npm start` runs `dist/index.js`. Docker: `docker compose up -d --build`; the `data/` volume holds the DB.

## Rules and conventions
- **All settings are configured only in the dashboard**, on the Settings page (`/dashboard/settings`: `settingsPage` in `web/views.ts`, POST handlers `/settings`, `/free-settings`, `/builder-settings` in `web/server.ts`, which redirect back to `/dashboard/settings?...`). Keep form field `name`s in sync with the POST handlers, `parseFreeForm` and `parseBuilderForm`. Never add settings slash commands. Slash commands are read-only (leaderboard, activity, ...); the one exception is the admin-only `/backfill` action.
- Single guild: use `config.guildId`. Commands are registered per guild by PUTting the full command array in `registerCommands` (`bot.ts`); a new command must be added to the `commands` array there, or it won't register.
- Database: go through `BotDatabase`. The schema is in the `CREATE TABLE IF NOT EXISTS` block in `db.ts`. Add columns to existing tables via a migration: check `PRAGMA table_info(<table>)`, then `ALTER TABLE ... ADD COLUMN ... DEFAULT ...` (see `free_settings.include_beta`). Also update the `CREATE TABLE` so fresh DBs match. Use `bot_state` (`getState`/`setState`) for flags such as "already sent" or "seeded".
- Discord messages use Components V2: build a `ContainerBuilder` and return `flags: MessageFlags.IsComponentsV2`. Text across all TextDisplays is capped at 4000 chars (`TEXT_BUDGET = 3800` in `cards.ts`; trim lines, never the headings). Use no-mention `allowedMentions` by default (`NO_MENTIONS` / `{ parse: [] }`); the only exception is the free-games ping role, `{ roles: [role] }`. Chat replies are plain text (≤2000 chars per message, split at line boundaries) with `allowedMentions: { parse: [] }`. The `chat` agent must stay read-only: no edits, shell limited to read-only `git log/show/diff/blame` and `ls`; keep its trailing json contract in sync with `parseChatReply`.
- Logging: `console.log/error/warn` with a `[tag]` prefix (`[bot]`, `[db]`, `[web]`, `[scheduler]`, `[freegames]`, `[embeds]`, `[builder]`, `[chat]`, `[dokploy]`). Include the guild id where relevant. Background loops catch per guild and per item so one failure doesn't stop the rest.
- HTML: every dynamic value in `web/views.ts` goes through `escapeHtml`, including attributes.
- Dashboard: lists that can grow use the shared `pagerHtml`; live regions (`<div class="live" id="live-...">`) are added in the page's `*Parts()` function, never only in the page; every `<details>` in a live region needs a stable `id`.
- Keep pure logic (parsing, normalizing, filtering, formatting, builders) in exported functions that take plain data, so `smoke.ts` can import them. Add smoke tests for new logic (plain assertions in `src/smoke.ts`).
- ESM with NodeNext-style imports: relative imports end in `.js` (`from './db.js'`).
- Don't add dependencies without good reason; the dependency list is deliberately tiny.

## Free games (essentials)
- FreeStuff webhook only (`POST /webhooks/freestuff`, `FREESTUFF_PUBLIC_KEY`), no polling. Normalize everything to `FreeGame` (`key` `fs:<id>`, `kind`, `platform`, `store`).
- Dedupe: announce through `announceInGuild` / `markGamesPosted` / `isGamePosted` (`actions.ts`), never raw `markFreePosted`; both `g.key` and `titleDedupeKey(g)` are marked.
- No backlog: nothing is seeded on enabling or changing filters. A new filter needs type, DB column + migration, `form.ts` parsing, dashboard view, smoke tests.

## Discord requirements
- Intents: Guilds, GuildMessages, GuildMessageReactions, GuildVoiceStates; privileged MessageContent, GuildMembers, GuildPresences (enable in the developer portal).
- Bot permissions: View Channels, Send Messages, Read Message History, Embed Links, Attach Files, Manage Messages, Manage Webhooks, Create Public Threads, Send Messages in Threads, Add Reactions, Manage Roles (roles below the bot's highest role). OAuth scopes `bot` + `applications.commands`. Dashboard access: Administrators or `ADMIN_ROLE_ID`. Env vars: `.env.example`.
