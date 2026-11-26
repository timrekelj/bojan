import type { BuildJob, BuildUsage, BuilderSettings, ChannelRow, ChatThread, LogRow, Settings, UserRow, UserStats, EmbedLogRow, EmojiRow, ReactionStats, VoiceStats, VoiceChannelRow, CurrentVoiceRow, ActivityAggregateRow, CurrentActivityRow, Challenge, ChallengeEntry, ChallengeEvent, ChallengeGoal, ChallengeSort } from '../db.js';
import { activityTypeLabel, fmt, fmtDate, fmtDuration, weekRangeLabel } from '../stats.js';
import type { WeekBounds } from '../stats.js';
import { levelProgress, levelTag, steamLevelColors, steamLevelOutline, steamLevelShape } from '../levels.js';
import type { AgentStatus } from '../builder/opencode.js';
import { ALL_STORES, STORE_LABELS, type FreeSettings } from '../freegames/types.js';
import type { DeployStatus } from '../dokploy.js';
import type { TranscriptEntry, TranscriptPart } from '../builder/transcript.js';
import { CHALLENGE_EVENT_LABELS, challengeEventText, formatChallengeTarget, formatChallengeValue, MAX_CHALLENGE_GOALS, type ChallengeStatus, type ChallengeWizardStep, type ChallengeDraft, type ProgressRow } from '../challenges/form.js';
import { CHALLENGE_METRICS, isTimeMetric, metricLabel, metricTargetUnit, type ChallengeMetric } from '../challenges/types.js';
import { canCancel, retryAction } from '../builder/queue.js';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---- design tokens + styles ------------------------------------------------
// One accent (blue). Green/amber/red only for status. The app floats on one image: a 1-bit
// ordered-dithered cloud photo (white on transparent, see src/web/assets/clouds.png and the
// /assets/clouds.png route). CSS supplies the sky colour, so the same file serves both themes.
// It is drawn at its natural size or an integer multiple, never `cover`, so the dots stay crisp.

/** Versioned URL of the cloud background (first 8 hex of the file's sha256; smoke checks it). */
export const CLOUDS_VERSION = '16c01b81';
export const CLOUDS_URL = `/assets/clouds.png?v=${CLOUDS_VERSION}`;

const CHEVRON = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5 6 8l3.5-3.5' fill='none' stroke='%238b8b96' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`;
const CHECK = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.6 6.3 5 8.6l4.4-5' fill='none' stroke='white' stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`;

