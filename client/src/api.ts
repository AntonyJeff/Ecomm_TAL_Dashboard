import type { ContactRow, EmailEvent, SheetAccount } from "./types";

async function getJson<T>(url: string): Promise<T> {
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

  salesEmailOut: "Sales email out",
  salesEmailOpened: "Sales email opened",
  salesEmailClicked: "Sales email clicked",
  salesEmailReplied: "Sales email replied",
  salesCalls: "Sales calls",
} as const;

export type TouchpointKey = keyof typeof TOUCHPOINTS;

export type TouchpointSource = "marketing" | "mdr" | "sales";

/** Which of the three effort groups each touchpoint belongs to - drives the grouped table header and sort-dropdown sections. */
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

  salesEmailOut: "sales",
  salesEmailOpened: "sales",
  salesEmailClicked: "sales",
  salesEmailReplied: "sales",
  salesCalls: "sales",
};

export type RankEntry = Record<TouchpointKey, number> & { websiteSessions: number };

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
}

export function fetchWebsiteSessionEvents(accountId: string, range: DateRange) {
  return getJson<{ sessionCount: number; totalDurationSec: number; events: WebsiteSessionEvent[] }>(
    `/api/accounts/${accountId}/website-sessions?${rangeParams(range)}`
  );
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
