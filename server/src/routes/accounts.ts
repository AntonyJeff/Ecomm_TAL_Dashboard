import { Router } from "express";
import {
  getAccountsFromSheet,
  getDomainToAccountId,
  getWebsiteSessions,
  getLinkedinSnapshotRows,
  normalizeDomain,
} from "../googleSheets.js";
import { soqlQuery, getInstanceUrl, chunk, mapWithConcurrency } from "../salesforce.js";

export const accountsRouter = Router();

const SF_ID_RE = /^[a-zA-Z0-9]{15,18}$/;

function esc(id: string): string {
  if (!SF_ID_RE.test(id)) {
    throw new Error(`Invalid Salesforce id: ${id}`);
  }
  return id;
}

/**
 * Named individuals on the MDR team - confirmed by the user. Every Outreach.io
 * touchpoint (email out/opened/clicked/replied, call answered) is attributed
 * to whichever Salesforce User owns the Task. If that owner is one of these
 * people, the touch counts as "MDR"; any other owner (any other rep running
 * an Outreach.io cadence) counts as "Sales" instead. Same subject patterns,
 * same data source - only the owner decides which bucket it lands in.
 */
const MDR_OWNER_NAMES = new Set([
  "Neha Bohra",
  "Shubham Gaumat",
  "Abeer Ansari",
  "Zaid Khan",
  "Vedika Jain",
  "Atharva Jadhav",
]);

/**
 * Every Salesforce Task-based touchpoint the dashboard tracks, grouped into
 * three sources shown as separate sections in the UI:
 *
 *  - "marketing": bulk campaign automation (Subject prefix below), dated by
 *    ActivityDate (the real event day - CreatedDate is just when the sync
 *    landed, which runs ~1 day behind for both email and WhatsApp).
 *  - "mdr" / "sales": Outreach.io (the 1:1 sales engagement tool), split by
 *    Task Owner per MDR_OWNER_NAMES above. Confirmed via direct Salesforce
 *    inspection: Outreach syncs Task Subject lines like
 *    "[Outreach] [Email] [Opened] <actual subject>" and
 *    "[Outreach] Call Answered [Outbound]". Email body is only available for
 *    "Out" (sent) and "In" (reply) - "Opened"/"Clicked" are tracking pings
 *    with no body attached. For calls, only "Answered" (an actual connected
 *    conversation) counts - the other dispositions (No Answer, Voicemail,
 *    Busy, etc.) are attempts, not engagement, so they're intentionally not
 *    tracked. GTM Buddy's separate "GTM Buddy - Email sent: ..." tasks are a
 *    different tool entirely and are intentionally excluded - they simply
 *    don't match any of these Subject patterns.
 *
 * The mdr and sales variants of each touchpoint intentionally SHARE the same
 * subject prefix (owner decides which one matches - see computeRanks below).
 */
export const TOUCHPOINTS = {
  emailOpens: { prefix: "Email_open%", label: "Email opens", source: "marketing" as const },
  emailClicks: { prefix: "Email_click%", label: "Email clicks", source: "marketing" as const },
  waRead: { prefix: "Whatsapp_read%", label: "WhatsApp read", source: "marketing" as const },
  waReplied: { prefix: "Whatsapp_replied%", label: "WhatsApp replied", source: "marketing" as const },
  waClicked: { prefix: "Whatsapp_clicked%", label: "WhatsApp clicked", source: "marketing" as const },

  mdrEmailOut: { prefix: "[Outreach] [Email] [Out]%", label: "MDR email out", source: "mdr" as const },
  mdrEmailOpened: { prefix: "[Outreach] [Email] [Opened]%", label: "MDR email opened", source: "mdr" as const },
  mdrEmailClicked: { prefix: "[Outreach] [Email] [Clicked]%", label: "MDR email clicked", source: "mdr" as const },
  mdrEmailReplied: { prefix: "[Outreach] [Email] [In]%", label: "MDR email replied", source: "mdr" as const },
  mdrCalls: { prefix: "[Outreach] Call Answered [Outbound]%", label: "MDR calls", source: "mdr" as const },

  salesEmailOut: { prefix: "[Outreach] [Email] [Out]%", label: "Sales email out", source: "sales" as const },
  salesEmailOpened: { prefix: "[Outreach] [Email] [Opened]%", label: "Sales email opened", source: "sales" as const },
  salesEmailClicked: { prefix: "[Outreach] [Email] [Clicked]%", label: "Sales email clicked", source: "sales" as const },
  salesEmailReplied: { prefix: "[Outreach] [Email] [In]%", label: "Sales email replied", source: "sales" as const },
  salesCalls: { prefix: "[Outreach] Call Answered [Outbound]%", label: "Sales calls", source: "sales" as const },
} as const;