const CSS = `
  :root {
    color-scheme: dark light;
    --bg: #0b0b0d; --side: #101012; --card: #151518; --card-2: #1d1d21; --field: #0e0e11; --hover: rgba(255,255,255,.05);
    --line: rgba(255,255,255,.08); --line-2: rgba(255,255,255,.15);
    --text: #f4f4f6; --text-2: #c9c9d1; --muted: #9a9aa6;
    --accent: #4c7dff; --accent-solid: #3565e8; --accent-soft: rgba(76,125,255,.15); --link: #8fadff;
    --ok: #3ecf8e; --warn: #f5a524; --err: #f47272;
    --ok-soft: rgba(62,207,142,.14); --warn-soft: rgba(245,165,36,.15); --err-soft: rgba(244,114,114,.15);
    --shadow: 0 1px 0 rgba(255,255,255,.03) inset, 0 18px 40px -24px rgba(0,0,0,.7);
    --side-w: 232px; --top-h: 52px; --tab-h: 58px;
    --page: #0b0b0d; --sky: #0a1230; --sky-dots: .3; --sky-size: 2000px; --royal: #2b5ce6;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f4f5f8; --side: #fff; --card: #fff; --card-2: #f2f3f7; --field: #fff; --hover: rgba(15,20,40,.05);
      --line: rgba(15,20,40,.09); --line-2: rgba(15,20,40,.17);
      --text: #111318; --text-2: #3a3d48; --muted: #5d606c;
      --accent: #2f5fe0; --accent-solid: #2f5fe0; --accent-soft: rgba(47,95,224,.10); --link: #2553cf;
      --ok: #16803c; --warn: #b45309; --err: #c62828;
      --ok-soft: rgba(22,128,60,.10); --warn-soft: rgba(180,83,9,.11); --err-soft: rgba(198,40,40,.09);
      --shadow: 0 1px 2px rgba(15,20,40,.05), 0 18px 40px -28px rgba(15,20,40,.25);
      --page: #2b5ce6; --sky: #2b5ce6; --sky-dots: 1;
      --shadow: 0 0 0 1px rgba(8,25,90,.10), 0 2px 4px rgba(8,25,90,.12), 0 14px 34px -10px rgba(8,25,90,.5);
    }
  }
  *, *::before, *::after { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
  body { margin: 0; background: var(--page); color: var(--text); font: 400 14px/1.5 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; -webkit-font-smoothing: antialiased; }
  a { color: var(--link); text-underline-offset: 3px; text-decoration-thickness: 1px; }
  /* Plain text links: no underline at rest, a line that grows left to right on hover/focus. Zero specificity (:where) so every styled link keeps its own rules; nav/pills/tabs/buttons are excluded. */
  :where(a:not([class], .nav a, .secnav a, .seg a, .livestat a, td.url a)), a.row-link { text-decoration: none; background: linear-gradient(currentColor, currentColor) no-repeat 0 100% / 0 1.5px; transition: background-size .2s ease, color .15s ease; }
  :where(a:not([class], .nav a, .secnav a, .seg a, .livestat a, td.url a)):is(:hover, :focus-visible), a.row-link:is(:hover, :focus-visible), tr[data-href]:hover a.row-link { background-size: 100% 1.5px; color: color-mix(in srgb, var(--link), var(--text) 28%); }
  code { background: var(--card-2); padding: 1px 6px; border-radius: 6px; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  h1, h2, h3, p { margin: 0; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }
  .skip { position: fixed; left: 12px; top: -60px; z-index: 100; background: var(--accent-solid); color: #fff; padding: 10px 14px; border-radius: 10px; font-weight: 600; text-decoration: none; }
  .skip:focus { top: 12px; }
  .vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

  /* ---- shell: sidebar on desktop, top bar + bottom tab bar below 900px ---- */
  .chrome { position: fixed; top: 0; bottom: 0; left: 0; width: var(--side-w); z-index: 40; display: flex; flex-direction: column; gap: 22px; padding: 18px 12px 14px; background: var(--side); border-right: 1px solid var(--line); }
  .brand { display: flex; align-items: center; gap: 11px; padding: 2px 8px; color: var(--text); font-size: 16px; font-weight: 650; letter-spacing: -.015em; text-decoration: none; }
  .mark { display: block; flex: none; border-radius: 25%; object-fit: cover; }
  .chrome-title { display: none; }
  .nav { display: flex; flex-direction: column; gap: 2px; }
  .nav a { position: relative; display: flex; align-items: center; gap: 11px; min-height: 38px; padding: 0 10px; border-radius: 10px; color: var(--text-2); font-size: 14px; font-weight: 500; text-decoration: none; }
  .nav a svg { flex: none; color: var(--muted); }
  .nav a:hover { background: var(--hover); color: var(--text); }
  .nav a[aria-current=page] { background: var(--accent-soft); color: var(--text); }
  .nav a[aria-current=page] svg { color: var(--accent); }
  .me { margin-top: auto; display: grid; gap: 12px; min-width: 0; }
  .me-user { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 12px 8px 0; border-top: 1px solid var(--line); }
  .me-av { width: 28px; height: 28px; border-radius: 50%; flex: none; object-fit: cover; background: var(--card-2); display: grid; place-items: center; font-size: 12px; font-weight: 600; color: var(--muted); }
  .me-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; font-size: 13.5px; }
  .logout { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-width: 32px; height: 32px; border-radius: 8px; color: var(--muted); text-decoration: none; }
  .logout:hover { background: var(--hover); color: var(--text); }
  .side-deploy { padding: 0 8px; min-width: 0; }
  .side-deploy:empty { display: none; }
  .side-deploy .pill { max-width: 100%; }
  .main { position: relative; isolation: isolate; margin-left: var(--side-w); min-width: 0; min-height: 100vh; }
  .wrap { max-width: 1088px; margin: 0 auto; padding: 4px 24px 72px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; }
  .wrap > * { min-width: 0; }
  .live { min-width: 0; }

  /* ---- cloud background + page header ---- */
  /* Dark: the sky sits at the top of the page and fades into the page colour, so long tables
     further down stay calm. Light: fixed behind the content, full intensity. */
  .sky { position: absolute; z-index: -1; top: 0; left: 0; right: 0; height: min(100vh, 1334px); background: var(--sky); pointer-events: none; -webkit-mask: linear-gradient(to bottom, #000 30%, #0000); mask: linear-gradient(to bottom, #000 30%, #0000); }
  .sky::before { content: ''; position: absolute; inset: 0; background: url("${CLOUDS_URL}") 70% top / var(--sky-size) auto no-repeat; image-rendering: pixelated; opacity: var(--sky-dots); }
  @media (prefers-color-scheme: light) {
    .sky { position: fixed; left: var(--side-w); height: 100vh; -webkit-mask: none; mask: none; }
  }
  @media (min-width: 2233px), (min-height: 1335px) { :root { --sky-size: 4000px; } }
  .hero { position: relative; display: flex; align-items: flex-end; min-height: 188px; }
  .hero-in { position: relative; width: 100%; max-width: 1088px; margin: 0 auto; padding: 64px 24px 20px; }
  .pagehead { display: inline-block; vertical-align: bottom; min-width: min(100%, 420px); max-width: 100%; padding: 18px 22px 20px; background: var(--card); border: 1px solid var(--line); border-radius: 16px; box-shadow: var(--shadow); }
  .hero h1 { font-size: 28px; line-height: 1.15; font-weight: 650; letter-spacing: -.025em; }
  .hero-sub { margin-top: 6px; color: var(--muted); font-size: 14px; max-width: 60ch; }
  .pagehead-top { display: flex; align-items: center; justify-content: space-between; gap: 12px 24px; }
  .livestat { flex: none; display: inline-flex; align-items: center; gap: 7px; height: 26px; padding: 0 10px; border-radius: 999px; background: var(--card-2); border: 1px solid var(--line); color: var(--muted); font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .livestat i { width: 6px; height: 6px; border-radius: 1px; background: var(--ok); animation: pulse 2.4s ease-in-out infinite; }
  .livestat a { display: none; color: inherit; font-weight: 600; }
  .livestat[data-state=retry] { color: var(--warn); border-color: var(--warn); }
  .livestat[data-state=retry] i { background: var(--warn); animation-duration: 1.2s; }
  .livestat[data-state=expired] { color: var(--err); border-color: var(--err); }
  .livestat[data-state=expired] i { background: var(--err); animation: none; }
  .livestat[data-state=expired] a { display: inline; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }

  /* ---- pills, badges ---- */
  .pills { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .pill { display: inline-flex; align-items: center; gap: 7px; min-width: 0; height: 28px; padding: 0 11px; border-radius: 999px; background: var(--card); border: 1px solid var(--line-2); color: var(--text-2); font-size: 12.5px; font-weight: 500; white-space: nowrap; font-variant-numeric: tabular-nums; text-decoration: none; }
  a.pill:hover { border-color: var(--muted); color: var(--text); }
  .dot { flex: none; width: 6px; height: 6px; border-radius: 1px; background: var(--muted); }
  .pill.ok .dot { background: var(--ok); }
  .pill.warn .dot { background: var(--warn); }
  .pill.err .dot { background: var(--err); }
  .pill.err { color: var(--err); }
  .pill.off { color: var(--muted); }
  .dot.pulse { animation: pulse 1.2s ease-in-out infinite; }
  .trunc { overflow: hidden; text-overflow: ellipsis; max-width: 24ch; }
  .badge { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px; border-radius: 6px; background: var(--card-2); color: var(--text-2); font-size: 12px; font-weight: 500; white-space: nowrap; }
  .badge.warn { background: var(--warn-soft); color: var(--warn); }
  .badge.error { background: var(--err-soft); color: var(--err); }
  .badge.ok { background: var(--ok-soft); color: var(--ok); }
  .badge.accent { background: var(--accent-soft); color: var(--link); }

  /* ---- cards, tiles ---- */
  .card { --pad: 22px; background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: var(--pad); min-width: 0; box-shadow: var(--shadow); }
  .card-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 12px; margin-bottom: 16px; }
  .card-head.tight { margin-bottom: 4px; }
  details.card > summary { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 12px; cursor: pointer; font-size: 15.5px; font-weight: 600; letter-spacing: -.01em; list-style: none; }
  details.card > summary::-webkit-details-marker { display: none; }
  details.card > summary::after { content: '+'; color: var(--muted); font-weight: 500; }
  details.card[open] > summary { margin-bottom: 16px; }
  details.card[open] > summary::after { content: '−'; }
  h2 { font-size: 15.5px; line-height: 1.3; font-weight: 600; letter-spacing: -.01em; }
  h3 { font-size: 13px; font-weight: 600; }
  .sub, .muted { color: var(--muted); font-size: 13px; }
  .sub { font-variant-numeric: tabular-nums; }
  .card-sub { color: var(--muted); font-size: 13px; margin: -10px 0 14px; max-width: 72ch; }
  .card-pills { margin: 0 0 12px; }
  .card-sub + .rows, .card-pills + form > .rows:first-child { border-top: 1px solid var(--line); padding-top: 13px; }
  .empty { padding: 4px 0; color: var(--muted); }
  .kpis { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
  .kpis.six { grid-template-columns: repeat(6, minmax(0, 1fr)); }
  .kpis.six .kpi { padding: 16px 14px; }
  .kpis.six .kpi b { font-size: 21px; }
  .kpi { min-width: 0; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; box-shadow: var(--shadow); }
  .kpi span { display: block; color: var(--muted); font-size: 13px; font-weight: 500; }
  .kpi b { display: block; margin-top: 6px; font-size: 26px; line-height: 1.15; font-weight: 600; letter-spacing: -.025em; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .kpi small { display: block; margin-top: 4px; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .kpi { background: var(--card-2); border-color: transparent; box-shadow: none; padding: 14px 16px; }
  .card .kpi b { font-size: 22px; }
  .cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; }
  .cols > * { min-width: 0; }

  /* ---- your stats ---- */
  #you .kpis { margin-bottom: 18px; }
  .levelrow { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 4px 20px; margin: 0 0 14px; }
  .levelno { display: flex; flex-direction: column; align-items: center; gap: 4px; line-height: 1.1; }
  .levelbadge { display: block; width: 52px; height: 52px; overflow: visible; color: var(--lv-from); }
  .levelbadge text { font-weight: 700; font-variant-numeric: tabular-nums; }
  @media (prefers-color-scheme: light) { .levelbadge { color: var(--lv-to); } }
  .levelcap { color: var(--muted); font-size: 12px; font-weight: 500; }
  .levelmeter { display: grid; gap: 6px; min-width: 0; }
  .levelnums { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .levelbar { height: 8px; border-radius: 999px; background: var(--card-2); overflow: hidden; }
  .levelbar i { display: block; height: 100%; border-radius: 999px; background: var(--lv-from, var(--accent)); }
  @media (prefers-color-scheme: light) { .levelbar i { background: var(--lv-to, var(--accent)); } }
  .you-cols { margin-top: 20px; padding-top: 18px; border-top: 1px solid var(--line); gap: 20px 40px; }
  .mini-h { margin: 0 0 8px; color: var(--muted); font-size: 12.5px; font-weight: 500; }
  .mini { list-style: none; margin: 0; padding: 0; }
  .mini li { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 7px 0; border-top: 1px solid var(--line); }
  .mini li:first-child { border-top: 0; }
  .mini .name { flex: 1; min-width: 0; }
  .mini .val { flex: none; color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ---- leaderboards ---- */
  .tabs, .seg { display: inline-flex; gap: 2px; padding: 3px; background: var(--field); border: 1px solid var(--line); border-radius: 10px; }
  .tabs { margin: 0 0 10px; }
  .tab, .seg a { display: inline-flex; align-items: center; min-height: 28px; padding: 0 12px; border-radius: 7px; color: var(--muted); font-size: 13px; font-weight: 500; text-decoration: none; white-space: nowrap; }
  a.tab:hover, .seg a:hover { color: var(--text); }
  .tab[aria-current=page], .seg a[aria-current=page] { background: var(--card-2); color: var(--text); box-shadow: 0 0 0 1px var(--line-2); }
  .lb { list-style: none; margin: 0; padding: 0; }
  .lb li { display: grid; grid-template-columns: 26px 26px minmax(0, 1fr) auto; align-items: center; gap: 5px 10px; padding: 9px 8px; margin: 0 -8px; border-top: 1px solid var(--line); }
  .lb li:first-child { border-top: 0; }
  .lb li.you { background: var(--accent-soft); border-radius: 10px; border-top-color: transparent; }
  .lb li.you + li { border-top-color: transparent; }
  .lb li.you .av { box-shadow: 0 0 0 2px var(--accent); }
  .lb .name { display: flex; align-items: center; gap: 8px; }
  .lb li.you .name, .top .name { font-weight: 600; }
  .lb .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .you-tag { flex: none; height: 18px; padding: 0 6px; border-radius: 5px; background: var(--accent-solid); color: #fff; font-size: 11px; font-weight: 600; line-height: 18px; }
  .lvl { flex: none; color: var(--muted); font-size: 12px; font-weight: 400; font-variant-numeric: tabular-nums; }
  .lb li.gap { border-top: 0; padding: 0 8px; }
  .lb li.gap .rank { grid-column: 1; line-height: 1; }
  .lb li.extra { border-top: 0; }
  .rank { color: var(--muted); font-size: 13px; text-align: center; font-variant-numeric: tabular-nums; }
  .rank.medal { font-size: 16px; line-height: 1; }
  .av { width: 26px; height: 26px; border-radius: 50%; background: var(--card-2); object-fit: cover; display: grid; place-items: center; font-size: 11px; font-weight: 600; color: var(--muted); }
  .num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
  .share { grid-column: 3 / 5; display: flex; align-items: center; gap: 8px; }
  .bar { flex: 1; height: 3px; border-radius: 1px; background: var(--card-2); overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--accent); }
  .pct { color: var(--muted); font-size: 12px; min-width: 44px; text-align: right; font-variant-numeric: tabular-nums; }
  .chanlb { list-style: none; margin: 0; padding: 0; }
  .chanlb li { display: grid; grid-template-columns: 26px minmax(0, 1fr) auto; align-items: center; gap: 5px 10px; padding: 9px 8px; margin: 0 -8px; border-top: 1px solid var(--line); }
  .chanlb li:first-child { border-top: 0; }
  .chanlb .name { display: flex; align-items: center; gap: 8px; }
  .chanlb .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .chanlb li.top .name { font-weight: 600; }
  .chanlb .share { grid-column: 2 / 4; }
  .emojis { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 14px; padding: 0; list-style: none; }
  .emojis li { display: inline-flex; align-items: center; gap: 8px; height: 38px; padding: 0 12px; border-radius: 10px; background: var(--card-2); font-size: 19px; line-height: 1; }
  .emojis small { font-size: 13px; font-weight: 500; color: var(--text-2); font-variant-numeric: tabular-nums; }
  .emojis img { width: 20px; height: 20px; }
  .you-cols .emojis { margin: 0; }

  /* ---- forms ---- */
  .stack { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .secnav { position: sticky; top: 10px; z-index: 30; max-width: 1088px; margin: 0 auto 20px; padding: 0 24px; }
  .secnav-in { display: flex; gap: 6px; width: fit-content; max-width: 100%; padding: 6px; background: var(--card); border: 1px solid var(--line-2); border-radius: 999px; box-shadow: var(--shadow); overflow-x: auto; scrollbar-width: none; }
  .secnav-in::-webkit-scrollbar { display: none; }
  .secnav a { flex: none; display: inline-flex; align-items: center; height: 32px; padding: 0 13px; border-radius: 999px; color: var(--text-2); font-size: 13px; font-weight: 500; text-decoration: none; }
  .secnav a:hover { background: var(--hover); color: var(--text); }
  .card[id], .formgroup[id] { scroll-margin-top: 76px; }
  .rows { display: grid; grid-template-columns: minmax(0, 1fr); }
  .row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 300px); align-items: center; gap: 8px 32px; padding: 15px 0; border-top: 1px solid var(--line); }
  .rows > .row:first-child { border-top: 0; padding-top: 2px; }
  .rows > .row:last-child { padding-bottom: 2px; }
  .row.block { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .row-l { min-width: 0; }
  .row-l label, .lbl { display: block; font-size: 13.5px; font-weight: 500; color: var(--text); }
  .help { display: block; margin-top: 2px; color: var(--muted); font-size: 12.5px; line-height: 1.45; max-width: 62ch; }
  .row-c { display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-width: 0; }
  .row.block .row-c { justify-content: flex-start; }
  .group-h { margin: 22px 0 0; padding: 0 0 8px; color: var(--muted); font-size: 11.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; border-bottom: 1px solid var(--line); }
  .group-h + .rows > .row:first-child { padding-top: 15px; }
  select, input[type=text], input[type=number] { width: 100%; min-width: 0; height: 40px; padding: 0 12px; background: var(--field); color: var(--text); border: 1px solid var(--line-2); border-radius: 10px; font: inherit; font-size: 14px; -webkit-appearance: none; appearance: none; transition: border-color .12s; }
  select { padding-right: 34px; background-image: ${CHEVRON}; background-repeat: no-repeat; background-position: right 12px center; background-size: 12px; text-overflow: ellipsis; cursor: pointer; }
  select option { background: var(--card); color: var(--text); }
  input[type=number] { width: 96px; flex: none; text-align: right; font-variant-numeric: tabular-nums; -moz-appearance: textfield; }
  input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  input.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
  select:hover, input[type=text]:hover, input[type=number]:hover { border-color: var(--muted); }
  select:focus-visible, input[type=text]:focus-visible, input[type=number]:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent); border-radius: 10px; }
  .switch { cursor: pointer; grid-template-columns: minmax(0, 1fr) auto; }
  .switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  .track { flex: none; display: block; width: 40px; height: 24px; border-radius: 999px; background: var(--line-2); position: relative; transition: background .15s; }
  .track::after { content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.3); transition: transform .15s; }
  .switch input:checked + .track { background: var(--accent-solid); }
  .switch input:checked + .track::after { transform: translateX(16px); }
  .switch input:focus-visible + .track { outline: 2px solid var(--accent); outline-offset: 2px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; }
  .chips.long { max-height: 264px; overflow-y: auto; padding: 2px; }
  .chip { position: relative; display: inline-flex; min-width: 0; max-width: 100%; cursor: pointer; }
  .chip input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  .chip span { display: inline-flex; align-items: center; gap: 8px; min-width: 0; min-height: 34px; padding: 0 12px 0 9px; border-radius: 999px; border: 1px solid var(--line-2); background: var(--field); color: var(--text-2); font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; transition: background .12s, border-color .12s; }
  .chip span::before { content: ''; flex: none; width: 16px; height: 16px; border-radius: 5px; border: 1.5px solid var(--line-2); background: transparent center / 12px no-repeat; }
  .chip:hover span { border-color: var(--muted); }
  .chip input:checked + span { background: var(--accent-soft); border-color: var(--accent); color: var(--text); }
  .chip input:checked + span::before { background-color: var(--accent-solid); border-color: var(--accent-solid); background-image: ${CHECK}; }
  .chip input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 2px; }
  button, .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 40px; padding: 0 16px; border: 1px solid transparent; border-radius: 10px; background: var(--accent-solid); color: #fff; font: inherit; font-size: 14px; font-weight: 600; text-decoration: none; white-space: nowrap; cursor: pointer; transition: filter .12s, background .12s; }
  button:hover, .btn:hover { filter: brightness(1.1); }
  button:active, .btn:active { filter: brightness(.95); }
  .btn.ghost { background: transparent; color: var(--text); border-color: var(--line-2); font-weight: 500; }
  .btn.ghost:hover { background: var(--hover); filter: none; }
  .savebar { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 10px 16px; }
  .savebar .muted { margin-right: auto; }
  .card > .savebar { margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--line); }
  .formgroup .savebar { padding: 12px 12px 12px 22px; background: var(--card); border: 1px solid var(--line); border-radius: 16px; box-shadow: var(--shadow); }
  .meters { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
  .meter { min-width: 0; padding: 12px 14px; border-radius: 12px; background: var(--card-2); }
  .meter-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 13px; font-weight: 500; }
  .meter-top b { font-weight: 600; font-variant-numeric: tabular-nums; }
  .meterbar { position: relative; height: 6px; margin: 8px 0 7px; border-radius: 2px; background: var(--line-2); }
  .meterbar i { display: block; height: 100%; border-radius: 2px; background: var(--accent); }
  .meterbar i.warn { background: var(--warn); }
  .meterbar i.err { background: var(--err); }
  .meterbar u { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; background: var(--text-2); border-radius: 1px; }
  .meter small { display: block; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }

  /* ---- toasts ---- */
  .flash { position: fixed; right: 24px; bottom: 24px; z-index: 60; max-width: min(380px, calc(100vw - 32px)); display: flex; align-items: center; gap: 10px; padding: 12px 16px; background: var(--card-2); border: 1px solid var(--line-2); border-radius: 12px; box-shadow: 0 16px 40px -12px rgba(0,0,0,.55); font-weight: 500; animation: toast 4.4s ease forwards; }
  .flash::before { content: ''; flex: none; width: 8px; height: 8px; border-radius: 2px; background: var(--ok); }
  .flash[role=alert]::before { background: var(--err); }
  @keyframes toast {
    0% { opacity: 0; transform: translateY(8px); visibility: visible; pointer-events: auto; }
    5%, 91% { opacity: 1; transform: translateY(0); visibility: visible; pointer-events: auto; }
    100% { opacity: 0; transform: translateY(0); visibility: hidden; pointer-events: none; }
  }

  /* ---- tables ---- */
  .tbl { margin: 0 calc(var(--pad) * -1); overflow-x: auto; border-top: 1px solid var(--line); }
  .card > .tbl:last-child { margin-bottom: calc(var(--pad) * -1); border-radius: 0 0 16px 16px; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 11px 12px; border-top: 1px solid var(--line); white-space: nowrap; vertical-align: top; }
  th:first-child, td:first-child { padding-left: var(--pad); }
  th:last-child, td:last-child { padding-right: var(--pad); }
  th { border-top: 0; padding-top: 10px; padding-bottom: 10px; color: var(--muted); font-size: 12px; font-weight: 500; background: var(--hover); }
  tbody tr:hover { background: var(--hover); }
  td.dim { color: var(--muted); }
  td.r, th.r { text-align: right; }
  td.url { max-width: 340px; overflow: hidden; text-overflow: ellipsis; }
  td.url a { display: block; overflow: hidden; text-overflow: ellipsis; text-decoration: none; }
  td.url a:hover { text-decoration: underline; }
  td.req { width: 100%; max-width: 0; white-space: normal; }
  tr[data-href] { cursor: pointer; }
  a.row-link { color: inherit; width: fit-content; max-width: 100%; }
  tr[data-href]:hover a.row-link, a.row-link:is(:hover, :focus-visible) { color: var(--link); }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 0 0 14px; }
  .actions form { margin: 0; }
  .btn.danger { background: transparent; color: var(--err); border-color: var(--err); font-weight: 500; }
  .btn.danger:hover { background: var(--err-soft); filter: none; }
  .req-t { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .req-m { display: block; margin-top: 1px; color: var(--muted); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .links { display: inline-flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px; }
  td .links { flex-wrap: nowrap; }
  .links a { display: inline-flex; align-items: center; gap: 3px; height: 22px; padding: 0 9px; border: 1px solid var(--line-2); border-radius: 999px; background: none; color: var(--muted); font-size: 12px; font-weight: 500; line-height: 1; white-space: nowrap; text-decoration: none; transition: background-color .15s ease, border-color .15s ease, color .15s ease; }
  .links a[target=_blank]::after { content: '\\2197'; display: inline-block; font-size: 11px; transition: transform .15s ease; }
  .links a:is(:hover, :focus-visible) { background-color: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 45%, transparent); color: var(--link); }
  .links a[target=_blank]:is(:hover, :focus-visible)::after { transform: translate(1px, -1px); }
  td.logmsg { white-space: normal; width: 100%; }
  td.logmsg pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--text-2); }
  tr.lv-error td.logmsg pre { color: var(--text); }
  .pager { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; margin-top: 14px; }
  .tbl + .pager { margin-top: 0; padding-top: 14px; border-top: 1px solid var(--line); }
  .pager .muted, .pager-nav { font-variant-numeric: tabular-nums; }
  .pager select.pager-size { width: auto; min-width: 110px; height: 32px; font-size: 13px; }
  .pager-nav { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
  .pager-btn { display: inline-flex; align-items: center; min-height: 32px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--line-2); color: var(--text); font-size: 13px; font-weight: 500; text-decoration: none; }
  a.pager-btn:hover { background: var(--hover); }
  .pager-btn[aria-disabled=true] { color: var(--muted); opacity: .5; }
  .filters { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 16px; }
  .filters form { display: flex; gap: 8px; }
  .filters select { width: auto; min-width: 150px; height: 36px; }
  .note { margin-top: 14px; }

  /* ---- session transcript ---- */
  .tl { display: grid; gap: 10px; min-width: 0; }
  .msg { min-width: 0; padding: 14px 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--card-2); }
  .msg-h { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-bottom: 8px; color: var(--muted); font-size: 12.5px; }
  .msg-h b { color: var(--text); font-weight: 600; }
  .msg-t { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .msg-t + details, .msg-t + .msg-t, details + .msg-t, details + details { margin-top: 8px; }
  .msg details { min-width: 0; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
  .msg summary { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 7px 10px; cursor: pointer; font-size: 13px; color: var(--text-2); }
  .msg details[open] > summary { border-bottom: 1px solid var(--line); }
  .msg pre { margin: 0; padding: 10px; max-width: 100%; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--text-2); }
  .msg pre + .pre-l { margin-top: 0; }
  .pre-l { padding: 8px 10px 0; color: var(--muted); font-size: 11.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
  .msg .toks + .toks { margin-top: 2px; }
  .msg .toks { margin-top: 8px; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .err-t { margin-top: 8px; padding: 8px 10px; border-radius: 8px; background: var(--err-soft); color: var(--err); font-size: 13px; overflow-wrap: anywhere; white-space: pre-wrap; }
  .evt { display: flex; flex-wrap: wrap; gap: 4px 10px; padding: 2px 8px; color: var(--muted); font-size: 12.5px; min-width: 0; overflow-wrap: anywhere; }
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px 20px; margin: 0 0 14px; }
  .facts div { min-width: 0; }
  .facts dt { color: var(--muted); font-size: 12px; }
  .facts dd { margin: 0; overflow-wrap: anywhere; }

  /* ---- login / error ---- */
  .center { position: relative; isolation: isolate; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: 24px; background: var(--royal); }
  .center .sky { position: fixed; left: 0; height: 100vh; background: var(--royal); -webkit-mask: none; mask: none; }
  .center .sky::before { opacity: 1; background-position: 40% 30%; }
  .auth { width: 100%; max-width: 384px; text-align: center; padding: 36px 30px 30px; background: var(--card); border: 1px solid var(--line-2); border-radius: 20px; box-shadow: 0 30px 80px -30px rgba(0,0,0,.7); }
  .auth .mark { margin: 0 auto; }
  .auth h1 { margin: 20px 0 8px; font-size: 22px; font-weight: 650; letter-spacing: -.02em; }
  .auth p { margin: 0 0 24px; color: var(--muted); }
  .auth .btn { width: 100%; min-height: 44px; }

  @media (max-width: 1180px) {
    .kpis, .kpis.six { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  }
  @media (max-width: 1080px) { .cols { grid-template-columns: minmax(0, 1fr); } }
  @media (max-width: 899px) {
    .chrome { position: sticky; bottom: auto; width: auto; flex-direction: row; align-items: center; gap: 10px; height: calc(var(--top-h) + env(safe-area-inset-top)); padding: env(safe-area-inset-top) max(8px, env(safe-area-inset-right)) 0 max(14px, env(safe-area-inset-left)); border-right: 0; border-bottom: 1px solid var(--line); }
    .brand { padding: 0; }
    .brand span { display: none; }
    .chrome-title { display: block; flex: 1; min-width: 0; font-size: 16px; font-weight: 600; letter-spacing: -.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .nav { position: fixed; left: 0; right: 0; bottom: 0; z-index: 40; flex-direction: row; gap: 0; background: var(--side); border-top: 1px solid var(--line); padding: 0 max(4px, env(safe-area-inset-right)) env(safe-area-inset-bottom) max(4px, env(safe-area-inset-left)); }
    .nav a { flex: 1; flex-direction: column; justify-content: center; gap: 3px; min-height: var(--tab-h); padding: 6px 2px; border-radius: 0; color: var(--muted); font-size: 11px; }
    .nav a, .nav a:hover, .nav a[aria-current=page] { background: none; }
    .nav a[aria-current=page] { color: var(--accent); }
    .nav a[aria-current=page]::before { content: ''; position: absolute; top: -1px; left: 50%; width: 24px; height: 2px; margin-left: -12px; background: var(--accent); }
    .me { margin: 0; display: flex; align-items: center; gap: 4px; }
    .me-user { padding: 0; border: 0; gap: 2px; }
    .me-name, .logout span { display: none; }
    .logout { width: 44px; height: 44px; }
    .side-deploy { padding: 0; }
    .side-deploy .pill { padding: 0 9px; border: 0; background: none; }
    .side-deploy .pill .t { display: none; }
    .main { margin-left: 0; padding-bottom: calc(var(--tab-h) + env(safe-area-inset-bottom)); }
    .wrap { padding-bottom: 40px; }
    .sky { left: 0; }
    .secnav { top: calc(var(--top-h) + env(safe-area-inset-top) + 8px); }
    .card[id], .formgroup[id] { scroll-margin-top: calc(var(--top-h) + 72px); }
    .flash { bottom: calc(var(--tab-h) + env(safe-area-inset-bottom) + 12px); }
    button, .btn { min-height: 44px; }
    select, input[type=text], input[type=number] { font-size: 16px; height: 44px; }
    input.mono { font-size: 15px; }
    .chip span { min-height: 40px; }
    .secnav a { height: 36px; }
  }
  @media (max-width: 760px) {
    .tbl table, .tbl tbody, .tbl tr, .tbl td { display: block; }
    .tbl thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
    .tbl tr { padding: 12px var(--pad); border-top: 1px solid var(--line); }
    .tbl tbody tr:first-child { border-top: 0; }
    .tbl td, .tbl td:first-child, .tbl td:last-child { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; padding: 3px 0; border: 0; white-space: normal; text-align: right; overflow-wrap: anywhere; }
    .tbl td::before { content: attr(data-label); flex: none; color: var(--muted); font-size: 12px; font-weight: 500; text-align: left; }
    .tbl td.url, .tbl td.req { display: block; width: auto; max-width: none; text-align: left; white-space: nowrap; }
    .tbl td.url::before { display: block; }
    .tbl td.req::before { content: none; }
    .tbl td.req { padding-bottom: 6px; }
    .req-t { white-space: normal; }
    .tbl .logs tr { display: grid; grid-template-columns: auto auto minmax(0, 1fr); align-items: center; gap: 6px 8px; }
    .tbl .logs td, .tbl .logs td:first-child, .tbl .logs td:last-child { display: block; padding: 0; text-align: left; font-size: 12px; }
    .tbl .logs td::before { content: none; }
    .tbl .logs td.logmsg { grid-column: 1 / -1; }
  }
  @media (max-width: 640px) {
    .hero { min-height: 0; }
    .hero-in { padding: 20px 16px 14px; }
    .pagehead { display: block; padding: 16px; border-radius: 14px; }
    .hero h1 { font-size: 24px; }
    .sky::before { background-position: 46% top; }
    .hero .pills { flex-wrap: nowrap; overflow-x: auto; margin: 14px -16px 0; padding: 0 16px 2px; scrollbar-width: none; }
    .hero .pills::-webkit-scrollbar { display: none; }
    .hero .pill { flex: none; }
    .card-pills .pill { white-space: normal; height: auto; min-height: 28px; padding-top: 4px; padding-bottom: 4px; }
    .wrap { padding: 2px 16px 32px; gap: 14px; }
    .secnav { padding: 0 16px; margin-bottom: 14px; }
    .card { --pad: 16px; border-radius: 14px; }
    .card > .tbl:last-child { border-radius: 0 0 14px 14px; }
    .kpis, .kpis.six { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .kpis > .kpi:last-child:nth-child(odd) { grid-column: 1 / -1; }
    .kpi { padding: 14px; }
    .kpi b { font-size: 22px; }
    .row { grid-template-columns: minmax(0, 1fr); gap: 10px; }
    .row.switch { grid-template-columns: minmax(0, 1fr) auto; gap: 16px; }
    .row-c { justify-content: flex-start; }
    .row-c.split > * { flex: 1; }
    .meters { grid-template-columns: minmax(0, 1fr); }
    .savebar { justify-content: stretch; }
    .savebar .muted { flex-basis: 100%; }
    .formgroup .savebar { padding: 14px; }
    .savebar button, .savebar .btn { flex: 1 1 100%; }
    .filters, .filters form, .filters select, .seg { width: 100%; }
    .seg a { flex: 1; justify-content: center; min-height: 36px; padding: 0 6px; }
    .lb li { grid-template-columns: 22px 26px minmax(0, 1fr) auto; gap: 5px 8px; }
    .lvl { display: none; }
    .flash { left: 16px; right: 16px; max-width: none; }
    .auth { padding: 30px 22px 24px; }
  }
  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    *, *::before, *::after { transition: none !important; }
    .livestat i, .dot.pulse { animation: none; }
    @keyframes toast {
      0% { opacity: 0; visibility: visible; pointer-events: auto; }
      5%, 91% { opacity: 1; visibility: visible; pointer-events: auto; }
      100% { opacity: 0; visibility: hidden; pointer-events: none; }
    }
  }
`;

