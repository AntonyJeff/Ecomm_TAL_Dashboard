import { google } from "googleapis";

const SHEET_ID = process.env.GOOGLE_SHEET_ID!;
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Global";
const ENGAGEMENT_SHEET_ID = process.env.ENGAGEMENT_SHEET_ID!;

function getAuth() {
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  return new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

export interface SheetAccount {
  accountId: string;
  accountName: string;
  website: string;
  accountOwner: string;
  potentialMrr: string;
  marketingRegion: string;
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

let cache: { rows: SheetAccount[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export async function getAccountsFromSheet(force = false): Promise<SheetAccount[]> {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.rows;
  }

  const sheets = google.sheets({ version: "v4", auth: getAuth() });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A1:Z`,
  });

  const values = res.data.values || [];
  if (values.length === 0) {
    cache = { rows: [], fetchedAt: Date.now() };
    return [];
  }

  const headers = values[0].map(normalizeHeader);
  const idx = {
    accountId: headers.findIndex((h) => h.includes("accountid")),
    accountName: headers.findIndex((h) => h.includes("accountname")),
    website: headers.findIndex((h) => h.includes("website")),
    accountOwner: headers.findIndex((h) => h.includes("accountowner")),
    potentialMrr: headers.findIndex((h) => h.includes("mrr")),
    marketingRegion: headers.findIndex((h) => h.includes("marketingregion") || h.includes("region")),
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
    }))
    .filter((r) => r.accountId);

  cache = { rows, fetchedAt: Date.now() };
  return rows;
}

/** domain (normalized) -> accountId, built from the Global sheet's Website column. */
let domainMapCache: { map: Map<string, string>; fetchedAt: number } | null = null;

export async function getDomainToAccountId(): Promise<Map<string, string>> {
  if (domainMapCache && Date.now() - domainMapCache.fetchedAt < CACHE_TTL_MS) {
    return domainMapCache.map;
  }
  const accounts = await getAccountsFromSheet();
  const map = new Map<string, string>();
  for (const a of accounts) {
    const d = normalizeDomain(a.website);
    if (d) map.set(d, a.accountId);
  }
  domainMapCache = { map, fetchedAt: Date.now() };
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

let sessionsCache: { rows: WebsiteSessionRow[]; fetchedAt: number } | null = null;
const SESSIONS_CACHE_TTL_MS = 2 * 60 * 1000; // this feed is "real time", so keep it fresher

export async function getWebsiteSessions(force = false): Promise<WebsiteSessionRow[]> {
  if (!force && sessionsCache && Date.now() - sessionsCache.fetchedAt < SESSIONS_CACHE_TTL_MS) {
    return sessionsCache.rows;
  }

  const sheets = google.sheets({ version: "v4", auth: getAuth() });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ENGAGEMENT_SHEET_ID,
    range: "Website_Sessions!A1:Z",
  });

  const values = res.data.values || [];
  if (values.length === 0) {
    sessionsCache = { rows: [], fetchedAt: Date.now() };
    return [];
  }

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

  sessionsCache = { rows, fetchedAt: Date.now() };
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

let linkedinCache: { rows: LinkedinSnapshotRow[]; fetchedAt: number } | null = null;
const LINKEDIN_CACHE_TTL_MS = 10 * 60 * 1000;

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
export async function getLinkedinSnapshotRows(force = false): Promise<LinkedinSnapshotRow[]> {
  if (!force && linkedinCache && Date.now() - linkedinCache.fetchedAt < LINKEDIN_CACHE_TTL_MS) {
    return linkedinCache.rows;
  }

  const sheets = google.sheets({ version: "v4", auth: getAuth() });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ENGAGEMENT_SHEET_ID,
    range: "Linkedin!A1:Z",
  });

  const values = res.data.values || [];
  if (values.length === 0) {
    linkedinCache = { rows: [], fetchedAt: Date.now() };
    return [];
  }

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

  linkedinCache = { rows, fetchedAt: Date.now() };
  return rows;
}

export interface FactorsScoreRow {
  runDate: string; // YYYY-MM-DD, the calendar day this snapshot represents
  accountId: string;
  engagementLevel: string; // "Hot" | "Warm" | "Cool" | "Ice" | "" (not yet scored by Factors)
  engagementScore: number | null;
}

let factorsScoreCache: { rows: FactorsScoreRow[]; fetchedAt: number } | null = null;
const FACTORS_SCORE_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Daily append-only history written by automation/factors_score_sync.py - one
 * row per account per day it ran, never overwritten. This is what lets a
 * past week permanently keep showing whatever Engagement Level was true as
 * of that week, even after the live Salesforce field has since moved on.
 */
export async function getFactorsScoreRows(force = false): Promise<FactorsScoreRow[]> {
  if (!force && factorsScoreCache && Date.now() - factorsScoreCache.fetchedAt < FACTORS_SCORE_CACHE_TTL_MS) {
    return factorsScoreCache.rows;
  }

  const sheets = google.sheets({ version: "v4", auth: getAuth() });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ENGAGEMENT_SHEET_ID,
    range: "Factors_Score!A1:O",
  });

  const values = res.data.values || [];
  if (values.length === 0) {
    factorsScoreCache = { rows: [], fetchedAt: Date.now() };
    return [];
  }

  const headers = values[0].map(normalizeHeader);
  const idx = {
    runDate: headers.findIndex((h) => h === "rundate"),
    accountId: headers.findIndex((h) => h === "accountid"),
    engagementLevel: headers.findIndex((h) => h === "engagementlevel"),
    engagementScore: headers.findIndex((h) => h === "factorsengagementscore"),
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
      };
    });

  factorsScoreCache = { rows, fetchedAt: Date.now() };
  return rows;
}
