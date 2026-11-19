import { Router } from "express";
import {
  getAccountsFromSheet,
  getDomainToAccountId,
  getWebsiteSessions,
  getLinkedinSnapshotRows,
  getFactorsScoreIndex,
  linkedinVersion,
  accountsVersion,
  normalizeDomain,
} from "../googleSheets.js";
import { soqlQuery, getInstanceUrl, chunk, mapWithConcurrency } from "../salesforce.js";
import { createCachedLoader } from "../cache.js";
import { isHighIntentUrl, isMediumIntentUrl } from "../intentPages.js";

export const accountsRouter = Router();

const SF_ID_RE = /^[a-zA-Z0-9]{15,18}$/;

function esc(id: string): string {
  if (!SF_ID_RE.test(id)) {
    throw new Error(`Invalid Salesforce id: ${id}`);
  }
  return id;
}

/**
 * Named individuals on the MDR and SDR teams - confirmed by the user. Every
 * Outreach.io touchpoint (email out/opened/clicked/replied, call answered) is
 * attributed to whichever Salesforce User owns the Task. If that owner is a
 * named MDR, the touch counts as "MDR"; if a named SDR, it counts as "SDR";
 * every other owner (any other rep running an Outreach.io cadence) falls
 * under "Sales". Same subject patterns, same data source - only the owner
 * decides which of the three buckets it lands in.
 */
const MDR_OWNER_NAMES = new Set([
  "Neha Bohra",
  "Shubham Gaumat",
  "Abeer Ansari",
  "Zaid Khan",
  "Vedika Jain",
  "Atharva Jadhav",
]);

const SDR_OWNER_NAMES = new Set([
  "Nitin Kumar Sharma",
  "Vivek Khaire",
  "Meghna Bhowmick",
  "Susmit Bhele",
  "Zeenat Mayet",
  "Mrunal Parkhe",
  "Arete Xavier",
  "Erwin",
  "Abhishek Joshi",
  "Sahil Chaba",
  "Aishwarya Kadam",
  "Pritish Mitra",
  "Trishala Kapira",
  "Jinkal Katira",
  "Nitin Jain",
  "Dhruv Chauhan",
  "Isra Taleb",
  "Vihal Mallah",
  "Pranavv Dasgaonkarr",
  "Ayaan Belim",
  "Shivam Vaidya",
  "Quinton Noronha",
  "Nikhil Vidhate",
  "Kashif Irfan",
  "Manvi Sinha",
  "Sheryll Sharma",
  "Sounak Das",
  "Hardik Ojha",
  "Adarsh Kumbar",
  "Shefali Rani",
  "Sushma Hosamani",
]);

/** One Subject-prefix match rule, optionally also requiring a specific TaskSubtype (needed where the bare prefix alone would collide with an unrelated Task family - see "whatsapp" below). */
interface SubjectPattern {
  subjectPrefix: string;
  taskSubtype?: "Call";
}

/**
 * Every Salesforce Task-based touchpoint the dashboard tracks, grouped into
 * four sources shown as separate sections in the UI:
 *
 *  - "marketing": bulk campaign automation (Subject prefix below), dated by
 *    ActivityDate (the real event day - CreatedDate is just when the sync
 *    landed, which runs ~1 day behind for both email and WhatsApp).
 *  - "mdr" / "sdr" / "sales": Outreach.io (the 1:1 sales engagement tool) PLUS
 *    manually-logged calls (see below), split by Task Owner per
 *    MDR_OWNER_NAMES / SDR_OWNER_NAMES above - any owner in neither list
 *    falls under "sales". Confirmed via direct Salesforce inspection:
 *    Outreach syncs Task Subject lines like "[Outreach] [Email] [Opened]
 *    <actual subject>" and "[Outreach] Call Answered [Outbound]". Email body
 *    is only available for "Out" (sent) and "In" (reply) - "Opened"/
 *    "Clicked" are tracking pings with no body attached. GTM Buddy's separate
 *    "GTM Buddy - Email sent: ..." tasks are a different tool entirely and
 *    are intentionally excluded - they simply don't match any of these
 *    Subject patterns.
 *
 * The mdr/sdr/sales variants of each touchpoint intentionally SHARE the same
 * subject pattern(s) (owner decides which one matches - see computeRanks
 * below).
 *
 * CALLS - two real call-logging systems feed this, confirmed directly
 * against live data (user-reported: a lead's call history wasn't showing up
 * at all):
 *  1. Outreach.io's own dialer, which only syncs a Task when the call
 *     actually connected ("[Outreach] Call Answered [Outbound]") - every
 *     other disposition (No Answer, Voicemail, Busy, etc.) is an attempt,
 *     not engagement, and is intentionally excluded.
 *  2. Zoom Phone calls and personal-WhatsApp calls, which reps log MANUALLY
 *     in Salesforce (no disposition field at all - Outreach's own dialer is
 *     not involved). Subject is exactly "Outbound to <phone number>" for a
 *     Zoom Phone call, or just "WhatsApp" (case varies: WhatsApp/Whatsapp/
 *     whatsapp/WhatsAPP all seen) when the rep called from their personal
 *     WhatsApp number instead. A bare "Call" subject (no number, no
 *     "WhatsApp") is just a duplicate manual confirmation of the same
 *     logged-elsewhere call, not a separate event, and is intentionally
 *     excluded to avoid double counting.
 * Both Zoom Phone and Outreach-answered calls count toward the same "Calls"
 * touchpoint (two different tools recording the same real-world action: a
 * phone call that connected); the WhatsApp calls are tracked as their own
 * separate touchpoint since it's a genuinely different channel from a phone
 * call. The TaskSubtype='Call' guard on "Outbound to"/"whatsapp" is required
 * because "whatsapp" alone would otherwise also match the UNRELATED
 * marketing automation Tasks (Whatsapp_read/replied/clicked, TaskSubtype
 * 'Task') - confirmed live: 50,772 such collisions with no guard, zero with it.
 */
const OUTREACH_CALL_ANSWERED: SubjectPattern = { subjectPrefix: "[Outreach] Call Answered [Outbound]", taskSubtype: "Call" };
const MANUAL_OUTBOUND_CALL: SubjectPattern = { subjectPrefix: "Outbound to", taskSubtype: "Call" };
const MANUAL_WHATSAPP_CALL: SubjectPattern = { subjectPrefix: "whatsapp", taskSubtype: "Call" };