// ---- brand mark + favicon ----------------------------------------------------
// A royal-blue rounded tile with a white cloud built from circles, and a few halftone dots
// fading off the top-right corner to echo the background. Bold enough to read at 16px.
const MARK_DOTS: [number, number, number][] = [[27.5, 4, 0.85], [24.5, 7, 0.6], [21.5, 4, 0.4], [27.5, 10, 0.4]];
const MARK_INNER = `<rect width="32" height="32" rx="8" fill="#2b5ce6"/><g fill="#fff">${MARK_DOTS.map(([x, y, o]) => `<circle cx="${x}" cy="${y}" r=".9" opacity="${o}"/>`).join('')}<circle cx="11.5" cy="19" r="5"/><circle cx="17.5" cy="15.5" r="6.5"/><circle cx="23" cy="19.5" r="4.5"/><rect x="6.5" y="18" width="21" height="6" rx="3"/></g>`;

function mark(size: number): string {
  return `<img class="mark" src="/bot-avatar" width="${size}" height="${size}" alt="">`;
}

/** The brand mark as a standalone SVG document, served at /favicon.svg. Pure. */
export function faviconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="64" height="64">${MARK_INNER}</svg>`;
}

// ---- live refresh ------------------------------------------------------------
/**
 * Polls /dashboard/live every 15s while the tab is visible and swaps the regions whose HTML
 * changed (ids -> HTML rendered by the same view functions as the full page; same-origin only).
 * Week tabs inside a live region switch without a page load. Exported so static previews can
 * strip it.
 */
export const LIVE_SCRIPT = `(()=>{
var m=document.getElementById('main'),v=m&&m.getAttribute('data-live');if(!v)return;
var st=document.getElementById('livestat'),tx=document.getElementById('livetext'),last={},stop=false,busy=false,again=false;
function set(s,t){if(st&&tx){st.setAttribute('data-state',s);tx.textContent=t}}
function url(){var q=new URLSearchParams(location.search);q.set('view',v);var pm=location.pathname.match(/\\/sessions\\/([^\\/]+)$/);if(pm)q.set('id',pm[1]);return '/dashboard/live?'+q.toString()}
function keep(el){var o=[];el.querySelectorAll('details[id][open]').forEach(function(d){o.push(d.id)});return o}
function restore(el,o){o.forEach(function(i){var d=document.getElementById(i);if(d&&el.contains(d))d.open=true})}
function tick(){
if(stop||document.visibilityState!=='visible')return;
if(busy){again=true;return}
busy=true;
fetch(url(),{headers:{accept:'application/json'},cache:'no-store',credentials:'same-origin'}).then(function(r){
if(r.status===401){stop=true;set('expired','Session expired —');return null}
if(!r.ok)throw new Error('http '+r.status);
return r.json()}).then(function(j){
if(!j)return;
var p=j.parts||{};
for(var id in p){var el=document.getElementById(id);if(el&&typeof p[id]==='string'&&last[id]!==p[id]){if(last[id]!==undefined||el.innerHTML!==p[id]){var o=keep(el);el.innerHTML=p[id];restore(el,o)}last[id]=p[id]}}
set('ok','Updated '+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}))
}).catch(function(){set('retry','Reconnecting…')}).then(function(){busy=false;if(again){again=false;tick()}})}
setInterval(tick,15000);
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')tick()});
function rowGo(e){
var t=e.target;if(!t||!t.closest||e.defaultPrevented||e.button!==(e.type==='auxclick'?1:0))return;
if(t.closest('a,button,input,select,textarea,form,label,summary'))return;
var r=t.closest('tr[data-href]'),h=r&&r.getAttribute('data-href');if(!h)return;
if(e.type==='auxclick'||e.metaKey||e.ctrlKey||e.shiftKey)window.open(h,'_blank','noopener');else location.href=h}
document.addEventListener('click',rowGo);
document.addEventListener('auxclick',rowGo);
document.addEventListener('click',function(e){
var a=e.target&&e.target.closest?e.target.closest('.live a.tab'):null;
if(!a||stop||e.defaultPrevented||e.button||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
e.preventDefault();var u=new URL(a.href);history.replaceState(null,'',u.pathname+u.search);tick()});
})()`;

// ---- shell ---------------------------------------------------------------------
export type PageId = 'overview' | 'challenges' | 'settings' | 'requests' | 'logs';

export interface ChromeData {
  user: { username: string; avatar: string | null };
  /** Dokploy deployment status; null/undefined = not configured (indicator hidden). */
  deploy?: DeployStatus;
}

const ICON = (path: string): string => `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const NAV: { id: PageId; href: string; label: string; icon: string }[] = [
  { id: 'overview', href: '/dashboard', label: 'Overview', icon: ICON('<rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="11" y="3" width="6" height="6" rx="1.5"/><rect x="3" y="11" width="6" height="6" rx="1.5"/><rect x="11" y="11" width="6" height="6" rx="1.5"/>') },
  { id: 'challenges', href: '/dashboard/challenges', label: 'Challenges', icon: ICON('<path d="M6.5 3.5h7v4a3.5 3.5 0 0 1-7 0z"/><path d="M6.5 5H3.5v1.2A3 3 0 0 0 6.5 9.2M13.5 5h3v1.2a3 3 0 0 1-3 3M10 11v3.5M7 17.5h6"/>') },
  { id: 'settings', href: '/dashboard/settings', label: 'Settings', icon: ICON('<path d="M3 6h7M14 6h3M3 14h3M10 14h7"/><circle cx="12" cy="6" r="2"/><circle cx="8" cy="14" r="2"/>') },
  { id: 'requests', href: '/dashboard/requests', label: 'Requests', icon: ICON('<path d="M4 4.5h12a1.5 1.5 0 0 1 1.5 1.5v6.5A1.5 1.5 0 0 1 16 14h-5.5L7 17v-3H4a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 4 4.5z"/><path d="M6.5 8h7M6.5 10.8h4"/>') },
  { id: 'logs', href: '/dashboard/logs', label: 'Logs', icon: ICON('<rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="m6 8 2.5 2L6 12M10.5 12.5h3.5"/>') },
];
const LOGOUT_ICON = ICON('<path d="M8 3.5H5A1.5 1.5 0 0 0 3.5 5v10A1.5 1.5 0 0 0 5 16.5h3M12.5 13.5 16 10l-3.5-3.5M16 10H7.5"/>');

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="dark light"><meta name="theme-color" content="#101012" media="(prefers-color-scheme: dark)"><meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)"><link rel="icon" href="/bot-avatar"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

/** "5 min ago" style age of a timestamp. Pure. */
export function fmtAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/**
 * Deployment status pill ('' when the feature is off). `compact` drops the deployment title
 * (sidebar / top bar). Pure.
 */
export function deployPill(deploy: DeployStatus | undefined, now: number, compact = false): string {
  if (!deploy) return '';
  let cls = 'off';
  let label = 'Deploy status unavailable';
  let pulse = false;
  let title: string | null = null;
  if (deploy.ok) {
    title = deploy.title;
    if (deploy.state === 'running') {
      cls = 'warn';
      pulse = true;
      label = 'Deploying';
    } else if (deploy.state === 'done') {
      cls = 'ok';
      const at = deploy.finishedAt ?? deploy.startedAt;
      label = at ? `Deployed ${fmtAgo(at, now)}` : 'Deployed';
    } else if (deploy.state === 'error') {
      cls = 'err';
      label = 'Deploy failed';
    } else title = null;
  }
  const full = title ? `${label} · ${title}` : label;
  const tail = title && !compact ? `<span aria-hidden="true">·</span><span class="trunc">${escapeHtml(title)}</span>` : '';
  return `<span class="pill ${cls}" title="${escapeHtml(full)}"><i class="dot${pulse ? ' pulse' : ''}"></i><span class="vh">${escapeHtml(full)}</span><span class="t" aria-hidden="true">${escapeHtml(label)}</span>${tail}</span>`;
}

/** Live parts of the shell (sidebar / top bar), keyed by element id. */
export function chromeParts(deploy: DeployStatus | undefined, now: number = Date.now()): Record<string, string> {
  return deploy ? { 'live-deploy': deployPill(deploy, now, true) } : {};
}

interface PageOpts {
  active: PageId;
  title: string;
  /** HTML placed under the h1 in the page header card. */
  sub: string;
  /** Regions refreshed by LIVE_SCRIPT; 'status' also shows the "Updated ..." indicator. */
  live: 'status' | 'quiet' | 'none';
  /** HTML between the page header and the content (sticky section nav). */
  between?: string;
  body: string;
  now?: number;
  /** `view` sent to /dashboard/live when it differs from `active` (the session page). */
  liveView?: string;
}

function layout(o: PageOpts, chrome: ChromeData): string {
  const nav = NAV.map((n) => `<a href="${n.href}"${n.id === o.active ? ' aria-current="page"' : ''}>${n.icon}<span>${n.label}</span></a>`).join('');
  const u = chrome.user;
  const avatar = u.avatar
    ? `<img class="me-av" src="${escapeHtml(u.avatar)}" alt="">`
    : `<span class="me-av" aria-hidden="true">${escapeHtml(Array.from(u.username)[0]?.toUpperCase() ?? '?')}</span>`;
  const deploy = chrome.deploy ? `<div class="side-deploy live" id="live-deploy">${deployPill(chrome.deploy, o.now ?? Date.now(), true)}</div>` : '';
  const header = `<header class="chrome"><a class="brand" href="/dashboard" aria-label="Bojan, overview">${mark(28)}<span>Bojan</span></a><span class="chrome-title" aria-hidden="true">${escapeHtml(o.title)}</span><nav class="nav" aria-label="Main">${nav}</nav><div class="me">${deploy}<div class="me-user">${avatar}<span class="me-name" title="${escapeHtml(u.username)}">${escapeHtml(u.username)}</span><a class="logout" href="/logout" title="Log out" aria-label="Log out">${LOGOUT_ICON}</a></div></div></header>`;
  const stat = o.live === 'status' ? '<span class="livestat" id="livestat" data-state="ok"><i></i><span id="livetext">Live</span><a href="">reload</a></span>' : '';
  const hero = `<div class="hero"><div class="hero-in"><div class="pagehead"><div class="pagehead-top"><h1>${escapeHtml(o.title)}</h1>${stat}</div>${o.sub}</div></div></div>`;
  const live = o.live === 'none' || (o.live === 'quiet' && !chrome.deploy) ? '' : ` data-live="${escapeHtml(o.liveView ?? o.active)}"`;
  return page(`${o.title} · Bojan`, `<a class="skip" href="#main">Skip to content</a>${header}<main class="main" id="main"${live}>${SKY}${hero}${o.between ?? ''}<div class="wrap">${o.body}</div></main>${live ? `<script>${LIVE_SCRIPT}</script>` : ''}`);
}

const SKY = '<div class="sky" aria-hidden="true"></div>';

function authCard(title: string, text: string, button: string): string {
  return page(`${title} · Bojan`, `<main class="center" id="main">${SKY}<div class="auth">${mark(56)}<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>${button}</div></main>`);
}

export function loginPage(discordAuthUrl: string): string {
  return authCard('Bojan dashboard', 'Sign in with Discord. Only server administrators can access this.', `<a class="btn" href="${escapeHtml(discordAuthUrl)}">Sign in with Discord</a>`);
}

export function errorPage(message: string): string {
  return authCard('Access denied', message, '<a class="btn ghost" href="/login">Try again</a>');
}

export type Members = Record<string, { name: string; avatar: string | null }>;

export interface BotStatus {
  ping: number;
  uptimeSec: number;
  guilds: number;
  totalMessages: number;
  dbBytes: number;
  lastWeeklySent: string | null;
  embedsConverted: number;
  errors24h: number;
}

/** Everything the Overview page shows. The live endpoint renders the same data (minus embeds). */
export interface OverviewData {
  timezone: string;
  botStatus: BotStatus;
  /** Dokploy deployment status; null/undefined = not configured. */
  deploy?: DeployStatus;
  today: number;
  week: {
    /** Which week the dashboard leaderboard is showing (`?week=current|last`, default current). */
    selected: 'current' | 'last';
    current: { bounds: WeekBounds; total: number; rows: UserRow[] };
    last: { bounds: WeekBounds; total: number; rows: UserRow[] };
  };
  allTime: { total: number; rows: UserRow[] };
  /** Channel message leaderboards; the same `?week=` selection as the user week card. */
  channelWeek: {
    current: { bounds: WeekBounds; total: number; rows: ChannelRow[] };
    last: { bounds: WeekBounds; total: number; rows: ChannelRow[] };
  };
  channelAllTime: { total: number; rows: ChannelRow[] };
  reactions: { total: number; top: EmojiRow[] };
  recentEmbeds: EmbedLogRow[];
  embedPage: { page: number; pages: number; total: number; pageSize: number };
  members: Members;
  channelNames: Record<string, string>;
  /** Total XP per member, for level tags next to leaderboard rows. */
  xpByUser: Record<string, number>;
  user: { id: string; username: string; avatar: string | null };
  you: YouData;
}
export type DashboardData = OverviewData;

export interface SettingsPageData {
  settings: Settings;
  channels: { id: string; name: string }[];
  user: { username: string; avatar: string | null };
  deploy?: DeployStatus;
  saved: boolean;
  weeklyFlash: { kind: 'sent' } | { kind: 'error'; reason: string } | null;
  monthlyFlash: { kind: 'sent' } | { kind: 'error'; reason: string } | null;
  free: {
    settings: FreeSettings;
    roles: { id: string; name: string }[];
    webhookEnabled: boolean;
    postedCount: number;
    flash: { kind: 'saved' } | null;
  };
  builder: BuilderSectionData;
  color: {
    /** Channel the per-role picker messages are posted in. */
    channelId: string | null;
    /** Roles that can be used as name colours (all non-managed roles). */
    roles: { id: string; name: string }[];
    selected: string[];
    posted: number;
    /** The bot has Manage Roles in this guild. */
    canManage: boolean;
    flash: { kind: 'saved' } | { kind: 'error'; reason: string } | null;
  };
}

export interface BuilderSectionData {
  settings: BuilderSettings;
  passwordSet: boolean;
  /** null when OPENCODE_PASSWORD is unset (nothing to probe). */
  agent: AgentStatus | null;
  flash: { kind: 'saved' } | { kind: 'error'; reason: string } | null;
}

export interface ChallengeProgressRow extends ProgressRow {
  name: string;
}

export interface ChallengeListItem {
  challenge: Challenge;
  status: ChallengeStatus;
  joined: number;
}

export interface ChallengesPageData {
  wizard: { step: ChallengeWizardStep; draft: ChallengeDraft; errors: string[] };
  list: ChallengeListItem[];
  counts: { all: number; upcoming: number; active: number; ended: number };
  status: 'all' | ChallengeStatus;
  sort: ChallengeSort;
  page: number;
  pages: number;
  pageSize: number;
  total: number;
  channels: { id: string; name: string }[];
  roles: { id: string; name: string }[];
  activityNames: string[];
  canManageRoles: boolean;
  timezone: string;
  flash: { kind: 'saved' | 'error'; message: string } | null;
  user: { username: string; avatar: string | null };
  deploy?: DeployStatus;
}

export type ChallengeTab = 'overview' | 'progress' | 'entries' | 'activity';

/** Ranked rows of one goal. */
export interface ChallengeGoalStanding {
  goal: ChallengeGoal;
  rows: ChallengeProgressRow[];
}

export interface ChallengeEntryView {
  entry: ChallengeEntry;
  goal: ChallengeGoal;
}

