/** Metrics an izziv (challenge) can measure. Auto metrics come from the stats tables; manual ones are logged by hand. */
export const CHALLENGE_METRICS = ['messages', 'reactions', 'voice', 'activity', 'pushups', 'custom'] as const;
export type ChallengeMetric = (typeof CHALLENGE_METRICS)[number];

export function isChallengeMetric(value: unknown): value is ChallengeMetric {
  return typeof value === 'string' && (CHALLENGE_METRICS as readonly string[]).includes(value);
}

const LABELS: Record<ChallengeMetric, string> = {
  messages: 'Messages',
  reactions: 'Reactions given',
  voice: 'Voice time',
  activity: 'Activity time',
  pushups: 'Push-ups',
  custom: 'Custom',
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

/** Metrics members log by hand instead of measuring the stats tables. */
export function isManualMetric(metric: ChallengeMetric): boolean {
  return metric === 'pushups' || metric === 'custom';
}

/** Unit of the `target` field as entered in the wizard. */
export function metricTargetUnit(metric: ChallengeMetric): string {
  return isTimeMetric(metric) ? 'minutes' : metric === 'reactions' ? 'reactions' : metric === 'pushups' ? 'push-ups' : metric === 'custom' ? 'units' : 'messages';
}

/** Display name of one goal: the custom label when set, else the metric (and activity) name. */
export function goalName(goal: { metric: ChallengeMetric; label?: string | null; activityName?: string | null }): string {
  const label = goal.label?.trim();
  if (label) return label;
  return metricLabel(goal.metric) + (goal.metric === 'activity' && goal.activityName ? ` · ${goal.activityName}` : '');
}