export const TOUCHPOINTS = {
  emailOpens: { patterns: [{ subjectPrefix: "Email_open" }], label: "Email opens", source: "marketing" as const },
  emailClicks: { patterns: [{ subjectPrefix: "Email_click" }], label: "Email clicks", source: "marketing" as const },
  waRead: { patterns: [{ subjectPrefix: "Whatsapp_read" }], label: "WhatsApp read", source: "marketing" as const },
  waReplied: { patterns: [{ subjectPrefix: "Whatsapp_replied" }], label: "WhatsApp replied", source: "marketing" as const },
  waClicked: { patterns: [{ subjectPrefix: "Whatsapp_clicked" }], label: "WhatsApp clicked", source: "marketing" as const },

  mdrEmailOut: { patterns: [{ subjectPrefix: "[Outreach] [Email] [Out]" }], label: "MDR email out", source: "mdr" as const },
  mdrEmailOpened: { patterns: [{ subjectPrefix: "[Outreach] [Email] [Opened]" }], label: "MDR email opened", source: "mdr" as const },
  mdrEmailClicked: { patterns: [{ subjectPrefix: "[Outreach] [Email] [Clicked]" }], label: "MDR email clicked", source: "mdr" as const },
  mdrEmailReplied: { patterns: [{ subjectPrefix: "[Outreach] [Email] [In]" }], label: "MDR email replied", source: "mdr" as const },
  mdrCalls: { patterns: [OUTREACH_CALL_ANSWERED, MANUAL_OUTBOUND_CALL], label: "MDR calls", source: "mdr" as const },
  mdrWaCalls: { patterns: [MANUAL_WHATSAPP_CALL], label: "MDR WhatsApp calls", source: "mdr" as const },

  sdrEmailOut: { patterns: [{ subjectPrefix: "[Outreach] [Email] [Out]" }], label: "SDR email out", source: "sdr" as const },
  sdrEmailOpened: { patterns: [{ subjectPrefix: "[Outreach] [Email] [Opened]" }], label: "SDR email opened", source: "sdr" as const },
  sdrEmailClicked: { patterns: [{ subjectPrefix: "[Outreach] [Email] [Clicked]" }], label: "SDR email clicked", source: "sdr" as const },
  sdrEmailReplied: { patterns: [{ subjectPrefix: "[Outreach] [Email] [In]" }], label: "SDR email replied", source: "sdr" as const },
  sdrCalls: { patterns: [OUTREACH_CALL_ANSWERED, MANUAL_OUTBOUND_CALL], label: "SDR calls", source: "sdr" as const },
  sdrWaCalls: { patterns: [MANUAL_WHATSAPP_CALL], label: "SDR WhatsApp calls", source: "sdr" as const },

  salesEmailOut: { patterns: [{ subjectPrefix: "[Outreach] [Email] [Out]" }], label: "Sales email out", source: "sales" as const },
  salesEmailOpened: { patterns: [{ subjectPrefix: "[Outreach] [Email] [Opened]" }], label: "Sales email opened", source: "sales" as const },
  salesEmailClicked: { patterns: [{ subjectPrefix: "[Outreach] [Email] [Clicked]" }], label: "Sales email clicked", source: "sales" as const },
  salesEmailReplied: { patterns: [{ subjectPrefix: "[Outreach] [Email] [In]" }], label: "Sales email replied", source: "sales" as const },
  salesCalls: { patterns: [OUTREACH_CALL_ANSWERED, MANUAL_OUTBOUND_CALL], label: "Sales calls", source: "sales" as const },
  salesWaCalls: { patterns: [MANUAL_WHATSAPP_CALL], label: "Sales WhatsApp calls", source: "sales" as const },
} as const;

export type TouchpointKey = keyof typeof TOUCHPOINTS;
const TOUCHPOINT_KEYS = Object.keys(TOUCHPOINTS) as TouchpointKey[];

/** Builds a single parenthesized SOQL OR-term for one pattern, bundling its TaskSubtype guard (if any) into the same term. */
function patternClause(p: SubjectPattern): string {
  const subjectCond = `Subject LIKE '${p.subjectPrefix}%'`;
  return p.taskSubtype ? `(${subjectCond} AND TaskSubtype = '${p.taskSubtype}')` : subjectCond;
}

function patternMatches(subject: string, taskSubtype: string | null, p: SubjectPattern): boolean {
  return subject.startsWith(p.subjectPrefix) && (!p.taskSubtype || taskSubtype === p.taskSubtype);
}

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

    // Served from the cached Contact map whenever it has loaded (normally
    // always, after startup prewarm) - no Salesforce round trip per page.
    const contactMap = contactMapLoader.peek();
    if (contactMap) {
      const counts: Record<string, number> = {};
      for (const id of ids) counts[id] = contactMap.countByAccount.get(id) ?? 0;
      return res.json({ counts });
    }
    contactMapLoader.get().catch((err) => console.error("[contact-counts] contact map load failed:", err));

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

export type RankEntry = Record<TouchpointKey, number> & {
  websiteSessions: number;
  highIntentSessions: number;
  mediumIntentSessions: number;
};

function emptyRankEntry(): RankEntry {
  const e = { websiteSessions: 0, highIntentSessions: 0, mediumIntentSessions: 0 } as RankEntry;
  for (const k of TOUCHPOINT_KEYS) e[k] = 0;
  return e;
}

// The Contact -> Account map never depends on the selected date range, so it
// is cached independently of any one week. Also carries the contact count per
// account, which is what the "# contacts" column shows - serving that from
// here avoids a separate Salesforce query on every page of the table.
interface ContactMap {
  contactToAccount: Map<string, string>;
  countByAccount: Map<string, number>;
}

const contactMapLoader = createCachedLoader("contact-map", loadContactMap, {
  ttlMs: 10 * 60 * 1000,
  maxStaleMs: 2 * 60 * 60 * 1000,
});

async function loadContactMap(): Promise<ContactMap> {
  const accounts = await getAccountsFromSheet();
  const accountIds = accounts.map((a) => a.accountId);

  const contactToAccount = new Map<string, string>();
  const countByAccount = new Map<string, number>();
  const contactChunks = await mapWithConcurrency(chunk(accountIds, 300), 8, async (idBatch) => {
    const inList = idBatch.map((id) => `'${esc(id)}'`).join(",");
    return soqlQuery<{ Id: string; AccountId: string }>(
      `SELECT Id, AccountId FROM Contact WHERE AccountId IN (${inList})`
    );
  });
  for (const rows of contactChunks) {
    for (const c of rows) {
      contactToAccount.set(c.Id, c.AccountId);
      countByAccount.set(c.AccountId, (countByAccount.get(c.AccountId) ?? 0) + 1);
    }
  }
  return { contactToAccount, countByAccount };
}