export interface ChallengeDetailData {
  challenge: Challenge;
  status: ChallengeStatus;
  tab: ChallengeTab;
  joined: number;
  /** Every goal with its full ranked leaderboard. */
  goals: ChallengeGoalStanding[];
  progress: { page: number; pages: number; pageSize: number; total: number };
  entries: { rows: ChallengeEntryView[]; page: number; pages: number; pageSize: number; total: number; flaggedOnly: boolean };
  events: { rows: ChallengeEvent[]; page: number; pages: number; pageSize: number; total: number };
  timezone: string;
  channelName: string;
  canManageRoles: boolean;
  flash: { kind: 'saved' | 'error'; message: string } | null;
  user: { username: string; avatar: string | null };
  deploy?: DeployStatus;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const kpi = (value: string, label: string, note?: string): string =>
  `<div class="kpi"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b>${note ? `<small>${escapeHtml(note)}</small>` : ''}</div>`;

function emptyState(text: string): string {
  return `<p class="empty">${escapeHtml(text)}</p>`;
}

const statusPill = (cls: 'ok' | 'warn' | 'err' | 'off' | '', text: string): string => `<span class="pill ${cls}"><i class="dot"></i>${escapeHtml(text)}</span>`;

/** The logged-in user as seen by a leaderboard: their id and real rank (null = no messages in range). */
export interface LeaderboardYou {
  userId: string;
  rank: { rank: number; messages: number } | null;
}

/** Medal for a leaderboard rank (1-3), or null for the rest. */
const MEDALS = ['🥇', '🥈', '🥉'] as const;
export function medalFor(rank: number): string | null {
  return Number.isInteger(rank) && rank >= 1 && rank <= MEDALS.length ? (MEDALS[rank - 1] ?? null) : null;
}

/** Week leaderboard tabs; the selected one is plain text with aria-current, the others links. */
export function weekTabs(selected: 'current' | 'last', hash = 'h-week', label = 'Leaderboard week'): string {
  const tab = (value: 'current' | 'last', text: string): string =>
    value === selected
      ? `<span class="tab" aria-current="page">${escapeHtml(text)}</span>`
      : `<a class="tab" href="/dashboard?week=${value}#${escapeHtml(hash)}">${escapeHtml(text)}</a>`;
  return `<nav class="tabs" aria-label="${escapeHtml(label)}">${tab('current', 'This week')}${tab('last', 'Last week')}</nav>`;
}

function lbRow(rank: number, userId: string, messages: number, total: number, members: Members, opts: { top: boolean; you: boolean; extra: boolean; lvl: string | null }): string {
  const m = members[userId];
  const name = m?.name ?? userId;
  const avatar = m?.avatar
    ? `<img class="av" src="${escapeHtml(m.avatar)}" alt="" loading="lazy">`
    : `<span class="av" aria-hidden="true">${escapeHtml(Array.from(name)[0]?.toUpperCase() ?? '?')}</span>`;
  const pct = total > 0 ? Math.min(100, (messages / total) * 100) : 0;
  const classes = [opts.top ? 'top' : '', opts.you ? 'you' : '', opts.extra ? 'extra' : ''].filter(Boolean).join(' ');
  const lvl = opts.lvl ? `<span class="lvl">${escapeHtml(opts.lvl)}</span>` : '';
  const nameCell = opts.you
    ? `<span class="name" title="${escapeHtml(name)}"><span class="nm">${escapeHtml(name)}</span>${lvl}<span class="you-tag">You</span></span>`
    : `<span class="name" title="${escapeHtml(name)}"><span class="nm">${escapeHtml(name)}</span>${lvl}</span>`;
  const medal = medalFor(rank);
  const rankCell = medal
    ? `<span class="rank medal" aria-label="Rank ${rank}"><span aria-hidden="true">${medal}</span></span>`
    : `<span class="rank">${rank}</span>`;
  return `<li${classes ? ` class="${classes}"` : ''}${opts.you ? ' aria-current="true"' : ''}>${rankCell}${avatar}${nameCell}<span class="num">${fmt(messages)}</span><div class="share"><div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div><span class="pct">${total > 0 ? pct.toFixed(1) + '%' : '—'}</span></div></li>`;
}

// Pure: plain data in, HTML out. The row of `you` is highlighted; when they rank
// below the shown rows, their real position is appended as a separated extra row.
export function leaderboard(rows: UserRow[], total: number, members: Members, you?: LeaderboardYou, xpByUser?: Record<string, number>, empty = 'No messages yet.'): string {
  if (rows.length === 0) return emptyState(empty);
  const lvl = (userId: string): string | null => levelTag(xpByUser?.[userId] ?? null);
  const items = rows.map((r, i) => lbRow(i + 1, r.userId, r.messages, total, members, { top: i < 3, you: you?.userId === r.userId, extra: false, lvl: lvl(r.userId) }));
  if (you && you.rank && !rows.some((r) => r.userId === you.userId)) {
    items.push('<li class="gap" aria-hidden="true"><span class="rank">⋯</span></li>');
    items.push(lbRow(you.rank.rank, you.userId, you.rank.messages, total, members, { top: false, you: true, extra: true, lvl: lvl(you.userId) }));
  }
  return `<ol class="lb">${items.join('')}</ol>`;
}

// Pure: channel message leaderboard. No avatars, "you" row or level tags.
export function channelLeaderboard(rows: ChannelRow[], total: number, names: Record<string, string>, empty = 'No messages yet.'): string {
  if (rows.length === 0) return emptyState(empty);
  const items = rows.map((r, i) => {
    const name = names[r.channelId] ?? r.channelId;
    const pct = total > 0 ? Math.min(100, (r.count / total) * 100) : 0;
    const medal = medalFor(i + 1);
    const rankCell = medal
      ? `<span class="rank medal" aria-label="Rank ${i + 1}"><span aria-hidden="true">${medal}</span></span>`
      : `<span class="rank">${i + 1}</span>`;
    return `<li${i < 3 ? ' class="top"' : ''}>${rankCell}<span class="name" title="${escapeHtml(name)}"><span class="nm">#${escapeHtml(name)}</span></span><span class="num">${fmt(r.count)}</span><div class="share"><div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div><span class="pct">${total > 0 ? pct.toFixed(1) + '%' : '—'}</span></div></li>`;
  });
  return `<ol class="chanlb">${items.join('')}</ol>`;
}

export interface YouData {
  allRank: { rank: number; messages: number } | null;
  currentWeekRank: { rank: number; messages: number } | null;
  lastWeekRank: { rank: number; messages: number } | null;
  /** Total XP of the logged-in user, for the level progress row. */
  xp: number | null;
  stats: UserStats;
  reactions: ReactionStats;
  voice: VoiceStats;
  activityMs: number;
  topActivities: ActivityAggregateRow[];
  topVoice: VoiceChannelRow[];
  emojiGiven: EmojiRow[];
  emojiReceived: EmojiRow[];
  nowPlaying: CurrentActivityRow[];
  inVoice: CurrentVoiceRow | null;
}

const miniList = (items: { label: string; value: string }[]): string =>
  `<ul class="mini">${items.map((i) => `<li><span class="name" title="${escapeHtml(i.label)}">${escapeHtml(i.label)}</span><span class="val">${escapeHtml(i.value)}</span></li>`).join('')}</ul>`;

const miniBlock = (title: string, inner: string): string => `<div><h3 class="mini-h">${escapeHtml(title)}</h3>${inner}</div>`;

/** Hollow Steam-style level badge: transparent fill, 3px band-coloured outline, level number inside. */
export function levelBadge(level: number): string {
  const steam = steamLevelColors(level);
  const outline = steamLevelOutline(level);
  const digits = String(level).length;
  const fontSize = digits <= 2 ? 19 : digits === 3 ? 15 : 12;
  return `<svg class="levelbadge" viewBox="0 0 52 52" data-shape="${escapeHtml(steamLevelShape(level))}" data-len="${digits}" role="img" aria-label="Level ${level}" style="--lv-from:${escapeHtml(steam.from)};--lv-to:${escapeHtml(steam.to)}"><${outline.tag} ${outline.attrs} fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"></${outline.tag}><text x="26" y="26" text-anchor="middle" dominant-baseline="central" font-size="${fontSize}" fill="currentColor">${level}</text></svg>`;
}

/** Level and XP progress as one row: level on the left, rounded bar with the numbers above it. */
export function levelBar(xp: number): string {
  const { level, intoLevel, needed } = levelProgress(xp);
  const span = intoLevel + needed;
  const pct = span > 0 ? Math.min(100, (intoLevel / span) * 100) : 0;
  const band = steamLevelColors(level);
  const fill = `<i style="width:${pct.toFixed(1)}%;--lv-from:${escapeHtml(band.from)};--lv-to:${escapeHtml(band.to)}"></i>`;
  const badge = levelBadge(level);
  return `<div class="levelrow"><div class="levelno">${badge}<span class="levelcap">Level</span></div><div class="levelmeter"><span class="levelnums">${fmt(intoLevel)} / ${fmt(span)} XP</span><div class="levelbar" role="progressbar" aria-label="Level ${level} progress" aria-valuemin="0" aria-valuemax="${span}" aria-valuenow="${intoLevel}" aria-valuetext="${fmt(intoLevel)} of ${fmt(span)} XP">${fill}</div></div></div>`;
}

// Pure: "Your stats" card for the logged-in user.
export function youSection(y: YouData, ctx: { total: number; timezone: string; channelNames: Record<string, string>; username: string }): string {
  const hasData = y.stats.messages > 0 || y.reactions.given > 0 || y.reactions.received > 0 || y.voice.sessions > 0 || y.activityMs > 0 || y.topActivities.length > 0;
  const head = `<div class="card-head"><h2 id="h-you">Your stats</h2><span class="sub">${escapeHtml(ctx.username)}</span></div>`;
  if (!hasData) return `<section id="you" class="card" aria-labelledby="h-you">${head}${emptyState('No tracked activity for you yet.')}</section>`;

  const allPct = ctx.total > 0 ? Math.min(100, (y.stats.messages / ctx.total) * 100) : 0;
  const allNote = [y.allRank ? `#${fmt(y.allRank.rank)}` : null, ctx.total > 0 && y.stats.messages > 0 ? `${allPct.toFixed(1)}% of server` : null].filter(Boolean).join(' · ');
  const chan = (id: string): string => (ctx.channelNames[id] ? '#' + ctx.channelNames[id] : id);

  const kpis = [
    kpi(fmt(y.stats.messages), 'Messages, all time', allNote || undefined),
    kpi(fmt(y.lastWeekRank?.messages ?? 0), 'Messages, last week', y.lastWeekRank ? `#${fmt(y.lastWeekRank.rank)}` : 'not ranked'),
    kpi(y.activityMs > 0 ? fmtDuration(y.activityMs) : '—', 'Activity time', y.topActivities[0] ? `top: ${y.topActivities[0].name}` : 'none tracked'),
    kpi(fmt(y.reactions.given), 'Reactions given', `${fmt(y.reactions.received)} received`),
    kpi(y.voice.totalMs > 0 ? fmtDuration(y.voice.totalMs) : '—', 'Time in voice', y.voice.totalMs > 0 ? `${fmt(y.voice.sessions)} session${y.voice.sessions === 1 ? '' : 's'}` : 'no voice time'),
  ].join('');
  const levelRow = y.xp !== null ? levelBar(y.xp) : '';

  const range = `<p class="muted">First message ${escapeHtml(fmtDate(y.stats.firstTs, ctx.timezone))} · last message ${escapeHtml(fmtDate(y.stats.lastTs, ctx.timezone))}</p>`;
  const live: string[] = [];
  for (const a of y.nowPlaying) live.push(`${activityTypeLabel(a.type)} ${a.name}`);
  if (y.inVoice) live.push(`🔊 In voice: ${chan(y.inVoice.channelId)}`);
  const liveHtml = live.length > 0 ? `<p class="muted">Right now: ${escapeHtml(live.join(' · '))}</p>` : '';

  const blocks: string[] = [];
  if (y.emojiGiven.length > 0) blocks.push(miniBlock('Emoji you give', `<ul class="emojis">${y.emojiGiven.map(emojiChip).join('')}</ul>`));
  if (y.emojiReceived.length > 0) blocks.push(miniBlock('Emoji you receive', `<ul class="emojis">${y.emojiReceived.map(emojiChip).join('')}</ul>`));
  if (y.topActivities.length > 0) blocks.push(miniBlock('Top activities', miniList(y.topActivities.slice(0, 5).map((a) => ({ label: a.name, value: `${fmtDuration(a.totalMs)} · ${fmt(a.sessions)} session${a.sessions === 1 ? '' : 's'}` })))));
  if (y.topVoice.length > 0) blocks.push(miniBlock('Top voice channels', miniList(y.topVoice.slice(0, 3).map((v) => ({ label: chan(v.channelId), value: `${fmtDuration(v.totalMs)} · ${fmt(v.sessions)} session${v.sessions === 1 ? '' : 's'}` })))));

  return `<section id="you" class="card" aria-labelledby="h-you">${head}<div class="kpis">${kpis}</div>${levelRow}${range}${liveHtml}${blocks.length > 0 ? `<div class="cols you-cols">${blocks.join('')}</div>` : ''}</section>`;
}

// Custom emoji labels look like <:name:id> / <a:name:id>; render them as images.
function emojiChip(e: EmojiRow): string {
  const custom = /^<(a?):([^:>]+):(\d+)>$/.exec(e.emojiLabel);
  const glyph = custom
    ? `<img src="https://cdn.discordapp.com/emojis/${custom[3]}.${custom[1] ? 'gif' : 'webp'}?size=48" alt="${escapeHtml(custom[2] ?? '')}" title=":${escapeHtml(custom[2] ?? '')}:" loading="lazy">`
    : escapeHtml(e.emojiLabel);
  return `<li>${glyph}<small>${fmt(e.count)}</small></li>`;
}

function uptime(sec: number): string {
  const days = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return days > 0 ? `${days}d ${h}h` : `${h}h ${m}m`;
}

/** Health line of the Overview: status pills, including the deployment pill when configured. Pure. */
export function healthPills(b: BotStatus, deploy: DeployStatus | undefined, now: number): string {
  const errors = `${fmt(b.errors24h)} error${b.errors24h === 1 ? '' : 's'} in 24h`;
  return [
    b.ping >= 0 ? statusPill('ok', `Online · ${b.ping} ms`) : statusPill('warn', 'Connecting…'),
    deployPill(deploy, now),
    `<a class="pill ${b.errors24h > 0 ? 'err' : ''}" href="/dashboard/logs?level=error"><i class="dot"></i>${escapeHtml(errors)}</a>`,
    statusPill('', `Up ${uptime(b.uptimeSec)}`),
    statusPill('', `Database ${(b.dbBytes / 1024 / 1024).toFixed(2)} MB`),
    statusPill('', `Weekly stats last sent ${b.lastWeeklySent ?? 'never'}`),
  ].join('');
}

/**
 * The Overview's live regions, keyed by element id. The full page and GET /dashboard/live both
 * render through this, so a refreshed region is byte-identical to a freshly loaded one.
 */
export function overviewParts(d: OverviewData, now: number = Date.now()): Record<string, string> {
  const b = d.botStatus;
  const wk = d.week.selected === 'current' ? d.week.current : d.week.last;
  const weekSub = `${weekRangeLabel(wk.bounds, d.timezone)}${d.week.selected === 'current' ? ' · in progress' : ''} · ${fmt(wk.total)} messages`;
  const weekYouRank = d.week.selected === 'current' ? d.you.currentWeekRank : d.you.lastWeekRank;
  const wkChannels = d.week.selected === 'current' ? d.channelWeek.current : d.channelWeek.last;
  return {
    ...chromeParts(d.deploy, now),
    'live-health': healthPills(b, d.deploy, now),
    'live-kpis': [
      kpi(fmt(d.today), 'Messages today'),
      kpi(fmt(d.week.last.total), 'Last week'),
      kpi(fmt(d.allTime.total), 'All time'),
      kpi(fmt(d.reactions.total), 'Reactions'),
      kpi(fmt(b.embedsConverted), 'Embeds converted'),
    ].join(''),
    'live-you': youSection(d.you, { total: d.allTime.total, timezone: d.timezone, channelNames: d.channelNames, username: d.user.username }),
    'live-week': `<section class="card" aria-labelledby="h-week"><div class="card-head"><h2 id="h-week">Week leaderboard</h2><span class="sub">${escapeHtml(weekSub)}</span></div>${weekTabs(d.week.selected)}${leaderboard(wk.rows, wk.total, d.members, { userId: d.user.id, rank: weekYouRank }, d.xpByUser, d.week.selected === 'current' ? 'No messages yet this week.' : 'No messages last week.')}</section>`,
    'live-all': `<section class="card" aria-labelledby="h-all"><div class="card-head"><h2 id="h-all">All time</h2><span class="sub">${fmt(d.allTime.total)} messages</span></div>${leaderboard(d.allTime.rows, d.allTime.total, d.members, { userId: d.user.id, rank: d.you.allRank }, d.xpByUser)}</section>`,
    'live-chan-week': `<section class="card" aria-labelledby="h-chan-week"><div class="card-head"><h2 id="h-chan-week">Channel leaderboard</h2><span class="sub">${escapeHtml(weekSub)}</span></div>${weekTabs(d.week.selected, 'h-chan-week', 'Channel leaderboard week')}${channelLeaderboard(wkChannels.rows, wkChannels.total, d.channelNames, d.week.selected === 'current' ? 'No messages yet this week.' : 'No messages last week.')}</section>`,
    'live-chan-all': `<section class="card" aria-labelledby="h-chan-all"><div class="card-head"><h2 id="h-chan-all">Channels, all time</h2><span class="sub">${fmt(d.channelAllTime.total)} messages</span></div>${channelLeaderboard(d.channelAllTime.rows, d.channelAllTime.total, d.channelNames)}</section>`,
    'live-react': `<section class="card" aria-labelledby="h-react"><div class="card-head"><h2 id="h-react">Reactions</h2><span class="sub">${fmt(d.reactions.total)} tracked</span></div>${d.reactions.top.length === 0 ? emptyState('No reactions tracked yet.') : `<ul class="emojis">${d.reactions.top.map(emojiChip).join('')}</ul><p class="muted">Most used emoji server-wide. Per-member emoji are in the <code>/stats</code> command in Discord.</p>`}</section>`,
  };
}

function embedRows(d: OverviewData): string {
  const rows = d.recentEmbeds.map((e) => {
    const channel = d.channelNames[e.channelId];
    return `<tr><td class="dim" data-label="Time">${escapeHtml(fmtDate(e.ts, d.timezone))}</td><td data-label="Channel">${channel ? '#' + escapeHtml(channel) : escapeHtml(e.channelId)}</td><td data-label="Provider"><span class="badge">${escapeHtml(e.provider)}</span></td><td class="url" data-label="URL"><a href="${escapeHtml(e.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(e.url)}">${escapeHtml(e.url)}</a></td></tr>`;
  });
  return `<div class="tbl"><table><thead><tr><th scope="col">Time</th><th scope="col">Channel</th><th scope="col">Provider</th><th scope="col">URL</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

/** Selectable rows per page on every paginated table; the first is the default. */
export const PAGE_SIZES = [10, 20, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 10;

/** Page size from a query value: one of PAGE_SIZES, anything else (or missing) -> 10. */
export function parsePageSize(raw: string | undefined): number {
  const n = Number(raw);
  return (PAGE_SIZES as readonly number[]).includes(n) ? n : DEFAULT_PAGE_SIZE;
}

/**
 * Shared Previous / "Page X of Y" / Next pager. `href` builds the (unescaped) link of a page;
 * it is escaped here. One page: just the summary when `showSingle`, otherwise nothing. Pure.
 */
export function pagerHtml(o: { page: number; pages: number; summary: string; href: (page: number) => string; label: string; showSingle?: boolean; size?: { current: number; href: (size: number) => string } }): string {
  const sizeSelect = o.size
    ? `<select class="pager-size" aria-label="Rows per page" onchange="location.href=this.value">${PAGE_SIZES.map((n) => `<option value="${escapeHtml(o.size!.href(n))}"${n === o.size!.current ? ' selected' : ''}>${n} rows</option>`).join('')}</select>`
    : '';
  const showing = `<p class="muted">${escapeHtml(o.summary)}</p>${sizeSelect}`;
  if (o.pages <= 1) return o.showSingle ? `<div class="pager">${showing}</div>` : '';
  const step = (label: string, target: number, enabled: boolean): string =>
    enabled ? `<a class="pager-btn" href="${escapeHtml(o.href(target))}">${label}</a>` : `<span class="pager-btn" aria-disabled="true">${label}</span>`;
  return `<div class="pager">${showing}<nav class="pager-nav" aria-label="${escapeHtml(o.label)}">${step('Previous', o.page - 1, o.page > 1)}<span>Page ${o.page} of ${o.pages}</span>${step('Next', o.page + 1, o.page < o.pages)}</nav></div>`;
}

/** "1–50 of 1,234" (or "0" when empty). */
export function rangeSummary(page: number, pageSize: number, shown: number, total: number): string {
  if (total === 0 || shown === 0) return `${fmt(total)}`;
  const from = (page - 1) * pageSize + 1;
  return `${fmt(from)}–${fmt(from + shown - 1)} of ${fmt(total)}`;
}

function embedPager(d: OverviewData): string {
  const { page, pages, total, pageSize } = d.embedPage;
  const href = (p: number, size: number): string => {
    const q = new URLSearchParams();
    if (p > 1) q.set('embedsPage', String(p));
    if (size !== DEFAULT_PAGE_SIZE) q.set('embedsSize', String(size));
    const qs = q.toString();
    return `/dashboard${qs ? '?' + qs : ''}#h-embeds`;
  };
  return pagerHtml({ page, pages, summary: `Showing ${rangeSummary(page, pageSize, d.recentEmbeds.length, total)}`, href: (p) => href(p, pageSize), label: 'Embed conversions pages', showSingle: true, size: { current: pageSize, href: (s) => href(1, s) } });
}

