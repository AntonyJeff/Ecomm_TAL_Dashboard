import type { LinkedinMetrics, RankEntry } from "./api";

export interface ScoreMetric {
  key: string;
  label: string;
  weight: number;
  getValue: (
    accountId: string,
    ranks: Record<string, RankEntry>,
    li: Record<string, LinkedinMetrics> | undefined
  ) => number;
}

/**
 * Weighted engagement score - the industry-standard technique for combining
 * heterogeneous engagement signals into one priority number (the same idea
 * behind HubSpot/Marketo-style behavioral lead scoring and account-level
 * intent scoring from 6sense/Demandbase). Not a mean or median: those treat
 * every metric as if it lived on the same scale, but LinkedIn impressions
 * (hundreds) and WhatsApp replies (0 or 1 for almost everyone) are not
 * comparable numbers, so a raw average would let whichever metric has the
 * biggest numbers drown out everything else regardless of how meaningful it
 * actually is.
 *
 * Fix: convert every metric to a PERCENTILE RANK (0-100, relative to all
 * other accounts that week) before combining - this puts every metric on
 * the same 0-100 scale and is robust to the heavy skew in this data (most
 * accounts at 0, a few very high), unlike min-max scaling where one outlier
 * account would compress everyone else toward 0.
 *
 * Weights reflect buying-intent strength, not just activity volume:
 *   3 = active, effortful response (clicked, replied)
 *   2 = engaged but passive (opened, read, visited, LinkedIn engagement/click)
 *   1 = passive/algorithmic exposure (LinkedIn impressions)
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
  { key: "emailClicks", label: "Email clicks", weight: 3, getValue: (id, r) => r[id]?.emailClicks ?? 0 },
  { key: "waReplied", label: "WhatsApp replied", weight: 3, getValue: (id, r) => r[id]?.waReplied ?? 0 },
  { key: "waClicked", label: "WhatsApp clicked", weight: 3, getValue: (id, r) => r[id]?.waClicked ?? 0 },

  { key: "emailOpens", label: "Email opens", weight: 2, getValue: (id, r) => r[id]?.emailOpens ?? 0 },
  { key: "waRead", label: "WhatsApp read", weight: 2, getValue: (id, r) => r[id]?.waRead ?? 0 },
  { key: "websiteSessions", label: "Website sessions", weight: 2, getValue: (id, r) => r[id]?.websiteSessions ?? 0 },
  {
    key: "liOrganicEngagements",
    label: "LinkedIn organic engagements",
    weight: 2,
    getValue: (id, _r, li) => li?.[id]?.organicEngagements ?? 0,
  },
  {
    key: "liPaidEngagements",
    label: "LinkedIn paid engagements",
    weight: 2,
    getValue: (id, _r, li) => li?.[id]?.paidEngagements ?? 0,
  },
  {
    key: "liPaidClicks",
    label: "LinkedIn paid clicks",
    weight: 2,
    getValue: (id, _r, li) => li?.[id]?.paidClicks ?? 0,
  },

  {
    key: "liOrganicImpressions",
    label: "LinkedIn organic impressions",
    weight: 1,
    getValue: (id, _r, li) => li?.[id]?.organicImpressions ?? 0,
  },
  {
    key: "liPaidImpressions",
    label: "LinkedIn paid impressions",
    weight: 1,
    getValue: (id, _r, li) => li?.[id]?.paidImpressions ?? 0,
  },
];

const TOTAL_WEIGHT = SCORE_METRICS.reduce((sum, m) => sum + m.weight, 0);

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
 * Weighted percentile score (0-100) per account for the given week - the
 * single number used to prioritize which accounts to work this week.
 * Percentile rank is relative to the whole set, so this is one pass over
 * every account at once, not computed independently per row.
 */
export function computeEngagementScores(
  accountIds: string[],
  ranks: Record<string, RankEntry>,
  liMetrics: Record<string, LinkedinMetrics> | undefined
): Record<string, number> {
  const percentilesByMetric = SCORE_METRICS.map((m) =>
    percentileRanks(accountIds.map((id) => m.getValue(id, ranks, liMetrics)))
  );

  const scores: Record<string, number> = {};
  accountIds.forEach((id, idx) => {
    let weighted = 0;
    for (let m = 0; m < SCORE_METRICS.length; m++) {
      weighted += SCORE_METRICS[m].weight * percentilesByMetric[m][idx];
    }
    scores[id] = Math.round((weighted / TOTAL_WEIGHT) * 10) / 10;
  });
  return scores;
}