/**
 * A real, confirmed gap: a meaningful slice of MDR/SDR/Sales activity
 * (Outreach.io calls and emails) gets logged against Salesforce LEADS, not
 * Contacts - e.g. a webinar/event attendee who hasn't been converted to a
 * Contact yet, but is still being worked by MDR/SDR. Those Tasks' WhoId
 * points at a Lead (00Q... prefix), which the Contact-only map above can
 * never resolve, so every one of those touches was silently dropped from
 * the Score and every touchpoint column - confirmed directly against live
 * data (lead 00Qfw00000UMRQ5EAP: 22 calls + 17 emails, zero attribution).
 *
 * Leads don't have a standard Account lookup pre-conversion, but this org's
 * Lead object carries two custom fields that already hold the target
 * Account's Id: Company_Account_ID__c (populated on ~53% of all leads) and
 * Account__c (an actual Account reference, ~15% populated). Confirmed via a
 * live sample that whenever both are populated on the same Lead they always
 * agree - so Company_Account_ID__c is used first for its much wider
 * coverage, falling back to Account__c only when the former is blank.
 */
const leadMapLoader = createCachedLoader("lead-map", loadLeadMap, {
  ttlMs: 10 * 60 * 1000,
  maxStaleMs: 2 * 60 * 60 * 1000,
});

async function loadLeadMap(): Promise<Map<string, string>> {
  const accounts = await getAccountsFromSheet();
  const accountIdSet = new Set(accounts.map((a) => a.accountId));
  const accountIds = accounts.map((a) => a.accountId);

  const leadToAccount = new Map<string, string>();
  const leadChunks = await mapWithConcurrency(chunk(accountIds, 150), 8, async (idBatch) => {
    const inList = idBatch.map((id) => `'${esc(id)}'`).join(",");
    return soqlQuery<{ Id: string; Company_Account_ID__c: string | null; Account__c: string | null }>(
      `SELECT Id, Company_Account_ID__c, Account__c FROM Lead WHERE Company_Account_ID__c IN (${inList}) OR Account__c IN (${inList})`
    );
  });
  for (const rows of leadChunks) {
    for (const l of rows) {
      const accId =
        l.Company_Account_ID__c && accountIdSet.has(l.Company_Account_ID__c)
          ? l.Company_Account_ID__c
          : l.Account__c && accountIdSet.has(l.Account__c)
          ? l.Account__c
          : null;
      if (accId) leadToAccount.set(l.Id, accId);
    }
  }
  return leadToAccount;
}

/**
 * Every Task's WhoId is either a Contact or a Lead - this merges both maps
 * into one lookup so callers don't need to care which, plus the reverse
 * (account -> every Contact/Lead Id) for the per-account popups. Rebuilt only
 * when one of the two underlying maps actually reloads, not on every call.
 */
interface WhoIndex {
  whoToAccount: Map<string, string>;
  whoIdsByAccount: Map<string, string[]>;
}
let whoIndexCache: { contactVer: number; leadVer: number; index: WhoIndex } | null = null;

function buildWhoIndex(contacts: ContactMap, leads: Map<string, string>): WhoIndex {
  const contactVer = contactMapLoader.version();
  const leadVer = leadMapLoader.version();
  if (whoIndexCache && whoIndexCache.contactVer === contactVer && whoIndexCache.leadVer === leadVer) {
    return whoIndexCache.index;
  }
  const whoToAccount = new Map(contacts.contactToAccount);
  for (const [whoId, accId] of leads) whoToAccount.set(whoId, accId);
  const whoIdsByAccount = new Map<string, string[]>();
  for (const [whoId, accId] of whoToAccount) {
    let list = whoIdsByAccount.get(accId);
    if (!list) whoIdsByAccount.set(accId, (list = []));
    list.push(whoId);
  }
  const index = { whoToAccount, whoIdsByAccount };
  whoIndexCache = { contactVer, leadVer, index };
  return index;
}

async function getWhoIndex(): Promise<WhoIndex> {
  const [contacts, leads] = await Promise.all([contactMapLoader.get(), leadMapLoader.get()]);
  return buildWhoIndex(contacts, leads);
}

/** The index only if both maps have already loaded at least once - never waits on Salesforce. */
function peekWhoIndex(): WhoIndex | undefined {
  const contacts = contactMapLoader.peek();
  const leads = leadMapLoader.peek();
  return contacts && leads ? buildWhoIndex(contacts, leads) : undefined;
}

/**
 * Task owner -> mdr/sdr bucket, keyed by User Id. The rank scan used to pull
 * Owner.Name on every Task (a relationship join adding a nested object to
 * every one of tens of thousands of rows) just to compare it against the
 * named lists above; resolving the handful of named Users once gives the
 * exact same split. Anyone not in either list is "sales", as before.
 */
const ownerSourceLoader = createCachedLoader(
  "owner-sources",
  async () => {
    const users = await soqlQuery<{ Id: string; Name: string }>(
      `SELECT Id, Name FROM User WHERE Name IN (${ALL_MDR_SDR_NAMES_SOQL})`
    );
    const byId = new Map<string, "mdr" | "sdr">();
    for (const u of users) {
      if (MDR_OWNER_NAMES.has(u.Name)) byId.set(u.Id, "mdr");
      else if (SDR_OWNER_NAMES.has(u.Name)) byId.set(u.Id, "sdr");
    }
    return byId;
  },
  { ttlMs: 6 * 60 * 60 * 1000, maxStaleMs: 24 * 60 * 60 * 1000 }
);

// Flattened (key, pattern) pairs - a key like mdrCalls contributes one entry
// per pattern it accepts (Outreach-answered AND manually-logged outbound
// both count toward it), so a task can appear once per pattern it matches.
const TOUCHPOINT_PATTERNS = TOUCHPOINT_KEYS.flatMap((key) =>
  TOUCHPOINTS[key].patterns.map((p) => ({ key, ...p, source: TOUCHPOINTS[key].source }))
);