const region = (id: string, parts: Record<string, string>, cls = ''): string => `<div class="live${cls ? ' ' + cls : ''}" id="${id}">${parts[id] ?? ''}</div>`;

export function dashboardPage(d: OverviewData, now: number = Date.now()): string {
  const parts = overviewParts(d, now);
  const body = `
  ${region('live-kpis', parts, 'kpis')}
  ${region('live-you', parts)}
  <div class="cols">${region('live-week', parts)}${region('live-all', parts)}</div>
  <div class="cols">${region('live-chan-week', parts)}${region('live-chan-all', parts)}</div>
  ${region('live-react', parts)}
  <section class="card" aria-labelledby="h-embeds"><div class="card-head"><h2 id="h-embeds">Embed conversions</h2><span class="sub">${fmt(d.embedPage.total)} converted</span></div>
    ${d.recentEmbeds.length === 0 ? emptyState('Nothing converted yet.') : embedRows(d) + embedPager(d)}
  </section>`;
  const sub = `<div class="live pills" id="live-health" role="group" aria-label="Bot health">${parts['live-health'] ?? ''}</div>`;
  return layout({ active: 'overview', title: 'Overview', sub, live: 'status', body, now }, { user: d.user, deploy: d.deploy });
}

// ---- settings ------------------------------------------------------------------
interface RowOpts {
  id: string;
  label: string;
  help?: string;
  control: string;
  /** Stack the control under the label (chip groups). */
  block?: boolean;
  split?: boolean;
}
// A setting: label + help on the left, control on the right (stacked on phones).
function row(o: RowOpts): string {
  return `<div class="row${o.block ? ' block' : ''}"><div class="row-l"><label for="${escapeHtml(o.id)}">${escapeHtml(o.label)}</label>${o.help ? `<span class="help" id="${escapeHtml(o.id)}-help">${escapeHtml(o.help)}</span>` : ''}</div><div class="row-c${o.split ? ' split' : ''}">${o.control}</div></div>`;
}
// A group of chip toggles under a group label (not a single input, so a fieldset-like group).
function chipRow(id: string, label: string, help: string, chips: string, long = false): string {
  return `<div class="row block" role="group" aria-labelledby="${escapeHtml(id)}"><div class="row-l"><span class="lbl" id="${escapeHtml(id)}">${escapeHtml(label)}</span>${help ? `<span class="help">${escapeHtml(help)}</span>` : ''}</div><div class="chips${long ? ' long' : ''}">${chips}</div></div>`;
}
function toggleRow(name: string, on: boolean, label: string, help: string): string {
  return `<label class="row switch"><span class="row-l"><span class="lbl">${escapeHtml(label)}</span><span class="help">${escapeHtml(help)}</span></span><span class="row-c"><input type="checkbox" name="${escapeHtml(name)}" value="1"${on ? ' checked' : ''}><span class="track"></span></span></label>`;
}
function chip(name: string, value: string, on: boolean, label: string, title?: string): string {
  return `<label class="chip"${title ? ` title="${escapeHtml(title)}"` : ''}><input type="checkbox" name="${escapeHtml(name)}" value="${escapeHtml(value)}"${on ? ' checked' : ''}><span>${escapeHtml(label)}</span></label>`;
}
const selectEl = (id: string, name: string, options: string, describedBy = true): string => `<select id="${escapeHtml(id)}" name="${escapeHtml(name)}"${describedBy ? ` aria-describedby="${escapeHtml(id)}-help"` : ''}>${options}</select>`;
const textEl = (id: string, name: string, value: string, mono: boolean): string =>
  `<input type="text" id="${escapeHtml(id)}" name="${escapeHtml(name)}" value="${escapeHtml(value)}" aria-describedby="${escapeHtml(id)}-help" autocomplete="off"${mono ? ' class="mono" spellcheck="false" autocapitalize="off"' : ''}>`;
const numberEl = (id: string, name: string, value: number, min: number, max: number): string =>
  `<input type="number" id="${escapeHtml(id)}" name="${escapeHtml(name)}" min="${min}" max="${max}" step="1" inputmode="numeric" value="${escapeHtml(String(value))}" aria-describedby="${escapeHtml(id)}-help">`;

