import type { ContactRow, EmailEvent, SheetAccount } from "./types";

// Empty in local dev (Vite's proxy forwards /api to localhost:4000 - see
// vite.config.ts). In production the client and server are two separate
// deployments (client on Vercel, server on Render), so this must point at
// the server's real URL - set via VITE_API_BASE_URL at build time.
const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

async function getJson<T>(path: string): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${url} -> ${res.status}: ${body}`);
  }
  return res.json();
}

export function fetchAccounts() {
  return getJson<{ accounts: SheetAccount[]; total: number; instanceUrl: string }>("/api/accounts");
}

export interface DateRange {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
}

function rangeParams(range: DateRange | null): URLSearchParams {
  const p = new URLSearchParams();
  if (range && range.start && range.end) {
    p.set("start", range.start);
    p.set("end", range.end);
  }
  return p;
}

/** Keys must match server/src/routes/accounts.ts TOUCHPOINTS exactly. */
export const TOUCHPOINTS = {
  emailOpens: "Email opens",
  emailClicks: "Email clicks",
  waRead: "WhatsApp read",
  waReplied: "WhatsApp replied",
  waClicked: "WhatsApp clicked",

  mdrEmailOut: "MDR email out",
  mdrEmailOpened: "MDR email opened",
  mdrEmailClicked: "MDR email clicked",
  mdrEmailReplied: "MDR email replied",
  mdrCalls: "MDR calls",
  mdrWaCalls: "MDR WhatsApp calls",

  sdrEmailOut: "SDR email out",
  sdrEmailOpened: "SDR email opened",
  sdrEmailClicked: "SDR email clicked",
  sdrEmailReplied: "SDR email replied",
  sdrCalls: "SDR calls",
  sdrWaCalls: "SDR WhatsApp calls",

  salesEmailOut: "Sales email out",
  salesEmailOpened: "Sales email opened",
  salesEmailClicked: "Sales email clicked",
  salesEmailReplied: "Sales email replied",
  salesCalls: "Sales calls",
  salesWaCalls: "Sales WhatsApp calls",
} as const;

export type TouchpointKey = keyof typeof TOUCHPOINTS;

export type TouchpointSource = "marketing" | "mdr" | "sdr" | "sales";

/** Which of the four effort groups each touchpoint belongs to - drives the grouped table header and sort-dropdown sections. */
export const TOUCHPOINT_SOURCE: Record<TouchpointKey, TouchpointSource> = {
  emailOpens: "marketing",
  emailClicks: "marketing",
  waRead: "marketing",
  waReplied: "marketing",
  waClicked: "marketing",

  mdrEmailOut: "mdr",
  mdrEmailOpened: "mdr",
  mdrEmailClicked: "mdr",
  mdrEmailReplied: "mdr",
  mdrCalls: "mdr",
  mdrWaCalls: "mdr",

  sdrEmailOut: "sdr",
  sdrEmailOpened: "sdr",
  sdrEmailClicked: "sdr",
  sdrEmailReplied: "sdr",
  sdrCalls: "sdr",
  sdrWaCalls: "sdr",

  salesEmailOut: "sales",
  salesEmailOpened: "sales",
  salesEmailClicked: "sales",
  salesEmailReplied: "sales",
  salesCalls: "sales",
  salesWaCalls: "sales",
};

export type RankEntry = Record<TouchpointKey, number> & {
  websiteSessions: number;
  highIntentSessions: number;
  mediumIntentSessions: number;
};

/**
 * Combines per-week rank results into one combined total, for multi-week
 * selection - every field on RankEntry is a plain count, so "touchpoints
 * across Week 2 + Week 4" is just the sum of each week's own numbers.
 */
export function mergeRankMaps(maps: Record<string, RankEntry>[]): Record<string, RankEntry> {
  const out: Record<string, RankEntry> = {};
  for (const map of maps) {
    for (const [accountId, entry] of Object.entries(map)) {
      const existing = out[accountId];
      if (!existing) {
        out[accountId] = { ...entry };
        continue;
      }
      for (const key of Object.keys(entry) as (keyof RankEntry)[]) {
        (existing[key] as number) = (existing[key] as number) + (entry[key] as number);
      }
    }
  }
  return out;
}

/**
 * Every touchpoint count (+ website sessions) for EVERY account in the given
 * date range - used to sort the table. `cached: "stale"` means you got the
 * last-known numbers instantly while the server refreshes them in the
 * background (stale-while-revalidate) - safe to treat the same as `true`
 * for display purposes, just slightly behind.
 */
export function fetchRank(range: DateRange) {
  return getJson<{ ranks: Record<string, RankEntry>; cached: boolean | "stale" }>(
    `/api/accounts/rank?${rangeParams(range)}`
  );
}

export function fetchContactCounts(ids: string[]) {
  if (ids.length === 0) return Promise.resolve({ counts: {} as Record<string, number> });
  return getJson<{ counts: Record<string, number> }>(
    `/api/accounts/contact-counts?ids=${ids.join(",")}`
  );
}

export interface ContactsSummary {
  total: number;
  active: number;
  inactive: number;
  inactivePct: number;
}

export function fetchContacts(accountId: string, range: DateRange) {
  return getJson<{ summary: ContactsSummary | null; contacts: ContactRow[] }>(
    `/api/accounts/${accountId}/contacts?${rangeParams(range)}`
  );
}

export function fetchTouchpointEvents(accountId: string, key: TouchpointKey, range: DateRange | null) {
  return getJson<{ events: EmailEvent[] }>(
    `/api/accounts/${accountId}/touchpoints/${key}?${rangeParams(range)}`
  );
}

export interface WebsiteSessionEvent {
  date: string;
  receivedAt: string;
  durationSec: number;
  firstPageUrl: string;
  latestPageUrl: string;
  /** Entry or exit page matches a high-intent page from the Factors.ai scoring sheet. */
  highIntent: boolean;
  /** Same, but Medium tier - only true when highIntent is false (High always takes precedence). */
  mediumIntent: boolean;
}

export function fetchWebsiteSessionEvents(accountId: string, range: DateRange) {
  return getJson<{
    sessionCount: number;
    totalDurationSec: number;
    highIntentCount: number;
    mediumIntentCount: number;
    events: WebsiteSessionEvent[];
  }>(`/api/accounts/${accountId}/website-sessions?${rangeParams(range)}`);
}

export interface LinkedinMetrics {
  organicImpressions: number;
  organicEngagements: number;
  paidImpressions: number;
  paidEngagements: number;
  paidClicks: number;
}

export interface LinkedinSnapshot {
  index: number;
  windowStart: string;
  asOfDate: string;
  /** When this window's data actually landed in the sheet - NOT the same as asOfDate, which is just the window's own end date. Use this for "was it available by week X" checks. */
  receivedDate: string;
  metrics: Record<string, LinkedinMetrics>;
}

/**
 * NOT aligned to the Week 1-4 selector - confirmed from real data that
 * LinkedIn exports land irregularly (observed gap: 4 days, on different
 * weekdays each time), each a rolling trailing-7-day window as of its own
 * date. Independent list of every snapshot seen so far, oldest first.
 */
export function fetchLinkedinSnapshots() {
  return getJson<{ snapshots: LinkedinSnapshot[] }>("/api/accounts/linkedin-snapshots");
}

export interface FactorsSnapshot {
  level: string; // "Hot" | "Warm" | "Cool" | "Ice" | "" (not yet scored)
  score: number | null;
}

/**
 * Factor Score for every account for the given period. A past, fully-
 * elapsed period is permanent history (from the daily Factors_Score sheet,
 * never retroactively rewritten); a period that includes today is live,
 * straight from Salesforce, since today's row doesn't exist in the sheet
 * until tonight's automation run. `isLive` tells you which one you got.
 */
export function fetchFactorsScores(range: DateRange) {
  return getJson<{ asOfDate: string; isLive: boolean; byAccount: Record<string, FactorsSnapshot> }>(
    `/api/accounts/factors-score?${rangeParams(range)}`
  );
}

export interface FactorsHistoryEntry {
  date: string;
  level: string;
  score: number | null;
  isLive: boolean;
}

/** Every daily snapshot ever captured for one account - the "when and how did this change" drill-down, independent of whichever week is selected. */
export function fetchFactorsHistory(accountId: string) {
  return getJson<{ history: FactorsHistoryEntry[] }>(`/api/accounts/${accountId}/factors-history`);
}

export interface TopSignal {
  label: string;
  count: number | null;
}

export interface SpikeAccount {
  accountId: string;
  accountName: string;
  fromLevel: string;
  fromScore: number | null;
  toLevel: string;
  toScore: number | null;
  signals: TopSignal[];
  /** First day within the requested week the account's level reached its new tier - newest first when sorted. */
  crossedDate: string | null;
}

export interface FactorSpikesResult {
  /** The most recently SYNCED day within the requested week - never a live/in-progress "today." Null only if no day in that week has been captured yet. */
  date: string | null;
  /** The last snapshot before the week started - the baseline every spike in this week is measured against. */
  previousDate: string | null;
  /** Every day within this week that's actually been synced so far. */
  availableDates: string[];
  newlyHot: SpikeAccount[];
  newlyWarm: SpikeAccount[];
}

/**
 * "Who just spiked" comparison for one week (same Week 1/2/3... boundaries
 * as the rest of the dashboard) - every account that crossed into Hot or
 * Warm at any point during that week, compared against wherever it stood
 * right before the week began. For the current, still-running week this
 * naturally fills in more each day as tonight's sync lands - this
 * deliberately never shows a live/mid-day comparison (see the server's
 * comment on computeFactorSpikes): until tonight's run happens, today isn't
 * a day yet.
 */
export function fetchFactorSpikes(range: DateRange) {
  return getJson<FactorSpikesResult>(`/api/accounts/factor-spikes?${rangeParams(range)}`);
}