/**
 * Touchpoint counts are plain counts, so a date range's totals are exactly
 * the sum of its individual days' totals. Ranks are therefore computed and
 * cached PER DAY, and any week/month/multi-week selection is assembled by
 * summing cached days:
 *  - Switching Week 1 -> Week 2 -> whole month -> Week 1 only ever fetches
 *    days that haven't been seen yet; a month already viewed week by week
 *    costs zero Salesforce calls.
 *  - Days that do need fetching run as independent queries in parallel,
 *    instead of one big query whose results come back as a strictly
 *    sequential chain of 2,000-row pages (a full month was ~30-50 back-to-back
 *    round trips, which is what made month views take 20s+, and worse from
 *    Render than from a laptop since every round trip pays the network
 *    latency again).
 *  - Past days barely change, so they're kept for hours; recent days (where
 *    email/WhatsApp syncs land ~1 day late and reps log calls after the
 *    fact) refresh every few minutes.
 * Only the sparse non-zero counts are stored: on a typical day well under a
 * third of the 5,555 accounts have any activity at all.
 */
type DayCounts = Map<string, Partial<Record<TouchpointKey, number>>>;

const RANK_SUBJECT_OR = Array.from(new Set(TOUCHPOINT_PATTERNS.map((p) => patternClause(p)))).join(" OR ");
const RECENT_DAY_WINDOW = 3;
const DAY_CACHE_MAX_ENTRIES = 400;
const MAX_RANGE_DAYS = 400;

const dayCache = new Map<string, { loadedAt: number; counts: DayCounts }>();
const dayInFlight = new Map<string, Promise<DayCounts>>();
const sfDaySlots = createSemaphore(6);