function generalForm(d: SettingsPageData): string {
  const s = d.settings;
  const chanOpts = (selected: string | null): string => d.channels.map((c) => `<option value="${escapeHtml(c.id)}"${selected === c.id ? ' selected' : ''}>#${escapeHtml(c.name)}</option>`).join('');
  const dayOptions = DAYS.map((name, i) => `<option value="${i}"${s.weeklyDay === i ? ' selected' : ''}>${name}</option>`).join('');
  const hourOptions = Array.from({ length: 24 }, (_, h) => `<option value="${h}"${s.weeklyHour === h ? ' selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');
  const embedChips = d.channels.map((c) => chip('embedChannels', c.id, s.embedChannels.includes(c.id), `#${c.name}`)).join('');
  const schedule = `<div class="row"><div class="row-l"><span class="lbl" id="weeklyWhen">Schedule</span><span class="help">Day and hour, in the timezone below.</span></div><div class="row-c split"><select id="weeklyDay" name="weeklyDay" aria-label="Day">${dayOptions}</select><select id="weeklyHour" name="weeklyHour" aria-label="Hour">${hourOptions}</select></div></div>`;
  const sendNow = `<div class="row"><div class="row-l"><span class="lbl">Test</span><span class="help">Posts last week's stats to the saved channel right now. Doesn't affect the schedule.</span></div><div class="row-c"><button type="submit" class="btn ghost" form="send-now-form" onclick="return confirm('Post last week\\'s stats to the channel now?')">Send now</button></div></div>`;
  const sendMonthlyNow = `<div class="row"><div class="row-l"><span class="lbl">Test monthly</span><span class="help">Posts last month's recap (two messages) to the saved channel right now. Doesn't affect the schedule.</span></div><div class="row-c"><button type="submit" class="btn ghost" form="monthly-send-now-form" onclick="return confirm('Post last month\\'s recap to the channel now?')">Send monthly recap now</button></div></div>`;
  return `<div class="formgroup stack"><form class="stack" id="general-form" method="post" action="/settings">
    <section class="card" id="weekly" aria-labelledby="h-weekly"><div class="card-head"><h2 id="h-weekly">Weekly &amp; monthly stats</h2></div><p class="card-sub">Post last week's leaderboard every week and a recap of last month on the 1st, to a channel on a schedule.</p>
      <div class="rows">
        ${toggleRow('weeklyEnabled', s.weeklyEnabled, 'Send weekly stats automatically', 'Needs a channel below.')}
        ${toggleRow('monthlyEnabled', s.monthlyEnabled, 'Send monthly recap automatically', 'Posted on the 1st at the hour above, to the same channel.')}
        ${row({ id: 'statsChannel', label: 'Channel', help: 'Where the weekly stats are posted.', control: selectEl('statsChannel', 'statsChannel', `<option value="">— disabled —</option>${chanOpts(s.statsChannelId)}`) })}
        ${schedule}
        ${row({ id: 'timezone', label: 'Timezone', help: 'IANA name, e.g. Europe/Ljubljana.', control: textEl('timezone', 'timezone', s.timezone, true) })}
        ${sendNow}
        ${sendMonthlyNow}
      </div>
    </section>
    <section class="card" id="embeds" aria-labelledby="h-embedset"><div class="card-head"><h2 id="h-embedset">Link embeds</h2><span class="sub">${fmt(s.embedChannels.length)} of ${fmt(d.channels.length)} channels</span></div><p class="card-sub">Social links posted in the selected channels are converted to rich embeds.</p>
      <div class="rows">${d.channels.length === 0 ? '<div class="row block"><p class="muted">No text channels found.</p></div>' : chipRow('embedChannelsLbl', 'Channels', '', embedChips, d.channels.length > 40)}</div>
    </section>
    <section class="card" id="leveling" aria-labelledby="h-leveling"><div class="card-head"><h2 id="h-leveling">Leveling</h2></div><p class="card-sub">Members earn a random 5–10 XP per message, at most once every 30 seconds. Every reaction has a 1% chance to win level + 1 XP (lvl 0 → 1, lvl 49 → 50). Each level needs more XP than the last.</p>
      <div class="rows">
        ${toggleRow('levelingEnabled', s.levelingEnabled, 'Award XP for messages and reactions', 'XP is stored permanently per member.')}
        ${row({ id: 'levelupChannel', label: 'Level-up announcements', help: 'Where level-ups are posted (e.g. #bot-testing). Silent = track XP without announcing.', control: selectEl('levelupChannel', 'levelupChannel', `<option value="">— silent —</option>${chanOpts(s.levelupChannelId)}`) })}
      </div>
    </section>
    <div class="savebar"><span class="muted">Saves weekly &amp; monthly stats, link embeds and leveling together.</span><button type="submit">Save settings</button></div>
  </form><form id="send-now-form" method="post" action="/weekly/send-now"></form><form id="monthly-send-now-form" method="post" action="/monthly/send-now"></form></div>`;
}

function colorSection(d: SettingsPageData): string {
  const c = d.color;
  const channelOpts = d.channels.map((ch) => `<option value="${escapeHtml(ch.id)}"${c.channelId === ch.id ? ' selected' : ''}>#${escapeHtml(ch.name)}</option>`).join('');
  const chosen = new Set(c.selected);
  const roleChips = c.roles.map((r) => chip('colorRoles', r.id, chosen.has(r.id), `@${r.name}`)).join('');
  const flash =
    c.flash?.kind === 'saved'
      ? '<div class="flash" role="status">Name colour settings saved.</div>'
      : c.flash?.kind === 'error'
        ? `<div class="flash" role="alert">Couldn't post every colour message: ${escapeHtml(c.flash.reason)}</div>`
        : '';
  const status = [
    c.canManage ? statusPill('ok', 'Manage Roles granted') : statusPill('err', 'Missing Manage Roles permission'),
    statusPill('', `${fmt(c.selected.length)} colour roles selected`),
    statusPill('', `${fmt(c.posted)} of ${fmt(c.selected.length)} messages posted`),
  ].join('');
  return `<section class="card" id="colors" aria-labelledby="h-colors"><div class="card-head"><h2 id="h-colors">Name colours</h2></div><p class="card-sub">Pick the pre-made coloured roles and post one message per role. Reacting to a message gives that role; a new colour replaces the old one. Roles must sit below the bot's highest role.</p><div class="pills card-pills">${status}</div>
    ${flash}
    <form method="post" action="/color-settings">
      <div class="rows">
        ${row({ id: 'colorChannel', label: 'Channel', help: 'Where the colour messages are posted.', control: selectEl('colorChannel', 'channel', `<option value="">— not set —</option>${channelOpts}`) })}
        ${c.roles.length === 0 ? '<div class="row block"><p class="muted">No roles found.</p></div>' : chipRow('colorRolesLbl', 'Roles', 'The roles members can claim by reacting. Unselecting a role deletes its message.', roleChips, true)}
      </div>
      <div class="savebar"><span class="muted">Saving posts a message for every role that has none yet, and removes messages of unselected roles.</span><button type="submit">Save and post messages</button></div>
    </form>
  </section>`;
}

function freeSection(d: SettingsPageData): string {
  const f = d.free;
  const s = f.settings;
  const channelOpts = d.channels.map((c) => `<option value="${escapeHtml(c.id)}"${s.channelId === c.id ? ' selected' : ''}>#${escapeHtml(c.name)}</option>`).join('');
  const roleOpts = f.roles.map((r) => `<option value="${escapeHtml(r.id)}"${s.pingRoleId === r.id ? ' selected' : ''}>@${escapeHtml(r.name)}</option>`).join('');
  const storeChips = ALL_STORES.map((st) => chip('stores', st, s.stores.includes(st), STORE_LABELS[st])).join('');
  const also = [
    chip('includeDlc', '1', s.includeDlc, 'DLC / in-game loot', 'Add-ons and loot drops'),
    chip('includeBeta', '1', s.includeBeta, 'Betas / playtests', 'Beta, playtest and demo keys'),
    chip('includeMobile', '1', s.includeMobile, 'Mobile', 'Android / iOS games'),
  ].join('');
  const status = `${f.webhookEnabled ? statusPill('ok', 'FreeStuff webhook enabled') : statusPill('off', 'FreeStuff webhook disabled (set FREESTUFF_PUBLIC_KEY)')}${statusPill('', `${fmt(f.postedCount)} recorded as announced`)}`;
  return `<section class="card" id="free" aria-labelledby="h-free"><div class="card-head"><h2 id="h-free">Free games</h2></div><p class="card-sub">Announce new free games as they arrive from FreeStuff.</p><div class="pills card-pills">${status}</div>
    <form method="post" action="/free-settings">
      <div class="rows">
        ${row({ id: 'freeChannel', label: 'Announcement channel', help: 'Where new free games are posted.', control: selectEl('freeChannel', 'channel', `<option value="">— disabled —</option>${channelOpts}`) })}
        ${row({ id: 'freeRole', label: 'Ping role', help: 'Mentioned with each announcement.', control: selectEl('freeRole', 'pingRole', `<option value="">— none —</option>${roleOpts}`) })}
        ${chipRow('storesLbl', 'Stores', 'Applies to PC games.', storeChips)}
        ${chipRow('alsoLbl', 'Also include', 'Off by default: add-ons, beta/playtest/demo keys and mobile games.', also)}
      </div>
      <div class="savebar"><button type="submit">Save free games settings</button></div>
    </form>
  </section>`;
}

/** Link to a challenge detail tab (page 1, the overview tab and the unfiltered entries view are omitted). */
export function challengeHref(id: number, tab: ChallengeTab = 'overview', page = 1, flagged = false): string {
  const q = new URLSearchParams();
  if (tab !== 'overview') q.set('tab', tab);
  if (page > 1) q.set('page', String(page));
  if (flagged) q.set('flagged', '1');
  const qs = q.toString();
  return `/dashboard/challenges/${id}${qs ? '?' + qs : ''}`;
}

/** Overview / Progress / Entries / Activity tabs of one challenge; the selected one is plain text with aria-current. */
export function challengeTabs(id: number, tab: ChallengeTab): string {
  const labels: [ChallengeTab, string][] = [
    ['overview', 'Overview'],
    ['progress', 'Progress'],
    ['entries', 'Entries'],
    ['activity', 'Activity'],
  ];
  const inner = labels
    .map(([value, label]) => (value === tab ? `<span class="tab" aria-current="page">${escapeHtml(label)}</span>` : `<a class="tab" href="${escapeHtml(challengeHref(id, value))}">${escapeHtml(label)}</a>`))
    .join('');
  return `<nav class="tabs" aria-label="Challenge sections">${inner}</nav>`;
}

function challengeStatusPill(status: ChallengeStatus): string {
  return status === 'active' ? statusPill('ok', 'Active') : status === 'upcoming' ? statusPill('warn', 'Upcoming') : statusPill('off', 'Completed');
}

/**
 * The 3-step server-side wizard (no JS), shared by the challenges page and the
 * POST handlers that render a step again. `details#challenge-new` wraps it.
 */
export function challengeWizard(d: Pick<ChallengesPageData, 'wizard' | 'channels' | 'roles' | 'activityNames'>): string {
  const w = d.wizard;
  const hidden = (pairs: [string, string][]): string =>
    pairs.map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`).join('');
  const detailsPairs = (draft: ChallengeDraft): [string, string][] => [
    ['name', draft.name],
    ['description', draft.description],
    ['metric', draft.metric],
    ['activityName', draft.activityName],
  ];
  const schedulePairs = (draft: ChallengeDraft): [string, string][] => [
    ['target', String(draft.target)],
    ['startDate', draft.startDate],
    ['endDate', draft.endDate],
    ['channelId', draft.channelId],
    ['rewardRoleId', draft.rewardRoleId],
  ];
  const dateEl = (id: string, name: string, value: string): string =>
    `<input type="date" id="${escapeHtml(id)}" name="${escapeHtml(name)}" value="${escapeHtml(value)}" aria-describedby="${escapeHtml(id)}-help">`;
  const textareaEl = (id: string, name: string, value: string, max: number): string =>
    `<textarea id="${escapeHtml(id)}" name="${escapeHtml(name)}" rows="3" maxlength="${max}" aria-describedby="${escapeHtml(id)}-help">${escapeHtml(value)}</textarea>`;
  const metricOptions = CHALLENGE_METRICS.map((m) => `<option value="${m}"${w.draft.metric === m ? ' selected' : ''}>${escapeHtml(metricLabel(m))}${m === 'activity' ? ' (name below)' : ''}</option>`).join('');
  const channelOptions = d.channels.map((c) => `<option value="${escapeHtml(c.id)}"${w.draft.channelId === c.id ? ' selected' : ''}>#${escapeHtml(c.name)}</option>`).join('');
  const roleOptions = d.roles.map((r) => `<option value="${escapeHtml(r.id)}"${w.draft.rewardRoleId === r.id ? ' selected' : ''}>@${escapeHtml(r.name)}</option>`).join('');
  const activityList = d.activityNames.length > 0 ? `<datalist id="challengeActivities">${d.activityNames.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('')}</datalist>` : '';

  if (w.step === 2) {
    return `<form method="post" action="/challenge-wizard"><input type="hidden" name="step" value="2">${hidden(detailsPairs(w.draft))}
      <div class="rows">
        ${row({ id: 'challengeTarget', label: 'Target', help: `Whole number (${metricTargetUnit(w.draft.metric)}); shown as "progress / target".`, control: numberEl('challengeTarget', 'target', w.draft.target, 1, 1_000_000) })}
        ${row({ id: 'challengeStart', label: 'Start date', help: 'YYYY-MM-DD, empty = starts when created. UTC day.', control: dateEl('challengeStart', 'startDate', w.draft.startDate) })}
        ${row({ id: 'challengeEnd', label: 'End date', help: 'The whole UTC day counts. Must be in the future.', control: dateEl('challengeEnd', 'endDate', w.draft.endDate) })}
        ${row({ id: 'challengeChannel', label: 'Channel', help: 'Where the joinable card is posted.', control: selectEl('challengeChannel', 'channelId', `<option value="">— choose —</option>${channelOptions}`) })}
        ${row({ id: 'challengeRole', label: 'Reward role', help: 'Granted permanently to the top 3 with progress above 0 when the challenge ends.', control: selectEl('challengeRole', 'rewardRoleId', `<option value="">— no reward —</option>${roleOptions}`) })}
      </div>
      <div class="savebar"><span class="muted">Step 2 of 3</span><button type="submit">Next: review</button></div>
    </form>`;
  }
  if (w.step === 3) {
    const channelName = d.channels.find((c) => c.id === w.draft.channelId)?.name ?? w.draft.channelId;
    const roleName = d.roles.find((r) => r.id === w.draft.rewardRoleId)?.name ?? w.draft.rewardRoleId;
    const start = w.draft.startDate ? `${w.draft.startDate} (UTC)` : 'when created';
    return `<form method="post" action="/challenge-wizard"><input type="hidden" name="step" value="3">${hidden([...detailsPairs(w.draft), ...schedulePairs(w.draft)])}
      <div class="rows">
        <div class="row block"><div class="row-l"><span class="lbl">Summary</span><span class="help">Creating posts the card and opens the challenge for joins.</span></div><div class="row-c">
          <p class="muted"><b>${escapeHtml(w.draft.name)}</b></p>
          ${w.draft.description ? `<p class="muted">${escapeHtml(w.draft.description)}</p>` : ''}
          <p class="muted">${escapeHtml(metricLabel(w.draft.metric))}${w.draft.metric === 'activity' ? ` · ${escapeHtml(w.draft.activityName)}` : ''} · target <b>${escapeHtml(formatChallengeTarget(w.draft.metric, w.draft.target))}</b></p>
          <p class="muted">From ${escapeHtml(start)} until ${escapeHtml(w.draft.endDate)} (UTC) · #${escapeHtml(channelName)}${w.draft.rewardRoleId ? ` · reward @${escapeHtml(roleName)}` : ''}</p>
        </div></div>
      </div>
      <div class="savebar"><span class="muted">Step 3 of 3</span><button type="submit">Create challenge</button></div>
    </form>`;
  }
  return `<form method="post" action="/challenge-wizard"><input type="hidden" name="step" value="1">
      <div class="rows">
        ${row({ id: 'challengeName', label: 'Name', help: '1–100 characters, shown as the card title.', control: textEl('challengeName', 'name', w.draft.name, false) })}
        ${row({ id: 'challengeDescription', label: 'Description', help: 'Up to 500 characters. Say what counts and how it is measured.', control: textareaEl('challengeDescription', 'description', w.draft.description, 500) })}
        ${row({ id: 'challengeMetric', label: 'Goal type', help: 'Measured from the stats the bot already records.', control: selectEl('challengeMetric', 'metric', metricOptions) })}
        ${row({ id: 'challengeActivity', label: 'Activity name', help: 'Required for the activity goal type, e.g. League of Legends or Counter-Strike 2.', control: `<input type="text" id="challengeActivity" name="activityName" value="${escapeHtml(w.draft.activityName)}" list="challengeActivities" aria-describedby="challengeActivity-help" autocomplete="off">${activityList}` })}
      </div>
      <div class="savebar"><span class="muted">Step 1 of 3</span><button type="submit">Next: schedule</button></div>
    </form>`;
}

/** A challenge row in the list, linking to its detail page. */
function challengeListItem(item: ChallengeListItem, tz: string): string {
  const c = item.challenge;
  const when =
    item.status === 'ended' ? `ended ${fmtDate(c.endedAt ?? c.endsAt, tz)}` : item.status === 'upcoming' ? `starts ${fmtDate(c.startsAt, tz)}` : `until ${fmtDate(c.endsAt, tz)}`;
  const metric = `${metricLabel(c.metric)}${c.metric === 'activity' && c.activityName ? ` · ${c.activityName}` : ''}`;
  return `<div class="row"><div class="row-l"><span class="lbl"><a class="row-link" href="/dashboard/challenges/${c.id}">#${c.id} ${escapeHtml(c.name)}</a></span><span class="help">${escapeHtml(metric)} · ${escapeHtml(when)}</span></div><div class="row-c">${challengeStatusPill(item.status)}<span class="muted">${escapeHtml(fmt(item.joined))} joined</span></div></div>`;
}

const CLEAR_CHALLENGE_FLASH_SCRIPT =
  "<script>(()=>{const u=new URL(location.href);u.searchParams.delete('challengeCreated');u.searchParams.delete('challengeError');u.searchParams.delete('challengeEnded');u.searchParams.delete('challengeDeleted');u.searchParams.delete('challengeUpdated');history.replaceState(null,'',u.pathname+u.search+u.hash)})()</script>";

function challengeFlash(flash: ChallengesPageData['flash']): string {
  return flash ? `<div class="flash" role="${flash.kind === 'error' ? 'alert' : 'status'}">${escapeHtml(flash.message)}</div>` : '';
}

/** List URL with the current status/sort filter and an optional page. */
function challengesListHref(status: 'all' | ChallengeStatus, sort: ChallengeSort, page?: number): string {
  const q = new URLSearchParams();
  if (status !== 'all') q.set('status', status);
  if (sort !== 'newest') q.set('sort', sort);
  if (page && page > 1) q.set('page', String(page));
  const qs = q.toString();
  return `/dashboard/challenges${qs ? `?${qs}` : ''}${page && page > 1 ? '#h-challenges' : ''}`;
}

/** Challenges page: status filters (with counts), sort links, the list, and the wizard in details#challenge-new. */
export function challengesPage(d: ChallengesPageData, now: number = Date.now()): string {
  const statusLabel = (status: 'all' | ChallengeStatus): string => (status === 'all' ? 'All' : status === 'upcoming' ? 'Upcoming' : status === 'active' ? 'Active' : 'Completed');
  const filters = (['all', 'upcoming', 'active', 'ended'] as const)
    .map((status) => {
      const href = challengesListHref(status, d.sort);
      const count = d.counts[status];
      return status === d.status
        ? `<span class="tab" aria-current="page">${escapeHtml(statusLabel(status))} <span class="muted">${escapeHtml(fmt(count))}</span></span>`
        : `<a class="tab" href="${escapeHtml(href)}">${escapeHtml(statusLabel(status))} <span class="muted">${escapeHtml(fmt(count))}</span></a>`;
    })
    .join('');
  const sortOptions: [ChallengeSort, string][] = [
    ['newest', 'Newest'],
    ['ending', 'Ending soon'],
    ['name', 'Name'],
  ];
  const sorts = sortOptions
    .map(([sort, label]) =>
      sort === d.sort
        ? `<span class="tab" aria-current="page">${escapeHtml(label)}</span>`
        : `<a class="tab" href="${escapeHtml(challengesListHref(d.status, sort))}">${escapeHtml(label)}</a>`,
    )
    .join('');
  const rolePill = d.canManageRoles ? statusPill('ok', 'Manage Roles granted') : statusPill('err', 'Missing Manage Roles — rewards cannot be granted');
  const open = d.wizard.step !== 1 || d.wizard.errors.length > 0;
  const errors = d.wizard.errors.length > 0 ? `<div class="flash" role="alert">${d.wizard.errors.map(escapeHtml).join('<br>')}</div>` : '';
  const listItems = d.list.map((item) => challengeListItem(item, d.timezone));
  const pager = pagerHtml({
    page: d.page,
    pages: d.pages,
    summary: `Showing ${rangeSummary(d.page, d.pageSize, d.list.length, d.total)}`,
    href: (p) => challengesListHref(d.status, d.sort, p),
    label: 'Challenge pages',
    showSingle: d.total > 0,
  });
  const body = `
    ${challengeFlash(d.flash)}
    <details class="card chall-new" id="challenge-new"${open ? ' open' : ''}><summary><span>New challenge</span><span class="sub">Details, schedule, review</span></summary>
      ${errors}
      ${challengeWizard(d)}
    </details>
    <section class="card" aria-labelledby="h-challenges"><div class="card-head"><h2 id="h-challenges">Challenges</h2><span class="sub">${escapeHtml(fmt(d.counts.all))} total</span></div>
      <p class="card-sub">Time-limited goals on the existing stats, plus manually logged push-up sets. Members join on the posted card; progress counts from the challenge start for everyone who joined. When it ends, the top 3 by overall goal share get the reward role permanently.</p>
      <div class="pills card-pills">${rolePill}</div>
      <div class="filters"><nav class="seg" aria-label="Challenge status">${filters}</nav></div>
      <div class="filters"><nav class="seg" aria-label="Sort challenges">${sorts}</nav></div>
      <div class="rows">${listItems.length > 0 ? listItems.join('') : emptyState(d.status === 'all' ? 'No challenges yet — create one above.' : `No ${statusLabel(d.status).toLowerCase()} challenges.`)}</div>
      ${pager}
    </section>
    ${d.flash ? CLEAR_CHALLENGE_FLASH_SCRIPT : ''}`;
  return layout(
    {
      active: 'challenges',
      title: 'Challenges',
      sub: '<p class="hero-sub">Time-limited goals on messages, reactions, voice, activities and logged push-up sets. Join/Leave and role rewards stay on the posted card.</p>',
      live: 'quiet',
      body,
      now,
    },
    { user: d.user, deploy: d.deploy },
  );
}

function progressTable(rows: ChallengeProgressRow[], metric: ChallengeMetric, target: number, empty: string): string {
  if (rows.length === 0) return emptyState(empty);
  const targetValue = isTimeMetric(metric) ? target * 60_000 : target;
  const body = rows
    .map((r) => {
      const pct = targetValue > 0 ? Math.max(0, Math.min(100, Math.round((r.value / targetValue) * 100))) : 0;
      const medal = medalFor(r.rank);
      return `<tr><td class="dim" data-label="Rank">${medal ? `<span aria-label="Rank ${r.rank}"><span aria-hidden="true">${medal}</span></span>` : r.rank}</td><td data-label="Member" class="name">${escapeHtml(r.name)}</td><td data-label="Progress">${escapeHtml(formatChallengeValue(metric, r.value))} / ${escapeHtml(formatChallengeTarget(metric, target))}</td><td class="r" data-label="Share">${pct}%</td></tr>`;
    })
    .join('');
  return `<div class="tbl"><table><thead><tr><th scope="col">Rank</th><th scope="col">Member</th><th scope="col">Progress</th><th scope="col" class="r">Share</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function challengeMeta(label: string, value: string): string {
  return `<div class="row"><div class="row-l"><span class="lbl">${escapeHtml(label)}</span></div><div class="row-c">${value}</div></div>`;
}

function goalLabel(goal: ChallengeGoal): string {
  return `${metricLabel(goal.metric)}${goal.metric === 'activity' && goal.activityName ? ` · ${goal.activityName}` : ''}`;
}

/** Add-goal form on the overview tab (1–MAX_CHALLENGE_GOALS goals). */
function addGoalForm(c: Challenge, goalCount: number): string {
  const metricOptions = CHALLENGE_METRICS.map((m) => `<option value="${m}">${escapeHtml(metricLabel(m))}${m === 'activity' ? ' (name below)' : ''}</option>`).join('');
  return `<details class="card" id="challenge-add-goal"><summary><span>Add goal</span><span class="sub">${goalCount} of ${MAX_CHALLENGE_GOALS}</span></summary>
    <form method="post" action="/challenge-goal-add"><input type="hidden" name="challengeId" value="${c.id}">
      <div class="rows">
        ${row({ id: 'challengeGoalMetric', label: 'Goal type', help: 'Manual push-ups get a Log set button on the card; the others read the stats the bot already records.', control: selectEl('challengeGoalMetric', 'metric', metricOptions) })}
        ${row({ id: 'challengeGoalActivity', label: 'Activity name', help: 'Only for the activity goal type.', control: `<input type="text" id="challengeGoalActivity" name="activityName" maxlength="100" aria-describedby="challengeGoalActivity-help" autocomplete="off">` })}
        ${row({ id: 'challengeGoalTarget', label: 'Target', help: 'Count for messages/reactions/push-ups, minutes for voice/activity.', control: numberEl('challengeGoalTarget', 'target', 100, 1, 1_000_000) })}
      </div>
      <div class="savebar"><button type="submit">Add goal</button></div>
    </form>
  </details>`;
}

/** Inline admin edit/delete form of one entry. */
function entryForm(d: ChallengeDetailData, row: ChallengeEntryView): string {
  const { entry, goal } = row;
  return `<form method="post" action="/challenge-entry">
    <input type="hidden" name="challengeId" value="${d.challenge.id}">
    <input type="hidden" name="entryId" value="${entry.id}">
    <input type="number" name="value" min="1" max="5000" value="${entry.value}" aria-label="Value for ${escapeHtml(entry.displayName)}">
    <input type="text" name="reason" maxlength="300" placeholder="Reason (optional)" aria-label="Reason for changing ${escapeHtml(entry.displayName)}'s entry">
    <button type="submit" name="op" value="update" class="btn ghost">Save</button>
    <button type="submit" name="op" value="delete" class="btn ghost" onclick="return confirm('Delete this entry?')">Delete</button>
  </form>`;
}

/** One challenge: overview goals, per-goal progress, manual entries and the event log. */
export function challengeDetailPage(d: ChallengeDetailData, now: number = Date.now()): string {
  const c = d.challenge;
  const goalCount = d.goals.length;
  const progressPager = pagerHtml({
    page: d.progress.page,
    pages: d.progress.pages,
    summary: `Showing ${rangeSummary(d.progress.page, d.progress.pageSize, Math.min(d.progress.pageSize, Math.max(0, d.progress.total - (d.progress.page - 1) * d.progress.pageSize)), d.progress.total)}`,
    href: (p) => `${challengeHref(c.id, 'progress', p)}#h-progress`,
    label: 'Progress pages',
    showSingle: d.progress.total > 0,
  });
  const eventRows = d.events.rows.map((e) => {
    const label = CHALLENGE_EVENT_LABELS[e.kind] ?? e.kind;
    return `<tr><td class="dim" data-label="Time">${escapeHtml(fmtDate(e.ts, d.timezone))}</td><td data-label="Kind"><span class="badge">${escapeHtml(label)}</span></td><td data-label="Activity">${escapeHtml(challengeEventText(e.kind, e.actorName, e.detail))}</td></tr>`;
  });
  const eventsTable =
    eventRows.length === 0
      ? emptyState('No events yet.')
      : `<div class="tbl"><table><thead><tr><th scope="col">Time</th><th scope="col">Kind</th><th scope="col">Activity</th></tr></thead><tbody>${eventRows.join('')}</tbody></table></div>`;
  const eventPager = pagerHtml({
    page: d.events.page,
    pages: d.events.pages,
    summary: `Showing ${rangeSummary(d.events.page, d.events.pageSize, d.events.rows.length, d.events.total)}`,
    href: (p) => `${challengeHref(c.id, 'activity', p)}#h-activity`,
    label: 'Activity pages',
    showSingle: d.events.total > 0,
  });
  const entriesPager = pagerHtml({
    page: d.entries.page,
    pages: d.entries.pages,
    summary: `Showing ${rangeSummary(d.entries.page, d.entries.pageSize, d.entries.rows.length, d.entries.total)}`,
    href: (p) => `${challengeHref(c.id, 'entries', p, d.entries.flaggedOnly)}#h-entries`,
    label: 'Entries pages',
    showSingle: d.entries.total > 0,
  });
  const actions =
    (d.status === 'ended'
      ? ''
      : `<form method="post" action="/challenge-end"><input type="hidden" name="id" value="${c.id}"><button type="submit" class="btn ghost" onclick="return confirm('End this challenge now and grant the reward role?')">End now</button></form>`) +
    `<form method="post" action="/challenge-delete"><input type="hidden" name="id" value="${c.id}"><button type="submit" class="btn ghost" onclick="return confirm('Delete this challenge and its card?')">Delete</button></form>`;

  const goalCards = d.goals
    .map(({ goal, rows }) => `<h3 class="group-h" id="h-goal-${goal.id}">${escapeHtml(goalLabel(goal))} · target ${escapeHtml(formatChallengeTarget(goal.metric, goal.target))}</h3>${progressTable(rows.slice(0, 3), goal.metric, goal.target, 'No participants yet.')}`)
    .join('');
  const overview = `<div class="rows">
      ${challengeMeta('Status', challengeStatusPill(d.status))}
      ${challengeMeta('Goals', `<span>${escapeHtml(fmt(goalCount))}</span>`)}
      ${challengeMeta('Participants', `<span>${escapeHtml(fmt(d.joined))} joined</span>`)}
      ${challengeMeta('Starts', `<span>${escapeHtml(fmtDate(c.startsAt, d.timezone))}</span>`)}
      ${challengeMeta('Ends', `<span>${escapeHtml(fmtDate(c.endsAt, d.timezone))}${d.status === 'ended' ? ` · ended ${escapeHtml(fmtDate(c.endedAt ?? c.endsAt, d.timezone))}` : ''}</span>`)}
      ${challengeMeta('Channel', `<span>#${escapeHtml(d.channelName)}</span>`)}
      ${challengeMeta('Reward role', `<span>${c.rewardRoleId ? escapeHtml(c.rewardRoleId) : 'No reward role'}</span>`)}
      ${challengeMeta('Created by', `<span>${escapeHtml(c.createdBy)} · ${escapeHtml(fmtDate(c.createdAt, d.timezone))}</span>`)}
    </div>
    ${c.description ? `<p class="muted">${escapeHtml(c.description)}</p>` : ''}
    <h3 class="group-h" id="h-top">Goal standings</h3>
    ${goalCards || emptyState('No goals yet.')}
    ${d.status !== 'ended' && goalCount < MAX_CHALLENGE_GOALS ? addGoalForm(c, goalCount) : ''}
    <div class="savebar">${actions}</div>`;

  const progressGoals = d.goals
    .map(({ goal, rows }) => {
      const pageRows = rows.slice((d.progress.page - 1) * d.progress.pageSize, d.progress.page * d.progress.pageSize);
      return `<h3 class="group-h">${escapeHtml(goalLabel(goal))} · target ${escapeHtml(formatChallengeTarget(goal.metric, goal.target))}</h3>${progressTable(pageRows, goal.metric, goal.target, 'No participants yet.')}`;
    })
    .join('');
  const progress = `<h2 id="h-progress">Progress</h2>${progressGoals || emptyState('No goals yet.')}${progressPager}`;

  const entryRows = d.entries.rows
    .map(
      ({ entry, goal }) =>
        `<tr><td class="dim" data-label="Time">${escapeHtml(fmtDate(entry.createdAt, d.timezone))}</td><td data-label="Member" class="name">${escapeHtml(entry.displayName)}</td><td data-label="Goal">${escapeHtml(goalLabel(goal))}</td><td data-label="Value">${escapeHtml(formatChallengeValue(goal.metric, entry.value))}</td><td data-label="Review">${entry.flagged ? '<span class="badge error">Flagged</span>' : '<span class="badge">OK</span>'}</td><td data-label="Admin">${entryForm(d, { entry, goal })}</td></tr>`,
    )
    .join('');
  const entriesTable =
    entryRows.length === 0
      ? emptyState(d.entries.flaggedOnly ? 'No flagged entries.' : 'No entries yet.')
      : `<div class="tbl"><table><thead><tr><th scope="col">Time</th><th scope="col">Member</th><th scope="col">Goal</th><th scope="col">Value</th><th scope="col">Review</th><th scope="col">Admin</th></tr></thead><tbody>${entryRows}</tbody></table></div>`;
  const entryFilters = ([false, true] as const)
    .map((flagged) => {
      const label = flagged ? 'Flagged only' : 'All entries';
      return d.entries.flaggedOnly === flagged
        ? `<span class="tab" aria-current="page">${escapeHtml(label)}</span>`
        : `<a class="tab" href="${escapeHtml(challengeHref(c.id, 'entries', 1, flagged))}">${escapeHtml(label)}</a>`;
    })
    .join('');
  const entries = `<h2 id="h-entries">Entries</h2>
    <p class="card-sub">Sets logged by members. Sets above 99 push-ups are flagged for review; admins can correct or delete any entry, and every change is recorded in the Activity log with the admin and reason.</p>
    <div class="filters"><nav class="seg" aria-label="Entry review">${entryFilters}</nav></div>
    ${entriesTable}${entriesPager}`;

  const activity = `<h2 id="h-activity">Activity</h2>${eventsTable}${eventPager}`;
  const body = `<section class="card" aria-labelledby="h-challenge">
      <div class="card-head"><h2 id="h-challenge">#${c.id} ${escapeHtml(c.name)}</h2><span class="sub">${escapeHtml(fmt(goalCount))} goal${goalCount === 1 ? '' : 's'}</span></div>
      <p class="muted"><a href="/dashboard/challenges">← All challenges</a></p>
      ${challengeTabs(c.id, d.tab)}
      ${d.flash ? `<div class="flash" role="${d.flash.kind === 'error' ? 'alert' : 'status'}">${escapeHtml(d.flash.message)}</div>` : ''}
      ${d.tab === 'progress' ? progress : d.tab === 'entries' ? entries : d.tab === 'activity' ? activity : overview}
    </section>
    ${d.flash ? CLEAR_CHALLENGE_FLASH_SCRIPT : ''}`;
  return layout(
    {
      active: 'challenges',
      title: 'Challenges',
      sub: `<p class="hero-sub">#${c.id} ${escapeHtml(c.name)}</p><div class="pills">${challengeStatusPill(d.status)}</div>`,
      live: 'quiet',
      body,
      now,
    },
    { user: d.user, deploy: d.deploy },
  );
}