export type TouchpointKey = keyof typeof TOUCHPOINTS;
const TOUCHPOINT_KEYS = Object.keys(TOUCHPOINTS) as TouchpointKey[];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function requireDateRange(query: Record<string, any>): { start: string; end: string } {
  const { start, end } = query;
  if (!start || !end || !DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new Error("start and end (YYYY-MM-DD) are required");
  }
  return { start, end };
}

/** Parses ?start=YYYY-MM-DD&end=YYYY-MM-DD into a SOQL "AND ActivityDate >= x AND ActivityDate <= y" clause. */
function dateRangeClause(query: Record<string, any>): string {
  const start = query.start;
  const end = query.end;
  if (!start && !end) return "";

  if (start && !DATE_RE.test(start)) throw new Error(`Invalid start date: ${start}`);
  if (end && !DATE_RE.test(end)) throw new Error(`Invalid end date: ${end}`);

  let clause = "";
  if (start) clause += ` AND ActivityDate >= ${start}`;
  if (end) clause += ` AND ActivityDate <= ${end}`;
  return clause;
}

// GET /api/accounts - the static 5,500-row index from the "Global" sheet.
// Also returns instanceUrl so the client can link each row straight to its
// Salesforce Account record without a round trip per row.
accountsRouter.get("/", async (req, res) => {
  try {
    const refresh = req.query.refresh === "true";
    const [rows, instanceUrl] = await Promise.all([getAccountsFromSheet(refresh), getInstanceUrl()]);
    res.json({ accounts: rows, total: rows.length, instanceUrl });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/accounts/contact-counts?ids=id1,id2,id3 - # contacts for whichever
// page of accounts is currently visible. Not date-scoped.
accountsRouter.get("/contact-counts", async (req, res) => {
  try {
    const ids = String(req.query.ids || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (ids.length === 0) return res.json({ counts: {} });
    if (ids.length > 60) {
      return res.status(400).json({ error: "Request at most 60 account ids at a time" });
    }

    const idList = ids.map((id) => `'${esc(id)}'`).join(",");
    const rows = await soqlQuery<{ AccountId: string }>(
      `SELECT AccountId FROM Contact WHERE AccountId IN (${idList})`
    );

    const counts: Record<string, number> = {};
    for (const id of ids) counts[id] = 0;
    for (const r of rows) counts[r.AccountId] = (counts[r.AccountId] || 0) + 1;

    res.json({ counts });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export type RankEntry = Record<TouchpointKey, number> & { websiteSessions: number };

function emptyRankEntry(): RankEntry {
  const e = { websiteSessions: 0 } as RankEntry;
  for (const k of TOUCHPOINT_KEYS) e[k] = 0;
  return e;
}

// The Contact -> Account map never depends on the selected date range, but
// computeRanks() used to rebuild it from scratch (~19 SOQL queries) on every
// single week switch. Caching it independently means that cost is paid once
// per TTL window total, not once per distinct week clicked.
let contactMapCache: { computedAt: number; contactToAccount: Map<string, string> } | null = null;
const CONTACT_MAP_TTL_MS = 10 * 60 * 1000;

async function getContactToAccountMap(): Promise<{ contactToAccount: Map<string, string> }> {
  if (contactMapCache && Date.now() - contactMapCache.computedAt < CONTACT_MAP_TTL_MS) {
    return contactMapCache;
  }

  const accounts = await getAccountsFromSheet();
  const accountIds = accounts.map((a) => a.accountId);

  const contactToAccount = new Map<string, string>();
  const contactChunks = await mapWithConcurrency(chunk(accountIds, 300), 8, async (idBatch) => {
    const inList = idBatch.map((id) => `'${esc(id)}'`).join(",");
    return soqlQuery<{ Id: string; AccountId: string }>(
      `SELECT Id, AccountId FROM Contact WHERE AccountId IN (${inList})`
    );
  });
  for (const rows of contactChunks) {
    for (const c of rows) contactToAccount.set(c.Id, c.AccountId);
  }

  contactMapCache = { computedAt: Date.now(), contactToAccount };
  return contactMapCache;
}

const TOUCHPOINT_PREFIXES = TOUCHPOINT_KEYS.map((key) => ({
  key,
  prefix: TOUCHPOINTS[key].prefix.replace(/%$/, ""),
  source: TOUCHPOINTS[key].source,
}));

async function computeRanks(start: string, end: string): Promise<Record<string, RankEntry>> {
  const dateClause = dateRangeClause({ start, end });
  const [accounts, { contactToAccount }] = await Promise.all([
    getAccountsFromSheet(),
    getContactToAccountMap(),
  ]);

  const ranks: Record<string, RankEntry> = {};
  for (const a of accounts) ranks[a.accountId] = emptyRankEntry();

  // One single query for the whole org, instead of chunking our ~5,500
  // accounts' contacts into dozens of "WhoId IN (...)" batches. Measured
  // against live data: fetching ALL matching Tasks company-wide for a week
  // (~15k-27k rows) takes 3-5s as ONE query (SOQL pagination handles the
  // row volume automatically), versus 6s+ for the old chunked version doing
  // 50+ small queries - fewer, bigger round trips beats many small ones here.
  // Rows for contacts outside our 5,555 TAL accounts are simply discarded
  // below via the contactToAccount lookup. Owner.Name is needed to split
  // Outreach.io touches into MDR vs Sales (see TOUCHPOINTS doc comment).
  const uniquePrefixes = Array.from(new Set(TOUCHPOINT_PREFIXES.map((p) => p.prefix)));
  const subjectOr = uniquePrefixes.map((p) => `Subject LIKE '${p}%'`).join(" OR ");
  const tasks = await soqlQuery<{ WhoId: string; Subject: string; Owner: { Name: string } | null }>(
    `SELECT WhoId, Subject, Owner.Name FROM Task WHERE (${subjectOr})${dateClause}`
  );

  for (const t of tasks) {
    const accId = contactToAccount.get(t.WhoId);
    if (!accId || !ranks[accId]) continue;

    const matches = TOUCHPOINT_PREFIXES.filter((p) => t.Subject.startsWith(p.prefix));
    if (matches.length === 0) continue;

    if (matches.length === 1) {
      // Marketing automation - prefix alone identifies the touchpoint.
      ranks[accId][matches[0].key] += 1;
    } else {
      // Outreach.io mdr/sales pair sharing a prefix - the Task's owner
      // decides which bucket this touch belongs in.
      const isMdr = MDR_OWNER_NAMES.has(t.Owner?.Name || "");
      const chosen = matches.find((m) => m.source === (isMdr ? "mdr" : "sales"));
      if (chosen) ranks[accId][chosen.key] += 1;
    }
  }

  // Website sessions come from the real-time Google Sheet feed, not Salesforce -
  // cheap, so just filter the (already cached) sheet rows by date in memory.
  const [sessions, domainToAccount] = await Promise.all([
    getWebsiteSessions(),
    getDomainToAccountId(),
  ]);
  for (const s of sessions) {
    if (s.eventDate < start || s.eventDate > end) continue;
    const accId = domainToAccount.get(s.domain);
    if (accId && ranks[accId]) ranks[accId].websiteSessions += 1;
  }

  return ranks;
}

// Ranking is a full scan across every account's contacts/tasks for a date
// range - still the most expensive endpoint even after the optimizations
// above, so on top of the plain per-range cache this adds stale-while-
// revalidate: once a week has been computed once, later requests for it
// (even after the TTL expires) get the last-known numbers INSTANTLY while a
// background refresh brings the cache back up to date for next time. Only a
// week that has genuinely never been requested before has to block.
const rankCache = new Map<string, { computedAt: number; ranks: Record<string, RankEntry> }>();
const RANK_CACHE_TTL_MS = 10 * 60 * 1000;
const rankInFlight = new Map<string, Promise<Record<string, RankEntry>>>();
const recentRankKeys: string[] = []; // most-recently-requested first, deduped, capped

function touchRecentRankKey(key: string) {
  const i = recentRankKeys.indexOf(key);
  if (i >= 0) recentRankKeys.splice(i, 1);
  recentRankKeys.unshift(key);
  recentRankKeys.length = Math.min(recentRankKeys.length, 3);
}

function refreshRankInBackground(key: string, start: string, end: string): Promise<Record<string, RankEntry>> {
  const existing = rankInFlight.get(key);
  if (existing) return existing;
  const p = computeRanks(start, end)
    .then((ranks) => {
      rankCache.set(key, { computedAt: Date.now(), ranks });
      return ranks;
    })
    .finally(() => rankInFlight.delete(key));
  rankInFlight.set(key, p);
  return p;
}

// Keeps whichever 1-3 weeks people are actually looking at pre-warmed:
// refreshes them shortly before their cache would expire, so by the time a
// user clicks back to a recently-viewed week, it's already fresh again -
// without needing to know in advance which week "this week" is.
setInterval(() => {
  for (const key of recentRankKeys) {
    const cached = rankCache.get(key);
    if (!cached || Date.now() - cached.computedAt >= RANK_CACHE_TTL_MS - 30_000) {
      const [start, end] = key.split("|");
      // Fire-and-forget MUST be caught here - an uncaught rejection from a
      // background refresh (e.g. a transient Salesforce timeout) would
      // otherwise crash the whole Node process on an unhandled rejection.
      refreshRankInBackground(key, start, end).catch((err) =>
        console.error(`[rank] background prewarm failed for ${key}:`, err)
      );
    }
  }
}, 60 * 1000);

// GET /api/accounts/rank?start=YYYY-MM-DD&end=YYYY-MM-DD - every touchpoint
// count for EVERY account in the given date range, used to sort the table
// (accounts engaging on more distinct touchpoints rank first).
accountsRouter.get("/rank", async (req, res) => {
  try {
    const { start, end } = requireDateRange(req.query);
    const key = `${start}|${end}`;
    touchRecentRankKey(key);

    const cached = rankCache.get(key);
    const fresh = cached && Date.now() - cached.computedAt < RANK_CACHE_TTL_MS;

    if (fresh) {
      return res.json({ ranks: cached!.ranks, cached: true });
    }
    if (cached) {
      // Don't await - serve stale data now. Must still attach a .catch so a
      // transient failure here doesn't become an unhandled rejection.
      refreshRankInBackground(key, start, end).catch((err) =>
        console.error(`[rank] background refresh failed for ${key}:`, err)
      );
      return res.json({ ranks: cached.ranks, cached: "stale" });
    }

    const ranks = await refreshRankInBackground(key, start, end);
    res.json({ ranks, cached: false });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

interface LinkedinMetrics {
  organicImpressions: number;
  organicEngagements: number;
  paidImpressions: number;
  paidEngagements: number;
  paidClicks: number;
}

/**
 * Factors.ai exports one row per (account x ad/adgroup) that touched the
 * account that week, but li_7d_* fields are ACCOUNT-LEVEL rolling 7-day
 * totals - every row for the same account repeats the identical number
 * (verified: an account touched by 4 different ads had the same
 * paid-impressions value on all 4 rows). So these must be taken once per
 * account, never summed across its rows - summing would multiply the true
 * value by however many ad creatives happened to reach that account.
 */
function sumLinkedinByAccount(
  rows: Awaited<ReturnType<typeof getLinkedinSnapshotRows>>,
  snapshotDate: string,
  domainToAccount: Map<string, string>
): Record<string, LinkedinMetrics> {
  const out: Record<string, LinkedinMetrics> = {};
  for (const r of rows) {
    if (r.snapshotDate !== snapshotDate) continue;
    const accId = domainToAccount.get(r.domain);
    if (!accId) continue;
    if (!out[accId]) {
      out[accId] = { organicImpressions: 0, organicEngagements: 0, paidImpressions: 0, paidEngagements: 0, paidClicks: 0 };
    }
    out[accId].organicImpressions = Math.max(out[accId].organicImpressions, r.organicImpressions);
    out[accId].organicEngagements = Math.max(out[accId].organicEngagements, r.organicEngagements);
    out[accId].paidImpressions = Math.max(out[accId].paidImpressions, r.paidImpressions);
    out[accId].paidEngagements = Math.max(out[accId].paidEngagements, r.paidEngagements);
    out[accId].paidClicks = Math.max(out[accId].paidClicks, r.paidClicks);
  }
  return out;
}

function minus6Days(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 6);
  return d.toISOString().slice(0, 10);
}

/**
 * The window's own end date (snapshotDate) is NOT when the data actually
 * became available - exports land several days after the window they
 * describe (e.g. a Mon-Sun window gets pushed the following Tuesday or
 * later). Using the latest receivedAt among a window's rows as its
 * "available as of" date guards against treating a window as visible for a
 * past calendar week it hadn't actually landed by yet.
 */
function receivedDateForWindow(rows: Awaited<ReturnType<typeof getLinkedinSnapshotRows>>, snapshotDate: string): string {
  let latest = "";
  for (const r of rows) {
    if (r.snapshotDate !== snapshotDate || !r.receivedAt) continue;
    if (r.receivedAt > latest) latest = r.receivedAt;
  }
  // No receivedAt column found in the sheet - fall back to the window's own
  // end date rather than failing closed on every snapshot.
  return latest ? latest.slice(0, 10) : snapshotDate;
}

// GET /api/accounts/linkedin-snapshots - LinkedIn exports are irregular
// (observed gaps: 4-5 days, landing on different weekdays each time - NOT a
// fixed weekly cadence), each a rolling trailing-7-day window as of its own
// date. So this is intentionally NOT aligned to the Week 1-4 selector used
// for email/WhatsApp/website - it's its own independent list of snapshots,
// oldest first, each one appearing here automatically as it's exported.
accountsRouter.get("/linkedin-snapshots", async (req, res) => {
  try {
    const [rows, domainToAccount] = await Promise.all([
      getLinkedinSnapshotRows(),
      getDomainToAccountId(),
    ]);

    const dates = Array.from(new Set(rows.map((r) => r.snapshotDate).filter(Boolean))).sort();
    const snapshots = dates.map((asOfDate, i) => ({
      index: i + 1,
      windowStart: minus6Days(asOfDate),
      asOfDate,
      receivedDate: receivedDateForWindow(rows, asOfDate),
      metrics: sumLinkedinByAccount(rows, asOfDate, domainToAccount),
    }));

    res.json({ snapshots });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/accounts/:id/contacts?start=YYYY-MM-DD&end=YYYY-MM-DD - contact
// list backing the "# contacts" popup, each flagged active/inactive for the
// given week (active = at least one outbound touchpoint - email or WhatsApp -
// landed on them in that window; website sessions don't count since those
// are prospect-initiated, not something we sent).
accountsRouter.get("/:id/contacts", async (req, res) => {
  try {
    const { id } = req.params;
    const dateClause = dateRangeClause(req.query);

    const [contacts, instanceUrl] = await Promise.all([
      soqlQuery<{ Id: string; Name: string; Title: string; Email: string }>(
        `SELECT Id, Name, Title, Email FROM Contact WHERE AccountId = '${esc(id)}' ORDER BY Name LIMIT 500`
      ),
      getInstanceUrl(),
    ]);

    let activeIds = new Set<string>();
    if (contacts.length > 0 && dateClause) {
      const idList = contacts.map((c) => `'${esc(c.Id)}'`).join(",");
      const subjectOr = TOUCHPOINT_KEYS.map((k) => `Subject LIKE '${TOUCHPOINTS[k].prefix}'`).join(" OR ");
      const activeRows = await soqlQuery<{ WhoId: string }>(
        `SELECT WhoId FROM Task WHERE WhoId IN (${idList}) AND (${subjectOr})${dateClause} GROUP BY WhoId`
      );
      activeIds = new Set(activeRows.map((r) => r.WhoId));
    }

    const total = contacts.length;
    const activeCount = dateClause ? contacts.filter((c) => activeIds.has(c.Id)).length : 0;
    const inactiveCount = dateClause ? total - activeCount : 0;

    res.json({
      summary: dateClause
        ? {
            total,
            active: activeCount,
            inactive: inactiveCount,
            inactivePct: total > 0 ? Math.round((inactiveCount / total) * 1000) / 10 : 0,
          }
        : null,
      contacts: contacts.map((c) => ({
        ...c,
        active: dateClause ? activeIds.has(c.Id) : null,
        sfUrl: `${instanceUrl}/lightning/r/Contact/${c.Id}/view`,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const MDR_OWNER_NAMES_SOQL = Array.from(MDR_OWNER_NAMES)
  .map((n) => `'${n.replace(/'/g, "\\'")}'`)
  .join(",");

async function touchpointEvents(accountId: string, key: TouchpointKey, dateClause: string) {
  const tp = TOUCHPOINTS[key];
  const prefix = tp.prefix;
  // mdr/sales share a Subject prefix - Owner.Name is the only thing that
  // tells them apart, so the detail list needs the same filter the rank
  // scan uses, or an MDR popup would also show every Sales rep's touches.
  const ownerClause =
    tp.source === "mdr"
      ? ` AND Owner.Name IN (${MDR_OWNER_NAMES_SOQL})`
      : tp.source === "sales"
      ? ` AND Owner.Name NOT IN (${MDR_OWNER_NAMES_SOQL})`
      : "";

  const contacts = await soqlQuery<{ Id: string }>(
    `SELECT Id FROM Contact WHERE AccountId = '${esc(accountId)}'`
  );
  const contactIds = contacts.map((c) => c.Id);
  if (contactIds.length === 0) return { events: [] as any[] };

  const instanceUrl = await getInstanceUrl();
  const events: any[] = [];

  for (const batch of chunk(contactIds, 400)) {
    const inList = batch.map((id) => `'${esc(id)}'`).join(",");
    const tasks = await soqlQuery<{
      Id: string;
      Subject: string;
      WhoId: string;
      Who: { Name: string } | null;
      Owner: { Name: string; Email: string } | null;
      ActivityDate: string;
      CreatedDate: string;
      Description: string | null;
    }>(
      `SELECT Id, Subject, WhoId, Who.Name, Owner.Name, Owner.Email, ActivityDate, CreatedDate, Description FROM Task WHERE Subject LIKE '${prefix}' AND WhoId IN (${inList})${ownerClause}${dateClause} ORDER BY CreatedDate DESC LIMIT 500`
    );

    for (const t of tasks) {
      // Marketing automation style: "Email_open - Campaign Name" -> "Campaign Name".
      // MDR/Outreach.io style: "[Outreach] [Email] [Opened] <actual subject>" ->
      // "<actual subject>"; calls have no trailing text so are left as-is.
      const cleaned = t.Subject.replace(/^[A-Za-z]+_[a-z]+\s*-\s*/i, "").replace(
        /^\[Outreach\]\s*(\[[^\]]+\]\s*)+/,
        ""
      );
      events.push({
        taskId: t.Id,
        person: t.Who?.Name || "(unknown contact)",
        contactId: t.WhoId,
        campaign: cleaned || t.Subject,
        date: t.ActivityDate || t.CreatedDate,
        // The Netcore rep who owns this Task - confirmed via Task.OwnerId that
        // this always resolves to a real Netcore sender (not an integration
        // user), verified directly against live data.
        sender: t.Owner?.Name || null,
        senderEmail: t.Owner?.Email || null,
        // Only populated for "sent" and "reply received" events - Outreach.io
        // logs the full email body on those, but "opened"/"clicked" are just
        // tracking pings fired after the fact with no body attached (confirmed
        // against live data: 0% of opened/clicked tasks carry a Description,
        // vs 100% of sent/reply tasks).
        description: t.Description || null,
        sfTaskUrl: `${instanceUrl}/lightning/r/Task/${t.Id}/view`,
        sfContactUrl: `${instanceUrl}/lightning/r/Contact/${t.WhoId}/view`,
      });
    }
  }

  events.sort((a, b) => (a.date < b.date ? 1 : -1));
  return { events };
}

// GET /api/accounts/:id/website-sessions?start=YYYY-MM-DD&end=YYYY-MM-DD
// backs the "# website sessions" column's popup. Pure sheet data - no Salesforce call.
accountsRouter.get("/:id/website-sessions", async (req, res) => {
  try {
    const { start, end } = requireDateRange(req.query);
    const [accounts, sessions] = await Promise.all([getAccountsFromSheet(), getWebsiteSessions()]);
    const account = accounts.find((a) => a.accountId === req.params.id);
    if (!account) return res.status(404).json({ error: "Unknown account id" });

    const domain = normalizeDomain(account.website);

    // Each row IS one session (entry to exit) - never derive a count or
    // total from page_count/user_total_active_time, both of which are
    // lifetime running totals on the account, not per-session values.
    const matched = sessions.filter(
      (s) => s.domain === domain && s.eventDate >= start && s.eventDate <= end
    );

    const events = matched
      .map((s) => ({
        date: s.eventDate,
        receivedAt: s.receivedAt,
        durationSec: s.sessionActiveTimeSec,
        firstPageUrl: s.firstPageUrl,
        latestPageUrl: s.latestPageUrl,
      }))
      .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));

    const totalDurationSec = matched.reduce((sum, s) => sum + s.sessionActiveTimeSec, 0);

    res.json({ sessionCount: matched.length, totalDurationSec, events });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/accounts/:id/touchpoints/:key?start=YYYY-MM-DD&end=YYYY-MM-DD
// backs each "# ..." column's popup (key is one of TOUCHPOINT_KEYS).
accountsRouter.get("/:id/touchpoints/:key", async (req, res) => {
  try {
    const { id, key } = req.params;
    if (!TOUCHPOINT_KEYS.includes(key as TouchpointKey)) {
      return res.status(400).json({ error: `Unknown touchpoint: ${key}` });
    }
    res.json(await touchpointEvents(id, key as TouchpointKey, dateRangeClause(req.query)));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
