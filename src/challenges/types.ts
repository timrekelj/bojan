/** Metrics an izziv (challenge) can measure. Values come from the existing stats tables. */
export const CHALLENGE_METRICS = ['messages', 'reactions', 'voice', 'activity'] as const;
export type ChallengeMetric = (typeof CHALLENGE_METRICS)[number];

export function isChallengeMetric(value: unknown): value is ChallengeMetric {
  return typeof value === 'string' && (CHALLENGE_METRICS as readonly string[]).includes(value);
}

const LABELS: Record<ChallengeMetric, string> = {
  messages: 'Messages',
  reactions: 'Reactions given',
  voice: 'Voice time',
  activity: 'Activity time',
};

/** Dashboard / Discord label of a metric. */
export function metricLabel(metric: ChallengeMetric): string {
  return LABELS[metric];
}

/**
 * Time metrics store progress in milliseconds and take their target in
 * minutes; counts (messages, reactions) are plain numbers.
 */
export function isTimeMetric(metric: ChallengeMetric): boolean {
  return metric === 'voice' || metric === 'activity';
}

/** Unit of the `target` field as entered in the wizard. */
export function metricTargetUnit(metric: ChallengeMetric): string {
  return isTimeMetric(metric) ? 'minutes' : metric === 'reactions' ? 'reactions' : 'messages';
}