function createSemaphore(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

function addDays(isoDate: string, n: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysInRange(start: string, end: string): string[] {
  const days: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    days.push(d);
    if (days.length > MAX_RANGE_DAYS) throw new Error(`Date range too large (max ${MAX_RANGE_DAYS} days)`);
  }
  return days;
}

function dayPolicy(day: string): { ttlMs: number; maxStaleMs: number } {
  const recent = day >= addDays(todayIsoIST(), -RECENT_DAY_WINDOW);
  return recent
    ? { ttlMs: 10 * 60 * 1000, maxStaleMs: 60 * 60 * 1000 }
    : { ttlMs: 6 * 60 * 60 * 1000, maxStaleMs: 24 * 60 * 60 * 1000 };
}

async function loadDayCounts(day: string): Promise<DayCounts> {
  const [whoIndex, ownerSources] = await Promise.all([getWhoIndex(), ownerSourceLoader.get()]);

  // One query for the whole org for this one day. Rows for contacts/leads
  // outside our 5,555 TAL accounts are discarded via the WhoId lookup. WhoId
  // resolves against EITHER a Contact or a Lead (see getWhoIndex) - a real,
  // confirmed gap was that Lead-owned touches were silently dropped entirely
  // when only Contacts were checked. OwnerId splits Outreach.io touches into
  // MDR vs SDR vs Sales (see TOUCHPOINTS doc comment).
  const tasks = await sfDaySlots(() =>
    soqlQuery<{ WhoId: string | null; Subject: string; TaskSubtype: string | null; OwnerId: string }>(
      `SELECT WhoId, Subject, TaskSubtype, OwnerId FROM Task WHERE (${RANK_SUBJECT_OR}) AND ActivityDate = ${day}`
    )
  );

  const counts: DayCounts = new Map();
  for (const t of tasks) {
    const accId = t.WhoId ? whoIndex.whoToAccount.get(t.WhoId) : undefined;
    if (!accId) continue;

    const matches = TOUCHPOINT_PATTERNS.filter((p) => patternMatches(t.Subject, t.TaskSubtype, p));
    if (matches.length === 0) continue;

    let key: TouchpointKey | undefined;
    if (matches.length === 1) {
      // Marketing automation - prefix alone identifies the touchpoint.
      key = matches[0].key;
    } else {
      // Outreach.io mdr/sdr/sales trio sharing a prefix - the Task's owner
      // decides which bucket this touch belongs in.
      const source = ownerSources.get(t.OwnerId) ?? "sales";
      key = matches.find((m) => m.source === source)?.key;
    }
    if (!key) continue;

    let entry = counts.get(accId);
    if (!entry) counts.set(accId, (entry = {}));
    entry[key] = (entry[key] ?? 0) + 1;
  }
  return counts;
}

function refreshDay(day: string): Promise<DayCounts> {
  const existing = dayInFlight.get(day);
  if (existing) return existing;
  const p = loadDayCounts(day)
    .then((counts) => {
      dayCache.set(day, { loadedAt: Date.now(), counts });
      if (dayCache.size > DAY_CACHE_MAX_ENTRIES) {
        let oldestDay: string | null = null;
        let oldestAt = Infinity;
        for (const [d, v] of dayCache) {
          if (v.loadedAt < oldestAt) {
            oldestAt = v.loadedAt;
            oldestDay = d;
          }
        }
        if (oldestDay) dayCache.delete(oldestDay);
      }
      return counts;
    })
    .finally(() => dayInFlight.delete(day));
  dayInFlight.set(day, p);
  return p;
}

/** Stale-while-revalidate per day: fresh -> cached; stale within limit -> cached + background refresh; otherwise wait. */
function getDayCounts(day: string): { counts: Promise<DayCounts>; blocked: boolean } {
  const entry = dayCache.get(day);
  if (entry) {
    const age = Date.now() - entry.loadedAt;
    const { ttlMs, maxStaleMs } = dayPolicy(day);
    if (age < ttlMs) return { counts: Promise.resolve(entry.counts), blocked: false };
    if (age < maxStaleMs) {
      refreshDay(day).catch((err) => console.error(`[rank] background refresh failed for ${day}:`, err));
      return { counts: Promise.resolve(entry.counts), blocked: false };
    }
  }
  return { counts: refreshDay(day), blocked: true };
}

type SparseRanks = Record<string, Partial<RankEntry>>;

async function computeRanks(start: string, end: string): Promise<{ ranks: SparseRanks; cached: boolean }> {
  const days = daysInRange(start, end);
  const lookups = days.map(getDayCounts);
  const [dayCounts, accounts, sessions, domainToAccount] = await Promise.all([
    Promise.all(lookups.map((l) => l.counts)),
    getAccountsFromSheet(),
    getWebsiteSessions(),
    getDomainToAccountId(),
  ]);

  const tal = new Set(accounts.map((a) => a.accountId));
  const ranks: SparseRanks = {};
  const entryFor = (accId: string) => (ranks[accId] ??= {});

  for (const counts of dayCounts) {
    for (const [accId, perKey] of counts) {
      if (!tal.has(accId)) continue;
      const entry = entryFor(accId);
      for (const k in perKey) {
        const key = k as TouchpointKey;
        entry[key] = (entry[key] ?? 0) + (perKey[key] ?? 0);
      }
    }
  }

  // Website sessions come from the real-time Google Sheet feed, not Salesforce -
  // cheap, so just filter the (already cached) sheet rows by date in memory.
  for (const s of sessions) {
    if (s.eventDate < start || s.eventDate > end) continue;
    const accId = domainToAccount.get(s.domain);
    if (!accId || !tal.has(accId)) continue;
    const entry = entryFor(accId);
    entry.websiteSessions = (entry.websiteSessions ?? 0) + 1;
    // High takes precedence over Medium when a session's entry/exit pages
    // happen to match both tiers - mirrors the fire-over-sun display rule.
    if (isHighIntentUrl(s.firstPageUrl) || isHighIntentUrl(s.latestPageUrl)) {
      entry.highIntentSessions = (entry.highIntentSessions ?? 0) + 1;
    } else if (isMediumIntentUrl(s.firstPageUrl) || isMediumIntentUrl(s.latestPageUrl)) {
      entry.mediumIntentSessions = (entry.mediumIntentSessions ?? 0) + 1;
    }
  }

  return { ranks, cached: !lookups.some((l) => l.blocked) };
}

/** Full (every account, every key, zeros included) shape - what clients that don't ask for sparse expect. */
async function expandRanks(sparse: SparseRanks): Promise<Record<string, RankEntry>> {
  const accounts = await getAccountsFromSheet();
  const full: Record<string, RankEntry> = {};
  for (const a of accounts) full[a.accountId] = { ...emptyRankEntry(), ...sparse[a.accountId] };
  return full;
}

// The 1-3 ranges people most recently looked at, plus the current week -
// their days are refreshed shortly before they'd go stale, so the dashboard
// opens (and flips between recent weeks) instantly instead of waiting on
// Salesforce.
const recentRanges: { start: string; end: string }[] = [];

function touchRecentRange(start: string, end: string) {
  const i = recentRanges.findIndex((r) => r.start === start && r.end === end);
  if (i >= 0) recentRanges.splice(i, 1);
  recentRanges.unshift({ start, end });
  recentRanges.length = Math.min(recentRanges.length, 3);
}

function currentWeekRangeIST(): { start: string; end: string } {
  const today = todayIsoIST();
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const start = addDays(today, -((dow + 6) % 7)); // back to Monday
  return { start, end: addDays(start, 6) };
}

/** Kicks off (without waiting) loading of whatever is due - used on startup and on a timer. */
function prewarmRanks() {
  const days = new Set<string>();
  for (const r of [currentWeekRangeIST(), ...recentRanges]) {
    for (const d of daysInRange(r.start, r.end)) days.add(d);
  }
  for (const day of days) {
    const entry = dayCache.get(day);
    if (!entry || Date.now() - entry.loadedAt >= dayPolicy(day).ttlMs - 60_000) {
      // Fire-and-forget MUST be caught - an unhandled rejection from a
      // transient Salesforce timeout would otherwise crash the process.
      refreshDay(day).catch((err) => console.error(`[rank] prewarm failed for ${day}:`, err));
    }
  }
}

setInterval(prewarmRanks, 60 * 1000).unref();

/** Loads everything the dashboard's first screen needs, without waiting on it. Called once at server start. */
export function prewarmCaches() {
  const warm = (name: string, p: Promise<unknown>) =>
    p.catch((err) => console.error(`[prewarm] ${name} failed:`, err));
  warm("accounts", getAccountsFromSheet());
  warm("website sessions", getWebsiteSessions());
  warm("linkedin", getLinkedinSnapshotRows());
  warm("factors history", getFactorsScoreIndex());
  warm("live factors", liveFactorsLoader.get());
  // Rank days need the Contact/Lead maps and owner buckets first; loading
  // those here means the day queries below all share the same in-flight load.
  warm(
    "rank inputs",
    Promise.all([getWhoIndex(), ownerSourceLoader.get()]).then(() => prewarmRanks())
  );
}

// GET /api/accounts/rank?start=YYYY-MM-DD&end=YYYY-MM-DD[&sparse=1] - every
// touchpoint count for EVERY account in the given date range, used to sort
// the table. sparse=1 returns only accounts/keys with a non-zero count (the
// client fills in zeros) - ~2.6MB down to ~90KB for a typical week, since
// most accounts have no activity in any given week. Without it, the full
// zero-filled shape is returned, so an older client still works.
accountsRouter.get("/rank", async (req, res) => {
  try {
    const { start, end } = requireDateRange(req.query);
    touchRecentRange(start, end);
    const { ranks, cached } = await computeRanks(start, end);
    if (req.query.sparse === "1") {
      res.json({ ranks, cached, sparse: true });
    } else {
      res.json({ ranks: await expandRanks(ranks), cached });
    }
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
// Pure function of the LinkedIn tab + the roster, so it's built once per
// reload of either rather than re-scanning every row per snapshot date on
// every request.
let linkedinSnapshotsCache: { liVer: number; accVer: number; body: unknown } | null = null;

accountsRouter.get("/linkedin-snapshots", async (req, res) => {
  try {
    const [rows, domainToAccount] = await Promise.all([
      getLinkedinSnapshotRows(),
      getDomainToAccountId(),
    ]);
    const liVer = linkedinVersion();
    const accVer = accountsVersion();
    if (linkedinSnapshotsCache && linkedinSnapshotsCache.liVer === liVer && linkedinSnapshotsCache.accVer === accVer) {
      return res.json(linkedinSnapshotsCache.body);
    }

    const dates = Array.from(new Set(rows.map((r) => r.snapshotDate).filter(Boolean))).sort();
    const snapshots = dates.map((asOfDate, i) => ({
      index: i + 1,
      windowStart: minus6Days(asOfDate),
      asOfDate,
      receivedDate: receivedDateForWindow(rows, asOfDate),
      metrics: sumLinkedinByAccount(rows, asOfDate, domainToAccount),
    }));

    const body = { snapshots };
    linkedinSnapshotsCache = { liVer, accVer, body };
    res.json(body);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * "Today" in IST, not UTC. This matters here specifically because the whole
 * Factors.ai automation this feature depends on is designed around IST (the
 * daily sync runs at 11:55 PM IST) - using UTC's calendar date would make
 * the dashboard think it's still "yesterday" for the ~5.5 hours every
 * evening where IST has already rolled into a new day but UTC hasn't
 * (confirmed live: at 01:47 AM IST on Nov 2, UTC still read Nov 1 20:17,
 * which silently served Nov 1's stale sheet data instead of going live).
 */
function todayIsoIST(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

interface FactorsSnapshot {
  level: string;
  score: number | null;
}

/** One parsed "Top Engagement Signals" entry, e.g. "Linkedin Paid Impressions 83" -> { label: "Linkedin Paid Impressions", count: 83 }. */
interface TopSignal {
  label: string;
  count: number | null;
}

/**
 * Factors.ai's Top_Engagement_Signals__c is a single comma-separated text
 * field (confirmed live: "Linkedin Paid Impressions 83 , Form Submitted v2
 * 2") - split into individual labeled signals so the spike banner can show
 * each one as its own line, with an explicit note that these specific
 * signals (LinkedIn ad impressions, website form submissions) are NOT
 * currently captured anywhere else in this dashboard - confirmed by
 * investigation that our own LinkedIn/Website Sessions data sources don't
 * carry this information at all, or are far behind Factors' own internal
 * tracking.
 */
function parseTopEngagementSignals(raw: string): TopSignal[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((segment) => {
      const m = segment.match(/^(.*?)\s+(\d+)$/);
      return m ? { label: m[1].trim(), count: Number(m[2]) } : { label: segment, count: null };
    });
}

// Live current Engagement_Level__c / Factors_Engagement_Score__c for every
// TAL account, straight from Salesforce - used ONLY for "today" in the
// Factor Score column (resolveFactorsScores) and the history drill-down,
// since the daily sheet snapshot for today doesn't exist until tonight's
// automation run. NOT used by the spike banner (computeFactorSpikes) - see
// its comment for why a live read doesn't make sense there. Cached briefly
// so repeated page views in the same few minutes don't re-scan all 5,555
// accounts on every request.
const liveFactorsLoader = createCachedLoader("live-factors", loadLiveFactorsSnapshot, {
  ttlMs: 5 * 60 * 1000,
  maxStaleMs: 30 * 60 * 1000,
});

function getLiveFactorsSnapshot(): Promise<Record<string, FactorsSnapshot>> {
  return liveFactorsLoader.get();
}

async function loadLiveFactorsSnapshot(): Promise<Record<string, FactorsSnapshot>> {
  const accounts = await getAccountsFromSheet();
  const byAccount: Record<string, FactorsSnapshot> = {};

  await mapWithConcurrency(chunk(accounts.map((a) => a.accountId), 300), 8, async (idBatch) => {
    const idList = idBatch.map((id) => `'${esc(id)}'`).join(",");
    const rows = await soqlQuery<{ Id: string; Engagement_Level__c: string | null; Factors_Engagement_Score__c: number | null }>(
      `SELECT Id, Engagement_Level__c, Factors_Engagement_Score__c FROM Account WHERE Id IN (${idList})`
    );
    for (const r of rows) {
      byAccount[r.Id] = { level: r.Engagement_Level__c || "", score: r.Factors_Engagement_Score__c ?? null };
    }
  });

  return byAccount;
}

/** Latest date in an ascending list that is <= `limit`, by binary search. */
function latestDateOnOrBefore(sortedDates: string[], limit: string): string | null {
  let lo = 0;
  let hi = sortedDates.length - 1;
  let found: string | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedDates[mid] <= limit) {
      found = sortedDates[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Resolves the Factor Score every account should show for the given period:
 *  - If the period has already fully elapsed (end < today), it's permanent
 *    history - use whatever the daily sheet snapshot said as of that date,
 *    and it will never change again, no matter how much later this is viewed.
 *  - If the period includes today (end >= today, i.e. the current week),
 *    show today's value - from the sheet if tonight's run has already
 *    happened, otherwise LIVE from Salesforce, since the sheet simply has
 *    nothing for today yet.
 * This mirrors the "never retroactively rewrite a past week" rule already
 * used for LinkedIn, just with a live fallback for the one day that hasn't
 * been captured into history yet.
 */
async function resolveFactorsScores(
  start: string,
  end: string
): Promise<{ asOfDate: string; isLive: boolean; byAccount: Record<string, FactorsSnapshot> }> {
  const today = todayIsoIST();
  const effectiveEnd = end < today ? end : today;

  const index = await getFactorsScoreIndex();
  const latestSheetDate = latestDateOnOrBefore(index.dates, effectiveEnd);

  if (effectiveEnd === today && latestSheetDate !== today) {
    // Today hasn't been captured into history yet - go live.
    const byAccount = await getLiveFactorsSnapshot();
    return { asOfDate: today, isLive: true, byAccount };
  }

  if (!latestSheetDate) {
    // No history exists at all as of this period (e.g. a week entirely
    // before this system went live) - nothing to show, not an error.
    return { asOfDate: effectiveEnd, isLive: false, byAccount: {} };
  }

  const byAccount: Record<string, FactorsSnapshot> = {};
  for (const r of index.byDate.get(latestSheetDate) ?? []) {
    byAccount[r.accountId] = { level: r.engagementLevel, score: r.engagementScore };
  }
  return { asOfDate: latestSheetDate, isLive: false, byAccount };
}

// GET /api/accounts/factors-score?start=&end= - the Factor Score column for
// every account, resolved per the rule above. Independent of the
// Salesforce-Task rank scan (/rank) - different data source, different cache.
accountsRouter.get("/factors-score", async (req, res) => {
  try {
    const { start, end } = requireDateRange(req.query);
    const resolved = await resolveFactorsScores(start, end);
    res.json(resolved);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Hot=4 down to unscored=0 - only an UPWARD move between these counts as a "spike." */
const LEVEL_RANK: Record<string, number> = { "": 0, Ice: 1, Cool: 2, Warm: 3, Hot: 4 };

interface SpikeAccount {
  accountId: string;
  accountName: string;
  fromLevel: string;
  fromScore: number | null;
  toLevel: string;
  toScore: number | null;
  signals: TopSignal[];
  /** First day within the requested range the account's level reached `toLevel`'s rank - used to float the newest crossings to the top. */
  crossedDate: string | null;
}

/**
 * The "who just spiked" comparison behind the dashboard's spike banner, now
 * scoped to a WEEK (matching the same Week 1/2/3... boundaries the rest of
 * the dashboard uses), not a single day: finds every account whose
 * Engagement Level jumped UP at any point during the given week, relative to
 * wherever it stood right before the week started (never assumes "the day
 * before" specifically, since the sheet can have gaps) - split into "newly
 * Hot" (crossed into Hot from anything else) and "newly Warm" (crossed into
 * Warm from Cool/Ice/unscored). An account dropping a level, or moving
 * between two non-adjacent-in-rank-but-equal levels, is not a spike.
 *
 * Deliberately NEVER goes live against Salesforce, unlike the Factor Score
 * column - a spike is a batch day-over-day comparison, so a mid-day live
 * read would show a false, premature "no change yet" (or a partial change
 * that could still flip by end of day) and get mistaken for that day's real
 * outcome. For the CURRENT, still-running week, `date` resolves to whatever
 * the most recently synced day WITHIN that week is - so the result updates
 * on its own, day by day, as each night's sync lands, without any separate
 * live step. A fully elapsed past week's result is permanent and never
 * changes again, same as everywhere else in this dashboard.
 */
async function computeFactorSpikes(
  start: string,
  end: string
): Promise<{
  date: string | null;
  previousDate: string | null;
  availableDates: string[];
  newlyHot: SpikeAccount[];
  newlyWarm: SpikeAccount[];
}> {
  const [index, accounts] = await Promise.all([getFactorsScoreIndex(), getAccountsFromSheet()]);
  const nameById = new Map(accounts.map((a) => [a.accountId, a.accountName]));
  const rowsOn = (d: string) => index.byDate.get(d) ?? [];

  const today = todayIsoIST();
  const effectiveEnd = end < today ? end : today;

  const sheetDates = index.dates;
  const inRangeDates = sheetDates.filter((d) => d >= start && d <= effectiveEnd);
  const date = inRangeDates.at(-1) ?? null; // most recent day actually synced within this week so far

  if (!date) {
    // No day within this week has been captured yet - nothing to compare, not an error.
    return { date: null, previousDate: null, availableDates: [], newlyHot: [], newlyWarm: [] };
  }

  // The snapshot right before this week began - the "from" baseline every
  // spike in this week is measured against, no matter which day within the
  // week an account actually crossed over on.
  const previousDate = sheetDates.filter((d) => d < start).at(-1) ?? null;

  const toByAccount: Record<string, { level: string; score: number | null; signals: string }> = {};
  for (const r of rowsOn(date)) {
    toByAccount[r.accountId] = { level: r.engagementLevel, score: r.engagementScore, signals: r.topEngagementSignals };
  }

  const fromByAccount: Record<string, { level: string; score: number | null }> = {};
  if (previousDate) {
    for (const r of rowsOn(previousDate)) {
      fromByAccount[r.accountId] = { level: r.engagementLevel, score: r.engagementScore };
    }
  }

  // Per-day level, per account, for every day in this week synced so far -
  // used to find the exact day an account's level first reached its new
  // rank, so the newest crossings can float to the top instead of being
  // buried under whichever account happens to score higher.
  const levelByDateThenAccount: Record<string, Record<string, string>> = {};
  for (const d of inRangeDates) {
    const levels: Record<string, string> = {};
    for (const r of rowsOn(d)) levels[r.accountId] = r.engagementLevel;
    levelByDateThenAccount[d] = levels;
  }

  function crossedDateFor(accountId: string, toRank: number): string | null {
    for (const d of inRangeDates) {
      const level = levelByDateThenAccount[d][accountId];
      if (level !== undefined && (LEVEL_RANK[level] ?? 0) >= toRank) return d;
    }
    return date;
  }

  const newlyHot: SpikeAccount[] = [];
  const newlyWarm: SpikeAccount[] = [];

  for (const [accountId, to] of Object.entries(toByAccount)) {
    const from = fromByAccount[accountId] ?? { level: "", score: null };
    const fromRank = LEVEL_RANK[from.level] ?? 0;
    const toRank = LEVEL_RANK[to.level] ?? 0;
    if (toRank <= fromRank) continue; // only upward jumps are a "spike"

    const entry: SpikeAccount = {
      accountId,
      accountName: nameById.get(accountId) || "",
      fromLevel: from.level || "Not scored",
      fromScore: from.score,
      toLevel: to.level,
      toScore: to.score,
      signals: parseTopEngagementSignals(to.signals),
      crossedDate: crossedDateFor(accountId, toRank),
    };

    if (to.level === "Hot") newlyHot.push(entry);
    else if (to.level === "Warm") newlyWarm.push(entry);
  }

  // Newest crossing first (so freshly-synced spikes surface at the top),
  // then by score as a tiebreaker within the same day.
  const byRecencyThenScore = (a: SpikeAccount, b: SpikeAccount) => {
    const dateCompare = (b.crossedDate ?? "").localeCompare(a.crossedDate ?? "");
    if (dateCompare !== 0) return dateCompare;
    return (b.toScore ?? 0) - (a.toScore ?? 0);
  };
  newlyHot.sort(byRecencyThenScore);
  newlyWarm.sort(byRecencyThenScore);

  return { date, previousDate, availableDates: inRangeDates, newlyHot, newlyWarm };
}

// GET /api/accounts/factor-spikes?start=YYYY-MM-DD&end=YYYY-MM-DD - the spike
// banner's data for one week (same Week 1/2/3... boundaries as the rest of
// the dashboard): every account that crossed into Hot or Warm at any point
// during that week, compared against wherever it stood right before the week
// began. For the current, still-running week this naturally fills in more as
// each night's sync lands (see the comment on computeFactorSpikes for why).
accountsRouter.get("/factor-spikes", async (req, res) => {
  try {
    const { start, end } = requireDateRange(req.query);
    res.json(await computeFactorSpikes(start, end));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/accounts/:id/factors-history - full day-by-day Engagement Level
// history for one account, every snapshot ever captured (not scoped to the
// selected week) - the drill-down that actually answers "when and how did
// this change," which a single collapsed per-week value can't show on its
// own. Includes today live, appended on top of the sheet history, if
// tonight's run hasn't happened yet.
accountsRouter.get("/:id/factors-history", async (req, res) => {
  try {
    const { id } = req.params;
    const index = await getFactorsScoreIndex();
    const history = (index.byAccount.get(id) ?? [])
      .map((r) => ({ date: r.runDate, level: r.engagementLevel, score: r.engagementScore, isLive: false }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    const today = todayIsoIST();
    const hasToday = history.some((h) => h.date === today);
    if (!hasToday) {
      const live = await getLiveFactorsSnapshot();
      const snapshot = live[id];
      if (snapshot) {
        history.push({ date: today, level: snapshot.level, score: snapshot.score, isLive: true });
      }
    }

    res.json({ history });
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
      const subjectOr = Array.from(new Set(TOUCHPOINT_PATTERNS.map((p) => patternClause(p)))).join(" OR ");
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

function soqlNameList(names: Set<string>): string {
  return Array.from(names)
    .map((n) => `'${n.replace(/'/g, "\\'")}'`)
    .join(",");
}

const MDR_OWNER_NAMES_SOQL = soqlNameList(MDR_OWNER_NAMES);
const SDR_OWNER_NAMES_SOQL = soqlNameList(SDR_OWNER_NAMES);
const ALL_MDR_SDR_NAMES_SOQL = soqlNameList(new Set([...MDR_OWNER_NAMES, ...SDR_OWNER_NAMES]));

async function touchpointEvents(accountId: string, key: TouchpointKey, dateClause: string) {
  const tp = TOUCHPOINTS[key];
  const subjectClause = `(${tp.patterns.map((p) => patternClause(p)).join(" OR ")})`;
  // mdr/sdr/sales share a Subject prefix - Owner.Name is the only thing that
  // tells them apart, so the detail list needs the same filter the rank
  // scan uses, or an MDR popup would also show every other rep's touches.
  const ownerClause =
    tp.source === "mdr"
      ? ` AND Owner.Name IN (${MDR_OWNER_NAMES_SOQL})`
      : tp.source === "sdr"
      ? ` AND Owner.Name IN (${SDR_OWNER_NAMES_SOQL})`
      : tp.source === "sales"
      ? ` AND Owner.Name NOT IN (${ALL_MDR_SDR_NAMES_SOQL})`
      : "";

  // WhoId can point at either a Contact or a Lead for this account - a real,
  // confirmed gap was that Lead-owned touches (e.g. an event attendee being
  // worked by MDR/SDR before conversion) were dropped entirely when only
  // Contacts were checked here (see getLeadToAccountMap for the field
  // mapping). Both are fetched and queried together below.
  // The cached index (same Contact/Lead -> Account mapping the rank scan
  // uses) saves two Salesforce round trips per popup; falls back to querying
  // directly only if it hasn't loaded yet.
  const whoIndex = peekWhoIndex();
  let whoIds: string[];
  if (whoIndex) {
    whoIds = whoIndex.whoIdsByAccount.get(accountId) ?? [];
  } else {
    const [contacts, leads] = await Promise.all([
      soqlQuery<{ Id: string }>(`SELECT Id FROM Contact WHERE AccountId = '${esc(accountId)}'`),
      soqlQuery<{ Id: string }>(
        `SELECT Id FROM Lead WHERE Company_Account_ID__c = '${esc(accountId)}' OR Account__c = '${esc(accountId)}'`
      ),
    ]);
    whoIds = [...contacts.map((c) => c.Id), ...leads.map((l) => l.Id)];
  }
  if (whoIds.length === 0) return { events: [] as any[] };

  const instanceUrl = await getInstanceUrl();
  const events: any[] = [];

  const batchResults = await Promise.all(chunk(whoIds, 400).map((batch) => {
    const inList = batch.map((id) => `'${esc(id)}'`).join(",");
    return soqlQuery<{
      Id: string;
      Subject: string;
      WhoId: string;
      Who: { Name: string } | null;
      Owner: { Name: string; Email: string } | null;
      ActivityDate: string;
      CreatedDate: string;
      Description: string | null;
    }>(
      `SELECT Id, Subject, WhoId, Who.Name, Owner.Name, Owner.Email, ActivityDate, CreatedDate, Description FROM Task WHERE ${subjectClause} AND WhoId IN (${inList})${ownerClause}${dateClause} ORDER BY CreatedDate DESC LIMIT 500`
    );
  }));

  for (const tasks of batchResults) {
    for (const t of tasks) {
      // Marketing automation style: "Email_open - Campaign Name" -> "Campaign Name".
      // MDR/Outreach.io style: "[Outreach] [Email] [Opened] <actual subject>" ->
      // "<actual subject>"; calls have no trailing text so are left as-is.
      const cleaned = t.Subject.replace(/^[A-Za-z]+_[a-z]+\s*-\s*/i, "").replace(
        /^\[Outreach\]\s*(\[[^\]]+\]\s*)+/,
        ""
      );
      // A Lead's Id always starts with the 00Q key prefix, a Contact's with
      // 003 - used here only to pick the right Salesforce object page and
      // label, since the query above already mixed both kinds of WhoId
      // together.
      const personType = t.WhoId.startsWith("00Q") ? "Lead" : "Contact";
      events.push({
        taskId: t.Id,
        person: t.Who?.Name || `(unknown ${personType.toLowerCase()})`,
        contactId: t.WhoId,
        personType,
        campaign: cleaned || t.Subject,
        date: t.ActivityDate || t.CreatedDate,
        // The Netcore rep who owns this Task - confirmed via Task.OwnerId that
        // this always resolves to a real Netcore sender (not an integration
        // user), verified directly against live data.
        sender: t.Owner?.Name || null,
        senderEmail: t.Owner?.Email || null,
        // Only populated for Outreach.io "sent"/"reply received" events,
        // which genuinely carry the full email body in Description. Marketing
        // automation tasks (Email_open/Email_click/Whatsapp_*) ALSO have a
        // non-empty Description, but confirmed against live data it's just
        // internal sync metadata (campaign ID, webhook name, sync
        // timestamp) - never the email body - so surfacing it as "click to
        // read email" would be actively misleading, not merely unhelpful.
        description: tp.source !== "marketing" ? t.Description || null : null,
        sfTaskUrl: `${instanceUrl}/lightning/r/Task/${t.Id}/view`,
        sfContactUrl: `${instanceUrl}/lightning/r/${personType}/${t.WhoId}/view`,
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
      .map((s) => {
        const highIntent = isHighIntentUrl(s.firstPageUrl) || isHighIntentUrl(s.latestPageUrl);
        // Mutually exclusive, same precedence rule as computeRanks: a session
        // that matches both tiers counts as High, never both at once.
        const mediumIntent = !highIntent && (isMediumIntentUrl(s.firstPageUrl) || isMediumIntentUrl(s.latestPageUrl));
        return {
          date: s.eventDate,
          receivedAt: s.receivedAt,
          durationSec: s.sessionActiveTimeSec,
          firstPageUrl: s.firstPageUrl,
          latestPageUrl: s.latestPageUrl,
          highIntent,
          mediumIntent,
        };
      })
      .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));

    const totalDurationSec = matched.reduce((sum, s) => sum + s.sessionActiveTimeSec, 0);
    const highIntentCount = events.filter((e) => e.highIntent).length;
    const mediumIntentCount = events.filter((e) => e.mediumIntent).length;

    res.json({ sessionCount: matched.length, totalDurationSec, highIntentCount, mediumIntentCount, events });
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
