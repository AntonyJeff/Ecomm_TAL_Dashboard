import { google, type sheets_v4 } from "googleapis";
import { createCachedLoader } from "./cache.js";

const ENGAGEMENT_SHEET_ID = process.env.ENGAGEMENT_SHEET_ID!;
// Everything now lives in one spreadsheet (ENGAGEMENT_SHEET_ID) as separate tabs -
// the TAL account roster was migrated into its own "Global_Ecomm_TAL" tab there.
const SHEET_ID = ENGAGEMENT_SHEET_ID;
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Global_Ecomm_TAL";

// One client for the whole process: the JWT client caches its access token
// (~1h) internally, whereas building a new one per read forced a fresh OAuth
// token exchange before every single sheet fetch.
let sheetsClient: sheets_v4.Sheets | null = null;
function getSheets(): sheets_v4.Sheets {
  if (!sheetsClient) {
    const privateKey = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
    const auth = new google.auth.JWT({
      email: process.env.GOOGLE_CLIENT_EMAIL,
      key: privateKey,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    sheetsClient = google.sheets({ version: "v4", auth });
  }
  return sheetsClient;
}

async function readRange(range: string): Promise<string[][]> {
  const res = await getSheets().spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  return (res.data.values as string[][]) || [];
}

export interface SheetAccount {
  accountId: string;
  accountName: string;
  website: string;
  accountOwner: string;
  potentialMrr: string;
  marketingRegion: string;
  /** P0/P1/P2, or "" if unset - confirmed these are the only values this sheet column ever holds. */
  accountPriority: string;
}

/** Strips protocol/www/trailing slash so sheet domains line up with each other. */
export function normalizeDomain(d: string): string {
  return (d || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const accountsLoader = createCachedLoader("accounts-sheet", loadAccounts, {
  ttlMs: 5 * 60 * 1000,
  maxStaleMs: 60 * 60 * 1000,
});

export function getAccountsFromSheet(force = false): Promise<SheetAccount[]> {
  return accountsLoader.get({ force });
}

/** Bumps whenever the roster is reloaded - for caches derived from it. */
export function accountsVersion(): number {
  return accountsLoader.version();
}

async function loadAccounts(): Promise<SheetAccount[]> {
  const values = await readRange(`${SHEET_TAB}!A1:Z`);
  if (values.length === 0) return [];

  const headers = values[0].map(normalizeHeader);
  const idx = {
    accountId: headers.findIndex((h) => h.includes("accountid")),
    accountName: headers.findIndex((h) => h.includes("accountname")),
    website: headers.findIndex((h) => h.includes("website")),
    accountOwner: headers.findIndex((h) => h.includes("accountowner")),
    potentialMrr: headers.findIndex((h) => h.includes("mrr")),
    marketingRegion: headers.findIndex((h) => h.includes("marketingregion") || h.includes("region")),
    accountPriority: headers.findIndex((h) => h === "accountpriority"),
  };

  const rows: SheetAccount[] = values.slice(1)
    .filter((r) => r.length > 0 && (idx.accountId < 0 || r[idx.accountId]))
    .map((r) => ({
      accountId: idx.accountId >= 0 ? r[idx.accountId] ?? "" : "",
      accountName: idx.accountName >= 0 ? r[idx.accountName] ?? "" : "",
      website: idx.website >= 0 ? r[idx.website] ?? "" : "",
      accountOwner: idx.accountOwner >= 0 ? r[idx.accountOwner] ?? "" : "",
      potentialMrr: idx.potentialMrr >= 0 ? r[idx.potentialMrr] ?? "" : "",
      marketingRegion: idx.marketingRegion >= 0 ? r[idx.marketingRegion] ?? "" : "",
      accountPriority: idx.accountPriority >= 0 ? r[idx.accountPriority] ?? "" : "",
    }))
    .filter((r) => r.accountId);

  return rows;
}

/** domain (normalized) -> accountId, built from the Global sheet's Website column. Rebuilt only when the roster reloads. */
let domainMapCache: { map: Map<string, string>; version: number } | null = null;

export async function getDomainToAccountId(): Promise<Map<string, string>> {
  const accounts = await getAccountsFromSheet();
  const version = accountsLoader.version();
  if (domainMapCache && domainMapCache.version === version) return domainMapCache.map;
  const map = new Map<string, string>();
  for (const a of accounts) {
    const d = normalizeDomain(a.website);
    if (d) map.set(d, a.accountId);
  }
  domainMapCache = { map, version };
  return map;
}

/**
 * One row = one session (a single visit, entry to exit) - NOT a cumulative
 * counter. `page_count` and `user_total_active_time` ARE lifetime running
 * totals for the account (they only ever go up), so they must never be used
 * to count or sum sessions - only `sessionActiveTimeSec` (this row's own
 * duration) is per-session data.
 */
export interface WebsiteSessionRow {
  domain: string; // normalized
  eventDate: string; // YYYY-MM-DD
  receivedAt: string; // ISO timestamp, for ordering same-day sessions
  sessionActiveTimeSec: number;
  firstPageUrl: string;
  latestPageUrl: string;
}

// This feed is near real time, so it's kept fresher and never served more
// than 10 minutes stale.
const sessionsLoader = createCachedLoader("website-sessions-sheet", loadWebsiteSessions, {
  ttlMs: 2 * 60 * 1000,
  maxStaleMs: 10 * 60 * 1000,
});

export function getWebsiteSessions(force = false): Promise<WebsiteSessionRow[]> {
  return sessionsLoader.get({ force });
}

async function loadWebsiteSessions(): Promise<WebsiteSessionRow[]> {
  const values = await readRange("Website_Sessions!A1:Z");
  if (values.length === 0) return [];

  const headers = values[0].map(normalizeHeader);
  const idx = {
    receivedAt: headers.findIndex((h) => h === "receivedat"),
    eventDate: headers.findIndex((h) => h === "eventdate"),
    domain: headers.findIndex((h) => h === "domain"),
    firstPageUrl: headers.findIndex((h) => h === "firstpageurl"),
    latestPageUrl: headers.findIndex((h) => h === "latestpageurl"),
    sessionActiveTime: headers.findIndex((h) => h === "sessionactivetime"),
  };

  const rows: WebsiteSessionRow[] = values
    .slice(1)
    .filter((r) => r.length > 0 && r[idx.domain] && r[idx.eventDate])
    .map((r) => ({
      domain: normalizeDomain(r[idx.domain]),
      eventDate: r[idx.eventDate],
      receivedAt: idx.receivedAt >= 0 ? r[idx.receivedAt] ?? "" : "",
      sessionActiveTimeSec: idx.sessionActiveTime >= 0 ? num(r[idx.sessionActiveTime]) : 0,
      firstPageUrl: idx.firstPageUrl >= 0 ? r[idx.firstPageUrl] ?? "" : "",
      latestPageUrl: idx.latestPageUrl >= 0 ? r[idx.latestPageUrl] ?? "" : "",
    }));

  return rows;
}

export interface LinkedinSnapshotRow {
  domain: string; // normalized
  snapshotDate: string; // YYYY-MM-DD, the "as of" date of the trailing-7-day window
  receivedAt: string; // ISO timestamp - when this row actually landed in the sheet
  organicImpressions: number;
  organicEngagements: number;
  paidImpressions: number;
  paidEngagements: number;
  paidClicks: number;
}

const linkedinLoader = createCachedLoader("linkedin-sheet", loadLinkedinSnapshotRows, {
  ttlMs: 10 * 60 * 1000,
  maxStaleMs: 60 * 60 * 1000,
});

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Each row is one campaign's trailing-7-day LinkedIn stats for one account.
 * `snapshotDate` (embedded in raw_payload) is the END of the 7-day window the
 * numbers describe, which is NOT the same as `receivedAt` - the window can
 * (and does) end several days before the export actually lands in the sheet.
 * Use `receivedAt` for "was this data actually available yet" checks, and
 * `snapshotDate` only for labeling which real-world period it covers.
 * Multiple rows per account per snapshot = multiple campaigns, not multiple
 * days - this data has no daily granularity, only whole snapshots.
 */
export function getLinkedinSnapshotRows(force = false): Promise<LinkedinSnapshotRow[]> {
  return linkedinLoader.get({ force });
}

export function linkedinVersion(): number {
  return linkedinLoader.version();
}

async function loadLinkedinSnapshotRows(): Promise<LinkedinSnapshotRow[]> {
  const values = await readRange("Linkedin!A1:Z");
  if (values.length === 0) return [];

  const headers = values[0].map(normalizeHeader);
  const idx = {
    domain: headers.findIndex((h) => h === "sfaccountdomain"),
    organicImpressions: headers.findIndex((h) => h === "li7dorganicimpressions"),
    organicEngagements: headers.findIndex((h) => h === "li7dorganicengagements"),
    paidImpressions: headers.findIndex((h) => h === "li7dpaidimpressions"),
    paidEngagements: headers.findIndex((h) => h === "li7dpaidengagements"),
    paidClicks: headers.findIndex((h) => h === "li7dpaidclicks"),
    rawPayload: headers.findIndex((h) => h === "rawpayload"),
    receivedAt: headers.findIndex((h) => h === "receivedat"),
  };

  const rows: LinkedinSnapshotRow[] = [];
  for (const r of values.slice(1)) {
    if (!r.length || !r[idx.domain]) continue;

    let snapshotDate = "";
    try {
      const payload = JSON.parse(r[idx.rawPayload] || "{}");
      const props = payload.MessageProperty || {};
      const dateProp = Object.values(props).find(
        (p: any) => p.DisplayName === "Timestamp - Date"
      ) as { PropValue?: string } | undefined;
      snapshotDate = dateProp?.PropValue || "";
    } catch {
      // fall through with an empty snapshotDate; row still counts under "unknown"
    }

    rows.push({
      domain: normalizeDomain(r[idx.domain]),
      snapshotDate,
      receivedAt: idx.receivedAt >= 0 ? r[idx.receivedAt] ?? "" : "",
      organicImpressions: num(r[idx.organicImpressions]),
      organicEngagements: num(r[idx.organicEngagements]),
      paidImpressions: num(r[idx.paidImpressions]),
      paidEngagements: num(r[idx.paidEngagements]),
      paidClicks: num(r[idx.paidClicks]),
    });
  }

  return rows;
}

export interface FactorsScoreRow {
  runDate: string; // YYYY-MM-DD, the calendar day this snapshot represents
  accountId: string;
  engagementLevel: string; // "Hot" | "Warm" | "Cool" | "Ice" | "" (not yet scored by Factors)
  engagementScore: number | null;
  /** Raw "Top Engagement Signals" text from Factors.ai, e.g. "Linkedin Paid Impressions 83 , Form Submitted v2 2" - the "why" behind a level/score jump. */
  topEngagementSignals: string;
}

/**
 * The Factors history pre-grouped by day and by account, built once per sheet
 * reload. The sheet grows by ~5,500 rows every night, so callers that used to
 * scan every row on every request (to find one day, or one account) now do a
 * direct lookup instead.
 */
export interface FactorsScoreIndex {
  rows: FactorsScoreRow[];
  /** Every runDate present, ascending. */
  dates: string[];
  byDate: Map<string, FactorsScoreRow[]>;
  byAccount: Map<string, FactorsScoreRow[]>;
}

const factorsScoreLoader = createCachedLoader("factors-score-sheet", loadFactorsScoreIndex, {
  ttlMs: 5 * 60 * 1000,
  maxStaleMs: 30 * 60 * 1000,
});

/**
 * Daily append-only history written by automation/factors_score_sync.py - one
 * row per account per day it ran, never overwritten. This is what lets a
 * past week permanently keep showing whatever Engagement Level was true as
 * of that week, even after the live Salesforce field has since moved on.
 */
export async function getFactorsScoreRows(force = false): Promise<FactorsScoreRow[]> {
  return (await factorsScoreLoader.get({ force })).rows;
}

export function getFactorsScoreIndex(force = false): Promise<FactorsScoreIndex> {
  return factorsScoreLoader.get({ force });
}

async function loadFactorsScoreIndex(): Promise<FactorsScoreIndex> {
  const rows = await loadFactorsScoreRows();
  const byDate = new Map<string, FactorsScoreRow[]>();
  const byAccount = new Map<string, FactorsScoreRow[]>();
  for (const r of rows) {
    let d = byDate.get(r.runDate);
    if (!d) byDate.set(r.runDate, (d = []));
    d.push(r);
    let a = byAccount.get(r.accountId);
    if (!a) byAccount.set(r.accountId, (a = []));
    a.push(r);
  }
  return { rows, dates: Array.from(byDate.keys()).sort(), byDate, byAccount };
}

async function loadFactorsScoreRows(): Promise<FactorsScoreRow[]> {
  const values = await readRange("Factors_Score!A1:O");
  if (values.length === 0) return [];

  const headers = values[0].map(normalizeHeader);
  const idx = {
    runDate: headers.findIndex((h) => h === "rundate"),
    accountId: headers.findIndex((h) => h === "accountid"),
    engagementLevel: headers.findIndex((h) => h === "engagementlevel"),
    engagementScore: headers.findIndex((h) => h === "factorsengagementscore"),
    topEngagementSignals: headers.findIndex((h) => h === "topengagementsignals"),
  };

  const rows: FactorsScoreRow[] = values
    .slice(1)
    .filter((r) => r.length > 0 && r[idx.runDate] && r[idx.accountId])
    .map((r) => {
      const rawScore = idx.engagementScore >= 0 ? r[idx.engagementScore] : "";
      const parsed = Number(rawScore);
      return {
        runDate: r[idx.runDate],
        accountId: r[idx.accountId],
        engagementLevel: idx.engagementLevel >= 0 ? r[idx.engagementLevel] ?? "" : "",
        engagementScore: rawScore && Number.isFinite(parsed) ? parsed : null,
        topEngagementSignals: idx.topEngagementSignals >= 0 ? r[idx.topEngagementSignals] ?? "" : "",
      };
    });

  return rows;
}
