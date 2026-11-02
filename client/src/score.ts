import type { LinkedinMetrics, RankEntry } from "./api";

export interface ScoreMetric {
  key: string;
  label: string;
  getValue: (
    accountId: string,
    ranks: Record<string, RankEntry>,
    li: Record<string, LinkedinMetrics> | undefined
  ) => number;
}

/**
 * Engagement Score - a plain sum of every marketing-side touchpoint count for
 * the selected week: website sessions, email opens/clicks, WhatsApp
 * read/clicked/replied, LinkedIn organic/paid engagements and paid clicks.
 * Raw counts, added together, no weighting or percentile conversion.
 *
 * LinkedIn impressions are excluded from that plain sum and counted
 * differently instead, since a single impression is a far weaker signal than
 * any of the other touchpoints and would otherwise swamp the total just by
 * being a much bigger raw number: every full 500 impressions (organic + paid
 * combined) contributes 1 point - 500 impressions = 1, 1000 = 2, 1500 = 3,
 * and so on (Math.floor(impressions / 500)).
 *
 * Marketing-only, by design: MDR and Sales outreach (Outreach.io touches) are
 * tracked as their own columns but deliberately excluded from this score.
 * The score's job is to tell MDR/Sales WHICH accounts to prioritize based on
 * how marketing has already engaged them - it can't also be influenced by
 * MDR/Sales' own outreach, or an account would be able to score itself up
 * just by getting called or emailed, which inverts the cause-and-effect this
 * score exists to drive.
 */
export const SCORE_METRICS: ScoreMetric[] = [
  { key: "websiteSessions", label: "Website sessions", getValue: (id, r) => r[id]?.websiteSessions ?? 0 },
  { key: "emailOpens", label: "Email opens", getValue: (id, r) => r[id]?.emailOpens ?? 0 },
  { key: "emailClicks", label: "Email clicks", getValue: (id, r) => r[id]?.emailClicks ?? 0 },
  { key: "waRead", label: "WhatsApp read", getValue: (id, r) => r[id]?.waRead ?? 0 },
  { key: "waClicked", label: "WhatsApp clicked", getValue: (id, r) => r[id]?.waClicked ?? 0 },
  { key: "waReplied", label: "WhatsApp replied", getValue: (id, r) => r[id]?.waReplied ?? 0 },
  {
    key: "liOrganicEngagements",
    label: "LinkedIn organic engagements",
    getValue: (id, _r, li) => li?.[id]?.organicEngagements ?? 0,
  },
  {
    key: "liPaidEngagements",
    label: "LinkedIn paid engagements",
    getValue: (id, _r, li) => li?.[id]?.paidEngagements ?? 0,
  },
  {
    key: "liPaidClicks",
    label: "LinkedIn paid clicks",
    getValue: (id, _r, li) => li?.[id]?.paidClicks ?? 0,
  },
];

/** Every 500 combined LinkedIn impressions (organic + paid) = 1 point. */
const IMPRESSIONS_PER_POINT = 500;

/**
 * Percentile rank (0-100) of each value within the array, where ZERO always
 * gets percentile 0 no matter how many other accounts also happen to be
 * zero. This deviates from the textbook "average rank of ties" convention
 * on purpose: these touchpoints are extremely sparse (most accounts are
 * literally inactive on any given channel), so a huge tied-at-zero block
 * would otherwise land around the 40-50th percentile - the tied group's
 * "average rank" sits in the middle of wherever that block falls, not at
 * the floor. That's correct statistics but wrong for this score's meaning:
 * an account with zero activity on a metric should contribute zero to it,
 * not something that reads as "roughly average." Confirmed as a real bug
 * from live data: an account with literal zero on every single touchpoint
 * scored 49.2/100 before this fix.
 *
 * Still used for the multi-metric "top accounts by" quick-sort feature (to
 * put differently-scaled metrics on a comparable footing), and to color the
 * Score pill relative to this week's other accounts - no longer used to
 * compute the Score number itself, which is a plain sum (see
 * computeEngagementScores).
 */
export function percentileRanks(values: number[]): number[] {
  const n = values.length;
  const result = new Array<number>(n).fill(0);

  const nonZero = [];
  for (let i = 0; i < n; i++) {
    if (values[i] > 0) nonZero.push(i);
  }
  const nz = nonZero.length;
  if (nz === 0) return result; // everyone's zero - already all 0
  if (nz === 1) {
    result[nonZero[0]] = 100;
    return result;
  }

  const order = [...nonZero].sort((a, b) => values[a] - values[b]);
  let i = 0;
  while (i < nz) {
    let j = i;
    while (j + 1 < nz && values[order[j + 1]] === values[order[i]]) j++;
    const avgRank = (i + j) / 2;
    const pct = (avgRank / (nz - 1)) * 100;
    for (let k = i; k <= j; k++) result[order[k]] = pct;
    i = j + 1;
  }
  return result;
}

/**
 * Engagement Score per account for the given week: the plain sum of every
 * metric in SCORE_METRICS, plus LinkedIn impression points
 * (floor(impressions / 500)). Unbounded, not 0-100 - callers that need a
 * relative "how hot is this vs. everyone else this week" read (e.g. the
 * Score pill's color) should run this through percentileRanks separately.
 */
export function computeEngagementScores(
  accountIds: string[],
  ranks: Record<string, RankEntry>,
  liMetrics: Record<string, LinkedinMetrics> | undefined
): Record<string, number> {
  const scores: Record<string, number> = {};
  accountIds.forEach((id) => {
    let sum = 0;
    for (const m of SCORE_METRICS) sum += m.getValue(id, ranks, liMetrics);

    const organicImpressions = liMetrics?.[id]?.organicImpressions ?? 0;
    const paidImpressions = liMetrics?.[id]?.paidImpressions ?? 0;
    const impressionPoints = Math.floor((organicImpressions + paidImpressions) / IMPRESSIONS_PER_POINT);

    scores[id] = sum + impressionPoints;
  });
  return scores;
}