function limitMeter(label: string, m: { percent: number; limited: boolean; resetsAt: number }, tz: string, threshold: number): string {
  const pct = Math.max(0, Math.min(100, Math.round(m.percent)));
  const cls = m.limited || pct >= threshold ? 'err' : pct >= threshold * 0.8 ? 'warn' : '';
  const mark = Math.max(0, Math.min(100, threshold));
  return `<div class="meter"><div class="meter-top"><span>${escapeHtml(label)}</span><b>${escapeHtml(String(pct))}%${m.limited ? ' (limited)' : ''}</b></div><div class="meterbar" role="img" aria-label="${escapeHtml(label)} usage ${escapeHtml(String(pct))}%, refusing at ${escapeHtml(String(mark))}%"><i${cls ? ` class="${cls}"` : ''} style="width:${pct}%"></i><u style="left:${mark}%"></u></div><small>resets ${escapeHtml(fmtDate(m.resetsAt, tz))}</small></div>`;
}

/** AI assistant settings card (its own form, POST /builder-settings). */
export function builderSection(d: Pick<SettingsPageData, 'builder' | 'settings'>): string {
  const b = d.builder;
  const flash =
    b.flash?.kind === 'saved'
      ? '<div class="flash" role="status">AI assistant settings saved.</div>'
      : b.flash?.kind === 'error'
        ? `<div class="flash" role="alert">${escapeHtml(b.flash.reason)}</div>`
        : '';
  const a = b.agent;
  const tz = d.settings.timezone;
  const status = [
    b.passwordSet ? statusPill('ok', 'OPENCODE_PASSWORD set') : statusPill('off', 'OPENCODE_PASSWORD not set'),
    a ? (a.reachable ? statusPill('ok', `Agent server reachable (v${a.version ?? '?'})`) : `<span class="pill err" title="${escapeHtml(a.error ?? 'unknown error')}"><i class="dot"></i><span class="trunc" style="max-width:44ch">${escapeHtml(`Agent server unreachable: ${a.error ?? 'unknown error'}`)}</span></span>`) : statusPill('off', 'Agent server not checked'),
  ].join('');
  const th = b.settings.limitThreshold;
  const limits = a?.limits
    ? `<h3 class="group-h">OpenCode Go usage</h3><div class="meters">${limitMeter('5h', a.limits.rolling, tz, th)}${limitMeter('weekly', a.limits.weekly, tz, th)}${limitMeter('monthly', a.limits.monthly, tz, th)}</div>`
    : '';
  return `<section class="card" id="builder" aria-labelledby="h-builder"><div class="card-head"><h2 id="h-builder">AI assistant</h2></div><p class="card-sub">Chat with members in threads, and let admins turn a chat into a pull request.</p><div class="pills card-pills">${status}</div>
    ${flash}
    <form method="post" action="/builder-settings">
      <h3 class="group-h">Chat</h3>
      <div class="rows">
        ${toggleRow('chatEnabled', b.settings.chatEnabled, 'Chat with members when the bot is mentioned', 'A mention opens a thread where an OpenCode agent answers (with web search) and follows the conversation.')}
        ${row({ id: 'chatModel', label: 'Chat model', help: 'provider/model, e.g. opencode-go/glm-5.3-flash. Applies to new chats.', control: textEl('chatModel', 'chatModel', b.settings.chatModel, true) })}
        ${row({ id: 'chatDecisionModel', label: 'Decision model', help: 'provider/model of an OpenCode decision model, e.g. opencode-go/jev-1.14. Detects feature requests before the chat agent runs.', control: textEl('chatDecisionModel', 'chatDecisionModel', b.settings.chatDecisionModel, true) })}
        ${row({ id: 'chatLanguages', label: 'Chat languages', help: 'Comma-separated language names, e.g. Slovenian, English. The assistant replies only in these; empty means any language.', control: textEl('chatLanguages', 'chatLanguages', b.settings.chatLanguages.join(', '), false) })}
      </div>
      <h3 class="group-h">Feature requests</h3>
      <div class="rows">
        ${toggleRow('enabled', b.settings.enabled, 'Let admins turn chats into feature requests', 'When an admin asks for a change to the bot, an OpenCode agent plans it, then opens a pull request.')}
        ${row({ id: 'builderModel', label: 'Build model', help: 'provider/model, e.g. opencode-go/glm-5.3. Applies to new requests.', control: textEl('builderModel', 'model', b.settings.model, true) })}
        ${row({ id: 'maxParallelBuilds', label: 'Parallel builds', help: '1–5. Requests can be planned in parallel; approved ones wait in a queue until fewer than this many are building. More than 1 risks merge conflicts between PRs (each conflicted PR gets one automatic fix attempt).', control: numberEl('maxParallelBuilds', 'maxParallelBuilds', b.settings.maxParallelBuilds, 1, 5) })}
        ${row({ id: 'limitThreshold', label: 'Refuse AI requests at (% of Go limit)', help: '50–100, default 95. While any OpenCode Go limit (5h, weekly, monthly) is at or above this percentage, chat messages, feature requests and new builds are refused with the reset time. 100 only refuses a fully exhausted limit.', control: numberEl('limitThreshold', 'limitThreshold', b.settings.limitThreshold, 50, 100) })}
      </div>
      ${limits}
      <div class="savebar"><a class="btn ghost" href="/dashboard/requests">View chats and requests</a><button type="submit">Save AI assistant settings</button></div>
    </form>
  </section>`;
}

// Strips the one-shot flash params so a refresh doesn't show the toast again.
const CLEAR_FLASH_SCRIPT =
  "<script>(()=>{const u=new URL(location.href);u.searchParams.delete('saved');u.searchParams.delete('freeSaved');u.searchParams.delete('builderSaved');u.searchParams.delete('builderError');u.searchParams.delete('colorSaved');u.searchParams.delete('colorError');u.searchParams.delete('weekly');u.searchParams.delete('monthly');u.searchParams.delete('reason');history.replaceState(null,'',u.pathname+u.search+u.hash)})()</script>";

/** Settings page: one card per feature; forms save independently (general, colours, free games, AI assistant). */
export function settingsPage(d: SettingsPageData, now: number = Date.now()): string {
  const flashes = [
    d.saved ? '<div class="flash" role="status">Settings saved.</div>' : '',
    d.weeklyFlash?.kind === 'sent' ? '<div class="flash" role="status">Weekly stats sent.</div>' : '',
    d.weeklyFlash?.kind === 'error' ? `<div class="flash" role="alert">Couldn't send weekly stats: ${escapeHtml(d.weeklyFlash.reason || 'unknown error')}</div>` : '',
    d.monthlyFlash?.kind === 'sent' ? '<div class="flash" role="status">Monthly recap sent.</div>' : '',
    d.monthlyFlash?.kind === 'error' ? `<div class="flash" role="alert">Couldn't send monthly recap: ${escapeHtml(d.monthlyFlash.reason || 'unknown error')}</div>` : '',
    d.free.flash?.kind === 'saved' ? '<div class="flash" role="status">Free games settings saved.</div>' : '',
  ].join('');
  const anchors: [string, string][] = [['weekly', 'Weekly'], ['embeds', 'Embeds'], ['leveling', 'Leveling'], ['colors', 'Colours'], ['free', 'Free games'], ['builder', 'Assistant']];
  const secnav = `<nav class="secnav" aria-label="Settings sections"><div class="secnav-in">${anchors.map(([id, label]) => `<a href="#${id}">${label}</a>`).join('')}</div></nav>`;
  const body = `${flashes}${generalForm(d)}${colorSection(d)}${freeSection(d)}${builderSection(d)}${d.saved || d.weeklyFlash || d.monthlyFlash || d.free.flash || d.builder.flash || d.color.flash ? CLEAR_FLASH_SCRIPT : ''}`;
  return layout({ active: 'settings', title: 'Settings', sub: '<p class="hero-sub">Everything the bot does is configured here. Each section saves on its own.</p>', live: 'quiet', between: secnav, body, now }, { user: d.user, deploy: d.deploy });
}

// ---- logs ------------------------------------------------------------------------
export interface LogsPageData {
  rows: LogRow[];
  tags: string[];
  level: 'all' | 'warn' | 'error';
  tag: string | null;
  page: number;
  pages: number;
  pageSize: number;
  /** Rows matching the level/tag filter, all pages. */
  total: number;
  timezone: string;
  user: { username: string; avatar: string | null };
  deploy?: DeployStatus;
}

/** Link to a Logs page; filters are kept, page 1 is the default. */
export function logsHref(level: string, tag: string | null, page = 1, size = DEFAULT_PAGE_SIZE): string {
  const q = new URLSearchParams();
  if (level !== 'all') q.set('level', level);
  if (tag) q.set('tag', tag);
  if (page > 1) q.set('page', String(page));
  if (size !== DEFAULT_PAGE_SIZE) q.set('size', String(size));
  const qs = q.toString();
  return `/dashboard/logs${qs ? '?' + qs : ''}`;
}

