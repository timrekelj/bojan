import { ContainerBuilder, MessageFlags, TextDisplayBuilder } from 'discord.js';
import { BLURPLE } from '../weekly.js';
import { formatUsage, type UsageLike } from './parse.js';

// Components V2 allows 4000 chars of text across all TextDisplays; keep headroom.
const TEXT_BUDGET = 3800;
const NO_MENTIONS = { parse: [] as never[] };

const GREEN = 0x57f287;
const YELLOW = 0xfee75c;
const RED = 0xed4245;
const GREY = 0x99aab5;

export interface BuilderMessage {
  components: ContainerBuilder[];
  flags: MessageFlags.IsComponentsV2;
  allowedMentions: typeof NO_MENTIONS;
}

/** Trim to at most `max` chars on a line boundary where possible, with an ellipsis. */
export function clip(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max - 1));
  const nl = cut.lastIndexOf('\n');
  return `${(nl > max * 0.6 ? cut.slice(0, nl) : cut).trimEnd()}…`;
}

/** Build a message from text blocks; `flexible` is the index of the block that absorbs trimming. */
function build(color: number, blocks: string[], flexible = -1): BuilderMessage {
  const texts = blocks.filter((b) => b.length > 0);
  const flexIdx = flexible >= 0 ? blocks.slice(0, flexible).filter((b) => b.length > 0).length : -1;
  if (flexIdx >= 0 && flexible < blocks.length && blocks[flexible]!.length > 0) {
    const others = texts.reduce((n, t, i) => (i === flexIdx ? n : n + t.length + 1), 0);
    texts[flexIdx] = clip(texts[flexIdx]!, TEXT_BUDGET - others);
  }
  const container = new ContainerBuilder().setAccentColor(color);
  for (const t of texts) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(t.slice(0, 3900)));
  return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: NO_MENTIONS };
}

function usageLine(usage?: UsageLike | null): string {
  return usage ? `-# ${formatUsage(usage)}` : '';
}

export interface PlanCardData {
  title: string;
  plan: string;
  questions: string[];
  /** Agent's visible text, used when the plan field is empty. */
  visible?: string;
}

export function buildPlanCard(d: PlanCardData): BuilderMessage {
  const heading = `### ${d.title || 'Feature plan'}`;
  const questions =
    d.questions.length > 0
      ? `**Questions**\n${d.questions.map((q, i) => `${i + 1}. ${clip(q, 400)}`).join('\n')}`.slice(0, 1200)
      : '';
  const footer =
    d.questions.length > 0
      ? '-# Reply in this thread. Answer the questions, and tell me when it looks good and I\'ll start building.'
      : '-# Reply in this thread. Tell me when it looks good and I\'ll start building.';
  const body = d.plan || d.visible || '_No plan text returned._';
  return build(BLURPLE, [heading, body, questions, footer], 1);
}

/** Plain agent text card (e.g. a reply that had no valid result block). */
export function buildNoteCard(text: string): BuilderMessage {
  return build(BLURPLE, [clip(text, TEXT_BUDGET)], 0);
}

export function buildWorkingCard(text: string): BuilderMessage {
  return build(GREY, [text]);
}

export function buildBuildingCard(title: string): BuilderMessage {
  return build(YELLOW, [`### Approved, building…`, title ? `**${title}**` : '', '-# This can take a while. I\'ll post here when the PR is ready.']);
}

export function buildQueuedCard(d: { title: string; position: number }): BuilderMessage {
  return build(GREY, [
    `### Approved — queued, #${d.position} in line`,
    d.title ? `**${d.title}**` : '',
    '-# Another build is running. I\'ll start this one as soon as a build slot is free.',
  ]);
}

export function buildResumingCard(title: string): BuilderMessage {
  return build(YELLOW, ['### Resuming after restart…', title ? `**${title}**` : '', '-# The bot restarted while this was running. I\'m picking it up again.']);
}

export function buildConflictFixCard(title: string): BuilderMessage {
  return build(YELLOW, ['### PR conflicts with main — trying to fix', title ? `**${title}**` : '', '-# I\'m asking the build agent to merge main into the branch. This can take a while.']);
}

export function buildConflictFixedCard(d: { title: string; prUrl: string }): BuilderMessage {
  return build(GREEN, ['### Conflicts resolved', d.title ? `**${d.title}**` : '', `[Pull request](${d.prUrl}) was updated and still merges automatically once checks pass.`]);
}

export function buildConflictManualCard(d: { title: string; prUrl: string; reason?: string }): BuilderMessage {
  return build(RED, [
    '### Could not resolve conflicts automatically',
    d.title ? `**${d.title}**` : '',
    `[Pull request](${d.prUrl}) conflicts with main and needs a manual merge.`,
    d.reason ? clip(d.reason, 1500) : '',
  ], 3);
}

export function buildPrOpenedCard(d: { title: string; prUrl: string; summary: string; usage?: UsageLike | null }): BuilderMessage {
  return build(GREEN, [
    '### Pull request opened',
    d.title ? `**${d.title}**` : '',
    d.summary,
    `[View the pull request](${d.prUrl})`,
    '-# It merges automatically once checks pass; I\'ll let you know here.',
    usageLine(d.usage),
  ], 2);
}

export function buildMergedCard(d: { title: string; prUrl: string; usage?: UsageLike | null }): BuilderMessage {
  return build(GREEN, [
    '### Merged 🎉',
    d.title ? `**${d.title}**` : '',
    `[Pull request](${d.prUrl}) was merged. Dokploy is deploying the new version now.`,
    usageLine(d.usage),
  ]);
}

export function buildClosedCard(d: { title: string; prUrl: string; usage?: UsageLike | null }): BuilderMessage {
  return build(GREY, [
    '### Pull request closed',
    d.title ? `**${d.title}**` : '',
    `[Pull request](${d.prUrl}) was closed without merging.`,
    usageLine(d.usage),
  ]);
}

export function buildFailedCard(d: { reason: string; usage?: UsageLike | null }): BuilderMessage {
  return build(RED, ['### Something went wrong', clip(d.reason || 'Unknown error.', 2500), usageLine(d.usage)], 1);
}

export function buildCancelledCard(usage?: UsageLike | null): BuilderMessage {
  return build(GREY, ['### Request cancelled', 'Nothing was built.', usageLine(usage)]);
}