/** Live regions of the Logs page, keyed by element id. */
export function logsParts(d: LogsPageData, now: number = Date.now()): Record<string, string> {
  const rows = d.rows.map(
    (r) =>
      `<tr class="lv-${escapeHtml(r.level)}"><td class="dim" data-label="Time">${escapeHtml(fmtDate(r.ts, d.timezone))}</td><td data-label="Level"><span class="badge ${r.level === 'info' ? '' : escapeHtml(r.level)}">${escapeHtml(r.level)}</span></td><td class="dim" data-label="Tag">${r.tag ? escapeHtml(r.tag) : '—'}</td><td class="logmsg" data-label="Message"><pre>${escapeHtml(r.message)}</pre></td></tr>`,
  );
  const table =
    rows.length === 0
      ? emptyState('No log entries match.')
      : `<div class="tbl"><table class="logs"><thead><tr><th scope="col">Time</th><th scope="col">Level</th><th scope="col">Tag</th><th scope="col">Message</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  const pager = pagerHtml({ page: d.page, pages: d.pages, summary: `Showing ${rangeSummary(d.page, d.pageSize, d.rows.length, d.total)}`, href: (p) => logsHref(d.level, d.tag, p, d.pageSize) + '#h-logs', label: 'Log pages', showSingle: true, size: { current: d.pageSize, href: (s) => logsHref(d.level, d.tag, 1, s) + '#h-logs' } });
  return { ...chromeParts(d.deploy, now), 'live-logs': table + (d.total === 0 ? '' : pager), 'live-logcount': rangeSummary(d.page, d.pageSize, d.rows.length, d.total) };
}

export function logsPage(d: LogsPageData, now: number = Date.now()): string {
  const href = (level: string, tag: string | null): string => logsHref(level, tag, 1, d.pageSize);
  const levelLinks = (['all', 'warn', 'error'] as const)
    .map((l) => {
      const label = l === 'all' ? 'All' : l === 'warn' ? 'Warnings + errors' : 'Errors';
      return `<a${d.level === l ? ' aria-current="page"' : ''} href="${escapeHtml(href(l, d.tag))}">${label}</a>`;
    })
    .join('');
  const tagOptions = [...new Set([...(d.tag ? [d.tag] : []), ...d.tags])]
    .sort()
    .map((t) => `<option value="${escapeHtml(t)}"${d.tag === t ? ' selected' : ''}>[${escapeHtml(t)}]</option>`)
    .join('');
  const tagForm = `<form method="get" action="/dashboard/logs">${d.level !== 'all' ? `<input type="hidden" name="level" value="${escapeHtml(d.level)}">` : ''}${d.pageSize !== DEFAULT_PAGE_SIZE ? `<input type="hidden" name="size" value="${d.pageSize}">` : ''}<select name="tag" aria-label="Tag" onchange="this.form.submit()"><option value="">All tags</option>${tagOptions}</select><noscript><button class="btn ghost" type="submit">Apply</button></noscript></form>`;
  const parts = logsParts(d, now);
  const body = `<section class="card" aria-labelledby="h-logs"><div class="card-head"><h2 id="h-logs">Console output</h2><span class="sub live" id="live-logcount">${parts['live-logcount'] ?? ''}</span></div>
    <div class="filters"><nav class="seg" aria-label="Level">${levelLinks}</nav>${tagForm}</div>
    ${region('live-logs', parts)}
  </section>`;
  return layout({ active: 'logs', title: 'Logs', sub: '<p class="hero-sub">What the bot printed to its console, newest first.</p>', live: 'status', body, now }, { user: d.user, deploy: d.deploy });
}

// ---- chats + feature requests -----------------------------------------------------
export interface RequestsPageData {
  jobs: BuildJob[];
  totals: BuildUsage & { jobs: number };
  chatTotals: BuildUsage & { threads: number; oneOffs: number };
  /** The current page of chat threads, most recently active first. */
  chats: ChatThread[];
  /** Feature request pager (`?page=`). */
  page: number;
  pages: number;
  pageSize: number;
  /** Chat pager (`?chatPage=`); total is threads + one-off replies. */
  chatPage: number;
  chatPages: number;
  chatPageSize: number;
  guildId: string;
  timezone: string;
  /** job id -> 1-based place in the build queue (queued jobs only) */
  queuePositions?: Record<number, number>;
  /** requesterId / startedBy -> cached display name */
  members: Record<string, string>;
  user: { username: string; avatar: string | null };
  deploy?: DeployStatus;
  /** One-shot toast after a cancel/retry redirect. */
  flash?: PageFlash;
}

export interface PageFlash {
  kind: 'ok' | 'error';
  text: string;
}

/** Toast for a cancel/retry redirect, plus a script that strips its query params so a refresh doesn't repeat it. */
function actionFlashHtml(flash: PageFlash | undefined): string {
  if (!flash) return '';
  return `<div class="flash" role="${flash.kind === 'error' ? 'alert' : 'status'}">${escapeHtml(flash.text)}</div><script>(()=>{const u=new URL(location.href);u.searchParams.delete('done');u.searchParams.delete('error');history.replaceState(null,'',u.pathname+u.search+u.hash)})()</script>`;
}

/** "$0.0123" */
export function fmtUsd(v: number): string {
  return `$${v.toFixed(4)}`;
}

const JOB_BADGE: Record<string, string> = { planning: 'warn', awaiting_input: 'warn', queued: 'warn', building: 'warn', pr_open: 'accent', merged: 'ok', failed: 'error' };
/**
 * Share of prompt tokens served from cache, whole percent: cacheRead / (input + cacheRead +
 * cacheWrite). OpenCode's `input` excludes cached tokens. 0 when there are no prompt tokens. Pure.
 */
export function cachePercent(u: { input: number; cacheRead: number; cacheWrite: number }): number {
  const total = u.input + u.cacheRead + u.cacheWrite;
  return total > 0 ? Math.round((u.cacheRead / total) * 100) : 0;
}

/** "87%" */
export const fmtCachePercent = (u: { input: number; cacheRead: number; cacheWrite: number }): string => `${cachePercent(u)}%`;

const CACHE_HELP = 'Cache % = tokens read from cache / (input + cache read + cache write)';

/** "in / out / reasoning / cache %" cell text of a usage row. Pure. */
export function tokensCell(u: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }): string {
  return `${fmt(u.input)} / ${fmt(u.output)} / ${fmt(u.reasoning)} / ${fmtCachePercent(u)}`;
}

const TOKENS_HEAD = `<th scope="col" title="input / output / reasoning / cache %. ${CACHE_HELP}">Tokens (in / out / reasoning / cache %)</th><th scope="col" class="r" title="Estimated from OpenCode Go list prices">Est. cost</th>`;

const sessionHref = (sessionId: string, cursor?: string | null): string => `/dashboard/sessions/${encodeURIComponent(sessionId)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
const sessionLink = (sessionId: string, label = 'Session'): string => `<a href="${escapeHtml(sessionHref(sessionId))}">${escapeHtml(label)}</a>`;

/** Link to the Requests page with both pagers' positions (page 1 is omitted). */
export function requestsHref(page: number, chatPage: number, size = DEFAULT_PAGE_SIZE, chatSize = DEFAULT_PAGE_SIZE): string {
  const q = new URLSearchParams();
  if (page > 1) q.set('page', String(page));
  if (size !== DEFAULT_PAGE_SIZE) q.set('size', String(size));
  if (chatPage > 1) q.set('chatPage', String(chatPage));
  if (chatSize !== DEFAULT_PAGE_SIZE) q.set('chatSize', String(chatSize));
  const qs = q.toString();
  return `/dashboard/requests${qs ? '?' + qs : ''}`;
}

/** Live regions of the Chats & requests page, keyed by element id. */
export function requestsParts(d: RequestsPageData, now: number = Date.now()): Record<string, string> {
  const t = d.totals;
  const rows = d.jobs.map((j) => {
    const title = j.title?.trim() || (j.request.length > 80 ? j.request.slice(0, 80) + '…' : j.request);
    const thread = `https://discord.com/channels/${d.guildId}/${j.threadId}`;
    const pr = j.prUrl ? `<a href="${escapeHtml(j.prUrl)}" target="_blank" rel="noopener noreferrer">PR</a>` : '';
    const href = j.sessionId ? sessionHref(j.sessionId) : null;
    const titleHtml = href ? `<a class="req-t row-link" href="${escapeHtml(href)}" title="${escapeHtml(j.request)}">${escapeHtml(title)}</a>` : `<span class="req-t" title="${escapeHtml(j.request)}">${escapeHtml(title)}</span>`;
    const tokens = tokensCell({ input: j.tokensInput, output: j.tokensOutput, reasoning: j.tokensReasoning, cacheRead: j.tokensCacheRead, cacheWrite: j.tokensCacheWrite });
    const queuePos = j.status === 'queued' ? d.queuePositions?.[j.id] : undefined;
    const statusLabel = queuePos ? `queued #${queuePos}` : j.status;
    const badge = JOB_BADGE[j.status] ?? '';
    return `<tr${href ? ` data-href="${escapeHtml(href)}"` : ''}><td class="dim" data-label="ID">${j.id}</td><td class="req" data-label="Request">${titleHtml}<span class="req-m">${escapeHtml(d.members[j.requesterId] ?? j.requesterId)} · ${escapeHtml(fmtDate(j.createdAt, d.timezone))}</span></td><td data-label="Status"><span class="badge${badge ? ' ' + badge : ''}">${escapeHtml(statusLabel)}</span></td><td data-label="Links"><span class="links"><a href="${escapeHtml(thread)}" target="_blank" rel="noopener noreferrer">Thread</a>${pr}</span></td><td data-label="Tokens">${escapeHtml(tokens)}</td><td class="r" data-label="Est. cost">${escapeHtml(fmtUsd(j.costUsd))}</td></tr>`;
  });
  const table =
    rows.length === 0
      ? emptyState('No feature requests yet.')
      : `<div class="tbl"><table><thead><tr><th scope="col">ID</th><th scope="col">Request</th><th scope="col">Status</th><th scope="col">Links</th>${TOKENS_HEAD}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  const ct = d.chatTotals;
  const chatRows = d.chats.map((c) => {
    const thread = `https://discord.com/channels/${d.guildId}/${c.threadId.split(':')[0]}`;
    const tokens = tokensCell({ input: c.tokensInput, output: c.tokensOutput, reasoning: c.tokensReasoning, cacheRead: c.tokensCacheRead, cacheWrite: c.tokensCacheWrite });
    const href = c.sessionId ? sessionHref(c.sessionId) : null;
    const who = escapeHtml(d.members[c.startedBy] ?? c.startedBy);
    return `<tr${href ? ` data-href="${escapeHtml(href)}"` : ''}><td data-label="Thread"><span class="links"><a href="${escapeHtml(thread)}" target="_blank" rel="noopener noreferrer">Thread</a>${c.oneOff ? '<span class="badge">one-off</span>' : ''}</span></td><td data-label="Started by">${href ? `<a class="row-link" href="${escapeHtml(href)}">${who}</a>` : who}</td><td class="dim" data-label="Last active">${escapeHtml(fmtDate(c.lastActiveAt, d.timezone))}</td><td data-label="Tokens">${escapeHtml(tokens)}</td><td class="r" data-label="Est. cost">${escapeHtml(fmtUsd(c.costUsd))}</td></tr>`;
  });
  const chatTable =
    chatRows.length === 0
      ? emptyState('No chats yet.')
      : `<div class="tbl"><table><thead><tr><th scope="col">Thread</th><th scope="col">Started by</th><th scope="col">Last active</th>${TOKENS_HEAD}</tr></thead><tbody>${chatRows.join('')}</tbody></table></div>`;
  const chatTotal = ct.threads + ct.oneOffs;
  const pager = pagerHtml({ page: d.page, pages: d.pages, summary: `Showing ${rangeSummary(d.page, d.pageSize, d.jobs.length, t.jobs)}`, href: (p) => requestsHref(p, d.chatPage, d.pageSize, d.chatPageSize) + '#h-req', label: 'Feature request pages', showSingle: true, size: { current: d.pageSize, href: (s) => requestsHref(1, d.chatPage, s, d.chatPageSize) + '#h-req' } });
  const chatPager = pagerHtml({ page: d.chatPage, pages: d.chatPages, summary: `Showing ${rangeSummary(d.chatPage, d.chatPageSize, d.chats.length, chatTotal)}`, href: (p) => requestsHref(d.page, p, d.pageSize, d.chatPageSize) + '#h-chat', label: 'Chat pages', showSingle: true, size: { current: d.chatPageSize, href: (s) => requestsHref(d.page, 1, d.pageSize, s) + '#h-chat' } });
  return {
    ...chromeParts(d.deploy, now),
    'live-chat-kpis': [
      kpi(fmt(ct.threads), 'Chat threads'),
      kpi(fmt(ct.oneOffs), 'One-off replies'),
      kpi(fmt(ct.input + ct.output + ct.reasoning), 'Tokens', 'in + out + reasoning'),
      kpi(fmtCachePercent(ct), 'Cache hits', 'share of prompt tokens from cache'),
      kpi(fmtUsd(ct.costUsd), 'Est. cost'),
    ].join(''),
    'live-chats': `<section class="card" aria-labelledby="h-chat"><div class="card-head"><h2 id="h-chat">Chats</h2><span class="sub">${fmt(chatTotal)} total</span></div>${chatTable}${chatTotal === 0 ? '' : chatPager}</section>`,
    'live-req-kpis': [
      kpi(fmt(t.jobs), 'Requests'),
      kpi(fmt(t.input), 'Input tokens'),
      kpi(fmt(t.output), 'Output tokens'),
      kpi(fmt(t.reasoning), 'Reasoning tokens'),
      kpi(fmtCachePercent(t), 'Cache hits', 'share of prompt tokens from cache'),
      kpi(fmtUsd(t.costUsd), 'Est. cost'),
    ].join(''),
    'live-reqs': `<section class="card" aria-labelledby="h-req"><div class="card-head"><h2 id="h-req">Feature requests</h2><span class="sub">${fmt(t.jobs)} total</span></div>${table}${t.jobs === 0 ? '' : pager}</section>`,
  };
}

export function requestsPage(d: RequestsPageData, now: number = Date.now()): string {
  const parts = requestsParts(d, now);
  const body = `${actionFlashHtml(d.flash)}
  ${region('live-chat-kpis', parts, 'kpis')}
  ${region('live-chats', parts)}
  ${region('live-req-kpis', parts, 'kpis six')}
  ${region('live-reqs', parts)}`;
  return layout({ active: 'requests', title: 'Chats & requests', sub: '<p class="hero-sub">AI assistant usage. Costs are estimates from OpenCode Go list prices.</p>', live: 'status', body, now }, { user: d.user, deploy: d.deploy });
}

// ---- session transcript ------------------------------------------------------------
export interface SessionPageData {
  sessionId: string;
  owner: { kind: 'job'; job: BuildJob } | { kind: 'chat'; thread: ChatThread };
  entries: TranscriptEntry[];
  /** Cursor of the next older page; null when there is none. */
  olderCursor: string | null;
  /** Cursor this page was loaded with (an older page); null for the newest page. */
  cursor: string | null;
  /** Why the transcript could not be loaded (shown instead of the timeline). */
  error: string | null;
  guildId: string;
  timezone: string;
  members: Record<string, string>;
  user: { username: string; avatar: string | null };
  deploy?: DeployStatus;
  /** One-shot toast after a cancel/retry redirect. */
  flash?: PageFlash;
}

const TOOL_BADGE: Record<string, string> = { completed: 'ok', error: 'error', running: 'warn', streaming: 'warn' };

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)} min ${total % 60} s`;
}

/** Muted timing line under an assistant message; only the known parts. Empty when nothing is known. */
export function timingLine(e: Extract<TranscriptEntry, { kind: 'assistant' }>): string {
  const t = e.timing;
  const bits: string[] = [];
  if (t.firstTokenMs !== null) bits.push(`waited ${fmtMs(t.firstTokenMs)} for first token`);
  if (t.totalMs !== null) bits.push(`total ${fmtMs(t.totalMs)}`);
  if (t.toolsMs !== null) bits.push(`tools ${fmtMs(t.toolsMs)}`);
  if (t.retry) bits.push(`retry: ${t.retry}`);
  if (e.gapMs !== null && e.gapMs >= 5000) bits.push(`idle ${fmtMs(e.gapMs)} before this step`);
  return bits.length > 0 ? `<div class="toks">${escapeHtml(bits.join(' · '))}</div>` : '';
}

function toolPart(p: Extract<TranscriptPart, { kind: 'tool' }>, id: string): string {
  const badge = TOOL_BADGE[p.status] ?? '';
  const dur = p.durationMs !== null ? `<span class="muted">${escapeHtml(fmtMs(p.durationMs))}</span>` : '';
  const input = p.input ? `<div class="pre-l">Input</div><pre>${escapeHtml(p.input)}</pre>` : '';
  const output = p.output ? `<div class="pre-l">Output</div><pre>${escapeHtml(p.output)}</pre>` : '';
  const error = p.error ? `<div class="pre-l">Error</div><pre>${escapeHtml(p.error)}</pre>` : '';
  const body = input + output + error || '<div class="pre-l">No input or output</div>';
  return `<details id="${escapeHtml(id)}"><summary><b>${escapeHtml(p.name)}</b><span class="badge${badge ? ' ' + badge : ''}">${escapeHtml(p.status)}</span>${dur}</summary>${body}</details>`;
}

function entryHtml(e: TranscriptEntry, tz: string): string {
  const time = e.time !== null ? escapeHtml(fmtDate(e.time, tz)) : '';
  if (e.kind === 'event') return `<div class="evt"><span>${escapeHtml(e.label)}</span>${time ? `<span>${time}</span>` : ''}</div>`;
  if (e.kind === 'user') {
    const files = e.attachments.length > 0 ? `<p class="msg-t muted">${escapeHtml(e.attachments.join(' '))}</p>` : '';
    return `<article class="msg user"><div class="msg-h"><b>Prompt</b>${time ? `<span>${time}</span>` : ''}</div><p class="msg-t">${escapeHtml(e.text)}</p>${files}</article>`;
  }
  const parts = e.parts
    .map((p, i) => {
      const id = `d-${e.id}-${i}`;
      if (p.kind === 'text') return p.text.trim() ? `<p class="msg-t">${escapeHtml(p.text)}</p>` : '';
      if (p.kind === 'reasoning') return `<details id="${escapeHtml(id)}"><summary>Thinking · ${escapeHtml(fmt(p.chars))} chars</summary><pre>${escapeHtml(p.text)}</pre></details>`;
      return toolPart(p, id);
    })
    .join('');
  const t = e.tokens;
  const toks = t || e.cost !== null ? `<div class="toks">${t ? `in ${fmt(t.input)} / out ${fmt(t.output)} / reasoning ${fmt(t.reasoning)} / cache ${fmtCachePercent(t)}` : ''}${t && e.cost !== null ? ' · ' : ''}${e.cost !== null ? escapeHtml(fmtUsd(e.cost)) : ''}</div>` : '';
  const finish = e.finish && e.finish !== 'stop' && e.finish !== 'tool-calls' ? `<span class="badge${e.finish === 'error' ? ' error' : ''}">${escapeHtml(e.finish)}</span>` : '';
  const head = `<div class="msg-h"><b>Assistant</b>${e.agent ? `<span>${escapeHtml(e.agent)}</span>` : ''}${e.model ? `<span>${escapeHtml(e.model)}</span>` : ''}${time ? `<span>${time}</span>` : ''}${finish}</div>`;
  return `<article class="msg">${head}${parts}${e.error ? `<div class="err-t">${escapeHtml(e.error)}</div>` : ''}${toks}${timingLine(e)}</article>`;
}

/** Live regions of the session page, keyed by element id. */
export function sessionParts(d: SessionPageData, now: number = Date.now()): Record<string, string> {
  const o = d.owner;
  const usage = o.kind === 'job' ? o.job : o.thread;
  const model = (o.kind === 'job' ? o.job.model : o.thread.model) ?? 'default';
  const threadId = o.kind === 'job' ? o.job.threadId : o.thread.threadId.split(':')[0];
  const link = (href: string, label: string): string => `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  let links = [link(`https://discord.com/channels/${d.guildId}/${threadId}`, 'Thread'), ...(o.kind === 'job' && o.job.prUrl ? [link(o.job.prUrl, 'PR')] : [])].join('');
  const who = (id: string): string => d.members[id] ?? id;
  let heading: string;
  let facts: [string, string][];
  if (o.kind === 'job') {
    const j = o.job;
    const title = j.title?.trim() || (j.request.length > 80 ? j.request.slice(0, 80) + '…' : j.request);
    const badge = JOB_BADGE[j.status] ?? '';
    heading = `<h2 id="h-session">Feature request #${j.id}: ${escapeHtml(title)}</h2><span class="badge${badge ? ' ' + badge : ''}">${escapeHtml(j.status)}</span>`;
    const phase = j.planSessionId === null ? 'Plan and build (one session)' : j.planSessionId === d.sessionId ? 'Plan session (the build runs in a separate session)' : 'Build session (the plan was made in a separate session)';
    facts = [['Requested by', who(j.requesterId)], ['Created', fmtDate(j.createdAt, d.timezone)], ['Showing', phase]];
  } else {
    const c = o.thread;
    heading = `<h2 id="h-session">${c.oneOff ? 'One-off chat reply' : 'Chat thread'}</h2>`;
    facts = [['Started by', who(c.startedBy)], ['Last active', fmtDate(c.lastActiveAt, d.timezone)]];
  }
  const rows: [string, string][] = [
    ...facts,
    ['Model', model],
    ['Tokens (in / out / reasoning / cache %)', tokensCell({ input: usage.tokensInput, output: usage.tokensOutput, reasoning: usage.tokensReasoning, cacheRead: usage.tokensCacheRead, cacheWrite: usage.tokensCacheWrite })],
    ['Est. cost', fmtUsd(usage.costUsd)],
  ];
  let actions = '';
  if (o.kind === 'job') {
    const j = o.job;
    const other = j.planSessionId === null ? null : j.planSessionId === d.sessionId ? (j.sessionId ? { id: j.sessionId, label: 'Build session' } : null) : { id: j.planSessionId, label: 'Plan session' };
    if (other) links += sessionLink(other.id, other.label);
    const form = (verb: 'cancel' | 'retry', label: string, cls: string, ask: string): string =>
      `<form method="post" action="/dashboard/requests/${j.id}/${verb}?back=session"><button type="submit" class="btn ${cls}" onclick="return confirm('${ask}')">${label}</button></form>`;
    const buttons = [
      canCancel(j.status) ? form('cancel', 'Cancel', 'danger', `Cancel request #${j.id}? The running agent is stopped.`) : '',
      retryAction(j) !== 'none' ? form('retry', 'Retry', 'ghost', `Retry request #${j.id}?`) : '',
    ].join('');
    if (buttons) actions = `<div class="actions">${buttons}</div>`;
  }
  const dl = `<dl class="facts">${rows.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}<div><dt>Session</dt><dd><code>${escapeHtml(d.sessionId)}</code></dd></div><div><dt>Links</dt><dd><span class="links">${links}</span></dd></div></dl>`;
  const head = `<section class="card" aria-labelledby="h-session"><div class="card-head">${heading}</div>${actions}${dl}</section>`;

  let timeline: string;
  // Entries arrive newest first; parts inside one assistant message stay chronological.
  if (d.error) timeline = `<div class="err-t" role="alert">${escapeHtml(d.error)}</div>`;
  else if (d.entries.length === 0) timeline = emptyState('No messages yet.');
  else {
    const nav: string[] = [];
    if (d.cursor) nav.push(`<a class="pager-btn" href="${escapeHtml(sessionHref(d.sessionId))}">Latest messages</a>`);
    if (d.olderCursor) nav.push(`<a class="pager-btn" href="${escapeHtml(sessionHref(d.sessionId, d.olderCursor))}">Older messages</a>`);
    const navHtml = nav.length > 0 ? `<div class="pager">${nav.join('')}</div>` : '';
    timeline = `<div class="tl">${d.entries.map((e) => entryHtml(e, d.timezone)).join('')}</div>${navHtml}`;
  }
  return {
    ...chromeParts(d.deploy, now),
    'live-session-head': head,
    'live-session': `<section class="card" aria-labelledby="h-transcript"><div class="card-head"><h2 id="h-transcript">Transcript</h2><span class="sub">newest first${d.cursor ? ' · older page' : ''}</span></div>${timeline}</section>`,
  };
}

export function sessionPage(d: SessionPageData, now: number = Date.now()): string {
  const parts = sessionParts(d, now);
  const body = `${actionFlashHtml(d.flash)}
  ${region('live-session-head', parts)}
  ${region('live-session', parts)}`;
  return layout(
    {
      active: 'requests',
      title: 'Session',
      sub: '<p class="hero-sub"><a href="/dashboard/requests">← Chats &amp; requests</a> · the full transcript of one OpenCode session.</p>',
      // Older pages are a snapshot; only the newest page refreshes.
      live: d.cursor ? 'none' : 'status',
      liveView: 'session',
      body,
      now,
    },
    { user: d.user, deploy: d.deploy },
  );
}
