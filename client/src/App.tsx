import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  fetchAccounts,
  fetchContactCounts,
  fetchLinkedinSnapshots,
  fetchFactorsScores,
  fetchRank,
  TOUCHPOINTS,
  TOUCHPOINT_SOURCE,
  type DateRange,
  type FactorsSnapshot,
  type LinkedinMetrics,
  type LinkedinSnapshot,
  type RankEntry,
  type TouchpointKey,
} from "./api";
import type { SheetAccount } from "./types";
import { monthWeeks, currentWeekNumber, monthValueOf, monthBounds, monthOptionsRange } from "./weeks";
import { ContactsModal } from "./components/ContactsModal";
import { TouchpointEventsModal } from "./components/TouchpointEventsModal";
import { WebsiteSessionsModal } from "./components/WebsiteSessionsModal";
import { FactorsHistoryModal } from "./components/FactorsHistoryModal";
import { ColumnFilter } from "./components/ColumnFilter";
import { ThemeToggle } from "./components/ThemeToggle";
import { FactorSpikeCard } from "./components/FactorSpikeCard";
import { HoverCell } from "./components/HoverCell";
import { computeEngagementScores, percentileRanks } from "./score";
import { MetricMultiSelect } from "./components/MetricMultiSelect";
import { loadPersistedState, savePersistedState } from "./persist";

const PAGE_SIZE = 25;
const TOUCHPOINT_KEYS = Object.keys(TOUCHPOINTS) as TouchpointKey[];

// The four effort groups shown as distinct, clearly-labeled sections in the
// table, left to right: Marketing (what marketing sent/ran) first, then the
// funnel order MDR -> SDR -> Sales (all three from Outreach.io, split by who
// owns the Task).
const MARKETING_TOUCHPOINT_KEYS = TOUCHPOINT_KEYS.filter((k) => TOUCHPOINT_SOURCE[k] === "marketing");
const MDR_TOUCHPOINT_KEYS = TOUCHPOINT_KEYS.filter((k) => TOUCHPOINT_SOURCE[k] === "mdr");
const SDR_TOUCHPOINT_KEYS = TOUCHPOINT_KEYS.filter((k) => TOUCHPOINT_SOURCE[k] === "sdr");
const SALES_TOUCHPOINT_KEYS = TOUCHPOINT_KEYS.filter((k) => TOUCHPOINT_SOURCE[k] === "sales");

// UI TRIAL (branch: redesign-tabbed-kpi): column groups used to all sit side
// by side, needing constant horizontal scrolling to compare Marketing vs.
// LinkedIn vs. MDR vs. SDR vs. Sales. This swaps that for a tab switcher -
// one group's columns shown at a time, frozen columns unaffected - plus a KPI
// strip above the table so a quick glance doesn't require picking a tab at
// all. If this doesn't work out, `git checkout main` throws it all away
// cleanly since it was built on its own branch.
type GroupTab = "marketing" | "linkedin" | "mdr" | "sdr" | "sales";
const GROUP_TABS: { key: GroupTab; label: string }[] = [
  { key: "marketing", label: "Marketing" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "mdr", label: "MDR" },
  { key: "sdr", label: "SDR" },
  { key: "sales", label: "Sales" },
];

const LINKEDIN_COLUMNS: { key: keyof LinkedinMetrics; label: string }[] = [
  { key: "organicImpressions", label: "LI Organic Impr. (7d)" },
  { key: "organicEngagements", label: "LI Organic Eng. (7d)" },
  { key: "paidImpressions", label: "LI Paid Impr. (7d)" },
  { key: "paidEngagements", label: "LI Paid Eng. (7d)" },
  { key: "paidClicks", label: "LI Paid Clicks (7d)" },
];

/**
 * One-click "top accounts by X" engagement filter - deliberately NOT every
 * metric the table tracks. Per explicit request: only the signals that
 * actually indicate real intent (replies, clicks, answered calls, and the
 * two website intent tiers) - not passive/low-value ones like "opened",
 * "sent", "read", or raw impressions, which have their own dedicated column
 * already but don't belong in a "show me who's engaged" quick filter.
 */
type SortOption =
  | { key: string; label: string; group: string; kind: "touchpoint"; tKey: TouchpointKey }
  | { key: string; label: string; group: string; kind: "linkedin"; liKey: keyof LinkedinMetrics }
  | { key: "highIntent" | "mediumIntent"; label: string; group: string; kind: "intent" };

const SOURCE_GROUP_LABEL: Record<string, string> = {
  marketing: "Marketing",
  mdr: "MDR",
  sdr: "SDR",
  sales: "Sales",
};

// Clicked/replied/answered-call only - the "someone responded" tier, not the
// "something was sent/opened/read" tier (emailOpens, waRead, *EmailOut,
// *EmailOpened are intentionally left out of this list).
const HIGH_VALUE_TOUCHPOINT_KEYS: TouchpointKey[] = [
  "emailClicks",
  "waReplied",
  "waClicked",
  "mdrEmailClicked",
  "mdrEmailReplied",
  "mdrCalls",
  "mdrWaCalls",
  "sdrEmailClicked",
  "sdrEmailReplied",
  "sdrCalls",
  "sdrWaCalls",
  "salesEmailClicked",
  "salesEmailReplied",
  "salesCalls",
  "salesWaCalls",
];

// Same idea for LinkedIn - engagements/clicks, not raw impressions.
const HIGH_VALUE_LINKEDIN_COLUMNS = LINKEDIN_COLUMNS.filter((c) =>
  (["organicEngagements", "paidEngagements", "paidClicks"] as (keyof LinkedinMetrics)[]).includes(c.key)
);

const SORT_OPTIONS: SortOption[] = [
  ...HIGH_VALUE_TOUCHPOINT_KEYS.map(
    (k): SortOption => ({
      key: k,
      label: TOUCHPOINTS[k],
      group: SOURCE_GROUP_LABEL[TOUCHPOINT_SOURCE[k]],
      kind: "touchpoint",
      tKey: k,
    })
  ),
  ...HIGH_VALUE_LINKEDIN_COLUMNS.map(
    (c): SortOption => ({ key: `li_${c.key}`, label: c.label, group: "LinkedIn", kind: "linkedin", liKey: c.key })
  ),
  { key: "highIntent", label: "🔥 High-intent pages", group: "Intent", kind: "intent" },
  { key: "mediumIntent", label: "☀️ Medium-intent pages", group: "Intent", kind: "intent" },
];

/** Only meaningful for sort-able kinds - "intent" options are filters, handled separately (see the filtered useMemo). */
function sortOptionValue(
  opt: SortOption,
  accountId: string,
  ranks: Record<string, RankEntry>,
  liMetrics: Record<string, LinkedinMetrics> | undefined
): number {
  if (opt.kind === "touchpoint") return ranks[accountId]?.[opt.tKey] ?? 0;
  if (opt.kind === "linkedin") return liMetrics?.[accountId]?.[opt.liKey] ?? 0;
  return 0;
}

function parseMrr(v: string): number {
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Renders a touchpoint/LinkedIn count as "–" for a real zero, so actual activity stands out instead of a page full of zeros. */
function fmtMetric(n: number | undefined): ReactNode {
  if (n === undefined) return "…";
  if (n === 0) return <span className="metric-zero">–</span>;
  return n;
}

function factorClass(level: string | undefined): string {
  if (level === "Hot") return "factor-hot";
  if (level === "Warm") return "factor-warm";
  if (level === "Cool") return "factor-cool";
  if (level === "Ice") return "factor-ice";
  return "factor-unscored";
}

/** The month this dashboard went live - the month dropdown lists every month from here through the current real month, growing on its own as time passes. */
const DASHBOARD_START_MONTH = "2026-10";

/** A specific week, or "all" for the whole month consolidated together. */
type WeekSelection = number | "all";

type ModalState =
  | { kind: "contacts"; accountId: string; accountName: string }
  | { kind: "touchpoint"; touchpoint: TouchpointKey; accountId: string; accountName: string }
  | { kind: "website"; accountId: string; accountName: string }
  | { kind: "factorsHistory"; accountId: string; accountName: string }
  | null;

export default function App() {
  // Restores week, filters, search, sort, and page from the last session in
  // this browser, so switching tabs/reloading to dig into something doesn't
  // throw away where you were. Read once at mount, not on every render.
  const persisted = useMemo(() => loadPersistedState(), []);

  // Month dropdown lists every month from go-live through the current real
  // month - grows on its own as time passes, no manual upkeep. Weeks are
  // computed for whichever month is currently selected, not always "now".
  const monthOptions = useMemo(
    () => monthOptionsRange(DASHBOARD_START_MONTH, monthValueOf(new Date())),
    []
  );
  const [selectedMonth, setSelectedMonth] = useState(() => persisted.month ?? monthValueOf(new Date()));
  const weeks = useMemo(() => {
    const [y, m] = selectedMonth.split("-").map(Number);
    return monthWeeks(new Date(y, m - 1, 1));
  }, [selectedMonth]);

  const [selectedWeekNum, setSelectedWeekNum] = useState<WeekSelection>(
    () => persisted.weekNum ?? currentWeekNumber(weeks, todayIso())
  );

  function selectMonth(month: string) {
    setSelectedMonth(month);
    setSelectedWeekNum("all"); // land on the month overview; drill into a week from there
  }

  const dateRange: DateRange = useMemo(() => {
    if (selectedWeekNum === "all") return monthBounds(selectedMonth);
    const w = weeks.find((x) => x.week === selectedWeekNum) || weeks[0];
    return { start: w.start, end: w.end };
  }, [weeks, selectedWeekNum, selectedMonth]);

  const [accounts, setAccounts] = useState<SheetAccount[]>([]);
  const [instanceUrl, setInstanceUrl] = useState<string>("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState(() => persisted.search ?? "");
  const [page, setPage] = useState(() => persisted.page ?? 0);
  const [contactCounts, setContactCounts] = useState<Record<string, number>>({});
  const [modal, setModal] = useState<ModalState>(null);

  const [ranks, setRanks] = useState<Record<string, RankEntry>>({});
  const [rankLoading, setRankLoading] = useState(false);
  const [rankForRange, setRankForRange] = useState<string | null>(null);

  const [liSnapshots, setLiSnapshots] = useState<LinkedinSnapshot[]>([]);

  const [factorsScores, setFactorsScores] = useState<Record<string, FactorsSnapshot>>({});
  const [factorsAsOfDate, setFactorsAsOfDate] = useState<string | null>(null);
  const [factorsIsLive, setFactorsIsLive] = useState(false);
  const [factorsForRange, setFactorsForRange] = useState<string | null>(null);

  const [selectedRegions, setSelectedRegions] = useState<Set<string>>(new Set());
  const [selectedMrr, setSelectedMrr] = useState<Set<string>>(new Set());
  const [selectedFactorLevels, setSelectedFactorLevels] = useState<Set<string>>(new Set());
  const [selectedPriorities, setSelectedPriorities] = useState<Set<string>>(new Set());
  const [sortMetrics, setSortMetrics] = useState<Set<string>>(() => new Set(persisted.sortMetrics ?? []));

  // UI trial (redesign-tabbed-kpi branch) state - see the GROUP_TABS comment above.
  const [activeTab, setActiveTab] = useState<GroupTab>(
    () => (persisted.groupTab as GroupTab) ?? "marketing"
  );

  useEffect(() => {
    fetchAccounts()
      .then((r) => {
        setAccounts(r.accounts);
        setInstanceUrl(r.instanceUrl);
      })
      .catch((e) => setLoadError(String(e.message || e)));
  }, []);

  // LinkedIn exports land on a confirmed-irregular 4-6 day basis with no
  // fixed schedule, so there's no real "week" to pick for it - instead of a
  // second control, just load every snapshot seen so far once and auto-pick
  // whichever one applies to the selected Week below (one shared control).
  useEffect(() => {
    fetchLinkedinSnapshots()
      .then((r) => setLiSnapshots(r.snapshots))
      .catch((e) => setLoadError(String(e.message || e)));
  }, []);

  const LI_STALENESS_DAYS = 15;

  // The single rule that avoids the overlapping-window double-count problem:
  // always show exactly ONE snapshot's raw numbers, never sum snapshots
  // together. Pick whichever snapshot was the most recent one actually
  // AVAILABLE as of the end of the selected week - i.e. "the latest LinkedIn
  // read we had by then." Eligibility must use receivedDate, not asOfDate:
  // asOfDate is just the window's own end date, and the export for that
  // window doesn't land until several days later - e.g. the Oct 5-11 window
  // wasn't actually pushed until Oct 13, so it must NOT show up when viewing
  // the Oct 5-11 week itself (that would be showing data from the future
  // relative to that week). Using asOfDate for eligibility was the bug.
  //
  // Factors confirmed the export cadence is irregular (observed: Oct 13,
  // Oct 17, Oct 22 - gaps of 4-5 days) with no fixed schedule. 15 days is
  // ~3x the worst gap seen so far, used only as a staleness guard: if the
  // latest eligible snapshot is older than that, treat it as missing rather
  // than silently showing a month-old number as if it were current.
  const currentLiSnapshot = useMemo(() => {
    const eligible = liSnapshots.filter((s) => s.receivedDate <= dateRange.end);
    if (eligible.length === 0) return null;
    const latest = eligible.reduce((latest, s) => (s.receivedDate > latest.receivedDate ? s : latest));
    const ageDays = (Date.parse(dateRange.end) - Date.parse(latest.receivedDate)) / 86400000;
    if (ageDays > LI_STALENESS_DAYS) return null;
    return latest;
  }, [liSnapshots, dateRange.end]);

  const regionOptions = useMemo(
    () => Array.from(new Set(accounts.map((a) => a.marketingRegion).filter(Boolean))).sort(),
    [accounts]
  );
  const mrrOptions = useMemo(
    () => Array.from(new Set(accounts.map((a) => a.potentialMrr).filter(Boolean))).sort(
      (a, b) => parseMrr(a) - parseMrr(b)
    ),
    [accounts]
  );

  // Column filters default to "everything selected" once the option lists
  // are known - but only the FIRST time, and only if there's no restored
  // selection from a previous session; otherwise this would stomp a
  // just-restored narrower filter back to "everything" on every load.
  const regionsInitialized = useRef(false);
  useEffect(() => {
    if (regionOptions.length === 0 || regionsInitialized.current) return;
    regionsInitialized.current = true;
    const restored = (persisted.regions ?? []).filter((r) => regionOptions.includes(r));
    setSelectedRegions(new Set(restored.length > 0 ? restored : regionOptions));
  }, [regionOptions, persisted]);

  const mrrInitialized = useRef(false);
  useEffect(() => {
    if (mrrOptions.length === 0 || mrrInitialized.current) return;
    mrrInitialized.current = true;
    const restored = (persisted.mrr ?? []).filter((m) => mrrOptions.includes(m));
    setSelectedMrr(new Set(restored.length > 0 ? restored : mrrOptions));
  }, [mrrOptions, persisted]);

  // Confirmed against the live Google Sheet (the same source every other
  // identifier column here comes from): P0/P1/P2/blank are the only values
  // this column ever holds across all 5,555 TAL accounts - "Not set" is the
  // bucket for blank. Live Salesforce can drift from this (one account was
  // found as P3 there, still P0 in the sheet), but this dashboard reflects
  // the sheet everywhere else, so the filter matches that, not live SF.
  const priorityOptions = useMemo(() => ["P0", "P1", "P2", "Not set"], []);
  const prioritiesInitialized = useRef(false);
  useEffect(() => {
    if (prioritiesInitialized.current) return;
    prioritiesInitialized.current = true;
    const restored = (persisted.priorities ?? []).filter((p) => priorityOptions.includes(p));
    setSelectedPriorities(new Set(restored.length > 0 ? restored : priorityOptions));
  }, [priorityOptions, persisted]);

  // Fixed list, not derived from data - these are the only values
  // Factors.ai's Engagement_Level__c picklist can hold, plus a bucket for
  // accounts Factors hasn't scored yet (blank level).
  const factorLevelOptions = useMemo(() => ["Hot", "Warm", "Cool", "Ice", "Not scored"], []);
  const factorLevelsInitialized = useRef(false);
  useEffect(() => {
    if (factorLevelsInitialized.current) return;
    factorLevelsInitialized.current = true;
    const restored = (persisted.factorLevels ?? []).filter((f) => factorLevelOptions.includes(f));
    setSelectedFactorLevels(new Set(restored.length > 0 ? restored : factorLevelOptions));
  }, [factorLevelOptions, persisted]);

  const rangeKey = `${dateRange.start}|${dateRange.end}`;
  const ranksReady = rangeKey === rankForRange;
  const factorsReady = rangeKey === factorsForRange;
  const weekIncludesToday = dateRange.end >= todayIso();

  // The Engagement Score every account gets for the selected week - a plain
  // sum of marketing touchpoints (see score.ts for the full reasoning,
  // including how LinkedIn impressions are converted to points instead of
  // being summed directly). Needs every account's data at once since
  // LinkedIn metrics come from the shared snapshot, so it's recomputed
  // whenever the week's ranks or LinkedIn snapshot change.
  const engagementScores = useMemo(() => {
    if (!ranksReady) return null;
    return computeEngagementScores(
      accounts.map((a) => a.accountId),
      ranks,
      currentLiSnapshot?.metrics
    );
  }, [accounts, ranks, ranksReady, currentLiSnapshot]);

  // The Score is now an unbounded raw sum, not a 0-100 number, so the pill's
  // green/amber/pink color is driven by this week's PERCENTILE rank among
  // all accounts instead of a fixed threshold - "top third this week" always
  // means something, regardless of what the raw sum happens to total up to.
  const scoreTiers = useMemo(() => {
    if (!engagementScores) return null;
    const ids = accounts.map((a) => a.accountId);
    const pcts = percentileRanks(ids.map((id) => engagementScores[id] ?? 0));
    const tiers: Record<string, number> = {};
    ids.forEach((id, idx) => (tiers[id] = pcts[idx]));
    return tiers;
  }, [accounts, engagementScores]);

  // Ranking is a full scan (every touchpoint + website sessions for every
  // account), so it's fetched once per selected week and reused for every
  // page/search/filter change.
  useEffect(() => {
    let cancelled = false;
    setRankLoading(true);
    fetchRank(dateRange)
      .then((r) => {
        if (cancelled) return;
        setRanks(r.ranks);
        setRankForRange(rangeKey);
      })
      .catch((e) => !cancelled && setLoadError(String(e.message || e)))
      .finally(() => !cancelled && setRankLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey]);

  // Factor Score (Factors.ai Engagement Level + raw score) - independent
  // fetch from the Salesforce-Task rank scan above, since it comes from a
  // different source (the daily Factors_Score sheet, or live Salesforce for
  // today) and resolves per-period rather than counting anything.
  useEffect(() => {
    let cancelled = false;
    fetchFactorsScores(dateRange)
      .then((r) => {
        if (cancelled) return;
        setFactorsScores(r.byAccount);
        setFactorsAsOfDate(r.asOfDate);
        setFactorsIsLive(r.isLive);
        setFactorsForRange(rangeKey);
      })
      .catch((e) => !cancelled && setLoadError(String(e.message || e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey]);

  // Lets someone pick several "top accounts by" metrics at once (e.g. most
  // email opens AND most website sessions) instead of only one at a time.
  // Each selected metric is percentile-ranked (same technique as the main
  // Engagement Score, so metrics on very different scales stay comparable)
  // and averaged - an account strong across all the metrics you picked
  // lands at the top, not just one that happens to dominate a single metric.
  const combinedMetricScores = useMemo(() => {
    if (sortMetrics.size === 0 || !ranksReady) return null;
    const ids = accounts.map((a) => a.accountId);
    // "intent" entries are filters (handled below in `filtered`), not
    // percentile-sortable metrics - excluded here so picking only an intent
    // checkbox doesn't silently fall through to an empty, meaningless sort.
    const selectedOpts = SORT_OPTIONS.filter((o) => sortMetrics.has(o.key) && o.kind !== "intent");
    if (selectedOpts.length === 0) return null;

    const percentilesByMetric = selectedOpts.map((opt) =>
      percentileRanks(ids.map((id) => sortOptionValue(opt, id, ranks, currentLiSnapshot?.metrics)))
    );

    const scores: Record<string, number> = {};
    ids.forEach((id, idx) => {
      const sum = percentilesByMetric.reduce((n, pcts) => n + pcts[idx], 0);
      scores[id] = sum / selectedOpts.length;
    });
    return scores;
  }, [accounts, ranks, ranksReady, currentLiSnapshot, sortMetrics]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = accounts
      .filter((a) => selectedRegions.size === 0 || selectedRegions.has(a.marketingRegion))
      .filter((a) => selectedMrr.size === 0 || selectedMrr.has(a.potentialMrr))
      .filter((a) => selectedPriorities.size === 0 || selectedPriorities.has(a.accountPriority || "Not set"))
      // Skip entirely until the Factor Score fetch for this week lands -
      // otherwise every account reads as "Not scored" during the loading
      // window and the table would flash down to almost nothing.
      .filter(
        (a) =>
          !factorsReady ||
          selectedFactorLevels.size === 0 ||
          selectedFactorLevels.has(factorsScores[a.accountId]?.level || "Not scored")
      )
      .filter(
        (a) =>
          !q ||
          a.accountName.toLowerCase().includes(q) ||
          a.website.toLowerCase().includes(q)
      )
      .filter((a) => !sortMetrics.has("highIntent") || (ranks[a.accountId]?.highIntentSessions ?? 0) > 0)
      // Medium must exclude accounts that ALSO have a High-intent session -
      // otherwise filtering by Medium still shows fire-glowing (High) rows,
      // since an account can rack up sessions in both tiers across a whole
      // month. The 🔥/☀️ icon already treats these as mutually exclusive
      // (fire wins), so the filter has to match that same precedence or the
      // two disagree with each other, which is exactly the bug reported.
      .filter(
        (a) =>
          !sortMetrics.has("mediumIntent") ||
          ((ranks[a.accountId]?.mediumIntentSessions ?? 0) > 0 && (ranks[a.accountId]?.highIntentSessions ?? 0) === 0)
      );

    if (combinedMetricScores) {
      rows.sort((a, b) => {
        const diff = (combinedMetricScores[b.accountId] ?? 0) - (combinedMetricScores[a.accountId] ?? 0);
        if (diff !== 0) return diff;
        return parseMrr(b.potentialMrr) - parseMrr(a.potentialMrr);
      });
    } else if (ranksReady && engagementScores) {
      rows.sort((a, b) => {
        const scoreDiff = (engagementScores[b.accountId] ?? 0) - (engagementScores[a.accountId] ?? 0);
        if (scoreDiff !== 0) return scoreDiff;
        return parseMrr(b.potentialMrr) - parseMrr(a.potentialMrr);
      });
    } else {
      rows.sort((a, b) => parseMrr(b.potentialMrr) - parseMrr(a.potentialMrr));
    }
    return rows;
  }, [accounts, search, selectedRegions, selectedMrr, selectedPriorities, selectedFactorLevels, factorsReady, factorsScores, sortMetrics, ranks, ranksReady, currentLiSnapshot, combinedMetricScores, engagementScores]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  // UI trial (redesign-tabbed-kpi): Factor Score split for the KPI strip -
  // computed over every currently-filtered account (not just the visible
  // page), so the glance view reflects the whole filtered set.
  const factorKpis = useMemo(() => {
    if (!factorsReady) return null;
    const counts = { Hot: 0, Warm: 0, Cool: 0, Ice: 0 };
    for (const a of filtered) {
      const level = factorsScores[a.accountId]?.level;
      if (level && level in counts) counts[level as keyof typeof counts]++;
    }
    return counts;
  }, [filtered, factorsReady, factorsScores]);

  // UI trial (redesign-tabbed-kpi): each tab shows a running total for its
  // group across every filtered account, so switching away to another tab
  // doesn't lose all sense of "is there activity I'm not looking at."
  const tabAggregates = useMemo(() => {
    if (!ranksReady) return null;
    const sumKeys = (keys: TouchpointKey[]) =>
      filtered.reduce((sum, a) => sum + keys.reduce((s, k) => s + (ranks[a.accountId]?.[k] ?? 0), 0), 0);
    const marketing =
      filtered.reduce((sum, a) => sum + (ranks[a.accountId]?.websiteSessions ?? 0), 0) +
      sumKeys(MARKETING_TOUCHPOINT_KEYS);
    let linkedin = 0;
    if (currentLiSnapshot) {
      for (const a of filtered) {
        const li = currentLiSnapshot.metrics[a.accountId];
        if (li) linkedin += li.organicEngagements + li.paidEngagements + li.paidClicks;
      }
    }
    return {
      marketing,
      linkedin,
      mdr: sumKeys(MDR_TOUCHPOINT_KEYS),
      sdr: sumKeys(SDR_TOUCHPOINT_KEYS),
      sales: sumKeys(SALES_TOUCHPOINT_KEYS),
    };
  }, [filtered, ranksReady, ranks, currentLiSnapshot]);

  const activeFilterCount =
    (selectedRegions.size > 0 && selectedRegions.size < regionOptions.length ? 1 : 0) +
    (selectedMrr.size > 0 && selectedMrr.size < mrrOptions.length ? 1 : 0) +
    (selectedPriorities.size > 0 && selectedPriorities.size < priorityOptions.length ? 1 : 0) +
    (selectedFactorLevels.size > 0 && selectedFactorLevels.size < factorLevelOptions.length ? 1 : 0) +
    (sortMetrics.size > 0 ? 1 : 0);

  // Skips its first run so it doesn't immediately wipe out a page number
  // restored from a previous session - only resets to page 0 on a genuine
  // later change to one of these.
  const pageResetIsFirstRun = useRef(true);
  useEffect(() => {
    if (pageResetIsFirstRun.current) {
      pageResetIsFirstRun.current = false;
      return;
    }
    setPage(0);
  }, [search, selectedRegions, selectedMrr, selectedPriorities, selectedFactorLevels, rankForRange, sortMetrics, selectedMonth]);

  // Keyed directly on which accounts are actually visible (not on the things
  // that typically cause that to change) - sorting can reorder the visible
  // set via several different triggers (rank data arriving, the engagement
  // score, a multi-metric quick-sort), and missing any one of those from a
  // narrower dependency list left newly-surfaced rows stuck on "…" forever
  // since their contact count was never fetched.
  const visibleIdsKey = visible.map((a) => a.accountId).join(",");
  useEffect(() => {
    if (visible.length === 0) return;
    const ids = visible.map((a) => a.accountId);
    fetchContactCounts(ids)
      .then((r) => setContactCounts((prev) => ({ ...prev, ...r.counts })))
      .catch((e) => setLoadError(String(e.message || e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIdsKey]);

  // Saves the current week/filters/search/sort/page to this browser so
  // reloading or reopening the tab picks up right where you left off. Waits
  // for accounts (and therefore the region/MRR restore-or-default effects
  // above) to be ready first, so it never overwrites a just-restored filter
  // with the transient empty Set those start as before accounts load.
  useEffect(() => {
    if (regionOptions.length === 0) return;
    savePersistedState({
      month: selectedMonth,
      weekNum: selectedWeekNum,
      search,
      regions: Array.from(selectedRegions),
      mrr: Array.from(selectedMrr),
      priorities: Array.from(selectedPriorities),
      factorLevels: Array.from(selectedFactorLevels),
      sortMetrics: Array.from(sortMetrics),
      page,
      groupTab: activeTab,
    });
  }, [
    selectedMonth,
    selectedWeekNum,
    search,
    selectedRegions,
    selectedMrr,
    selectedPriorities,
    selectedFactorLevels,
    sortMetrics,
    page,
    regionOptions.length,
    activeTab,
  ]);

  const periodLabel = selectedWeekNum === "all" ? "This month" : "This week";
  const groupHeaderLabel =
    activeTab === "marketing"
      ? `Marketing Engagement · ${periodLabel}`
      : activeTab === "linkedin"
      ? "LinkedIn · Last 7 days"
      : activeTab === "mdr"
      ? `MDR Engagement · ${periodLabel}`
      : activeTab === "sdr"
      ? `SDR Engagement · ${periodLabel}`
      : `Sales Engagement · ${periodLabel}`;
  const groupColCount =
    activeTab === "marketing"
      ? 1 + MARKETING_TOUCHPOINT_KEYS.length
      : activeTab === "linkedin"
      ? LINKEDIN_COLUMNS.length
      : activeTab === "mdr"
      ? MDR_TOUCHPOINT_KEYS.length
      : activeTab === "sdr"
      ? SDR_TOUCHPOINT_KEYS.length
      : SALES_TOUCHPOINT_KEYS.length;

  function clearAllFilters() {
    setSelectedRegions(new Set(regionOptions));
    setSelectedMrr(new Set(mrrOptions));
    setSelectedPriorities(new Set(priorityOptions));
    setSelectedFactorLevels(new Set(factorLevelOptions));
    setSortMetrics(new Set());
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-row">
          <div>
            <h1>Ecomm TAL Dashboard</h1>
            <p className="subtitle">
              {accounts.length.toLocaleString()} accounts · LinkedIn shows the most recent data
              available as of the selected period
            </p>
          </div>
        </div>
        <div className="header-period-row">
          <span className="header-period-label">Period</span>
          <select
            className="week-select"
            value={selectedMonth}
            onChange={(e) => selectMonth(e.target.value)}
            title="Which month's data to look at - the week selector next to it narrows within this month, or pick 'All weeks' for the full month total"
          >
            {monthOptions.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <select
            className="week-select"
            value={selectedWeekNum}
            onChange={(e) => setSelectedWeekNum(e.target.value === "all" ? "all" : Number(e.target.value))}
          >
            <option value="all">All weeks ({monthOptions.find((m) => m.value === selectedMonth)?.label} total)</option>
            {weeks.map((w) => (
              <option key={w.week} value={w.week}>
                Week {w.week} ({w.start} to {w.end})
              </option>
            ))}
          </select>
          <ThemeToggle />
        </div>
      </header>

      <div className="kpi-row">
        <div className="bento-card">
          <div className="bento-card-top">
            <span className="bento-card-label">Factor score split</span>
            <span className="bento-card-meta">{filtered.length.toLocaleString()} accounts match filters</span>
          </div>
          {factorKpis ? (
            <>
              <div className="factor-bar">
                {(() => {
                  const total = factorKpis.Hot + factorKpis.Warm + factorKpis.Cool + factorKpis.Ice;
                  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
                  return (
                    <>
                      <div
                        className="factor-bar-segment factor-bar-hot"
                        style={{ flexBasis: `${pct(factorKpis.Hot)}%` }}
                      />
                      <div
                        className="factor-bar-segment factor-bar-warm"
                        style={{ flexBasis: `${pct(factorKpis.Warm)}%` }}
                      />
                      <div
                        className="factor-bar-segment factor-bar-cool"
                        style={{ flexBasis: `${pct(factorKpis.Cool)}%` }}
                      />
                      <div
                        className="factor-bar-segment factor-bar-ice"
                        style={{ flexBasis: `${pct(factorKpis.Ice)}%` }}
                      />
                    </>
                  );
                })()}
              </div>
              <div className="factor-legend">
                {(
                  [
                    ["Hot", factorKpis.Hot, "factor-bar-hot"],
                    ["Warm", factorKpis.Warm, "factor-bar-warm"],
                    ["Cool", factorKpis.Cool, "factor-bar-cool"],
                    ["Ice", factorKpis.Ice, "factor-bar-ice"],
                  ] as const
                ).map(([label, value, dotClass]) => (
                  <div key={label} className="factor-legend-item">
                    <div className="factor-legend-dot-row">
                      <span className={`factor-legend-dot ${dotClass}`} />
                      {label}
                    </div>
                    <div className={`factor-legend-value${value === 0 ? " factor-legend-value-zero" : ""}`}>
                      {value}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="bento-card-meta">…</div>
          )}
        </div>

        <FactorSpikeCard />
      </div>

      <div className="search-filter-bar">
        <input
          className="search-input-huge"
          placeholder="Search account, domain or owner"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="filter-chips-row">
          <ColumnFilter
            label="Region"
            options={regionOptions}
            selected={selectedRegions}
            onChange={setSelectedRegions}
          />
          <ColumnFilter
            label="Potential MRR"
            options={mrrOptions}
            selected={selectedMrr}
            onChange={setSelectedMrr}
          />
          <ColumnFilter
            label="Factor Score"
            options={factorLevelOptions}
            selected={selectedFactorLevels}
            onChange={setSelectedFactorLevels}
          />
          <ColumnFilter
            label="Account Priority"
            options={priorityOptions}
            selected={selectedPriorities}
            onChange={setSelectedPriorities}
          />
          <MetricMultiSelect
            options={SORT_OPTIONS}
            selected={sortMetrics}
            onChange={setSortMetrics}
            defaultLabel="Engagement: Score"
          />
          {activeFilterCount > 0 && (
            <button className="clear-all-link" onClick={clearAllFilters}>
              Clear all
            </button>
          )}
        </div>
      </div>

      {loadError && <p className="error">{loadError}</p>}

      {sortMetrics.size > 0 && (
        <p className="warning sort-active-note">
          {(() => {
            const selected = SORT_OPTIONS.filter((o) => sortMetrics.has(o.key));
            const filters = selected.filter((o) => o.kind === "intent");
            const sorts = selected.filter((o) => o.kind !== "intent");
            return (
              <>
                {filters.length > 0 && (
                  <>
                    Showing only accounts matching{" "}
                    <strong>{filters.map((o) => o.label).join(" + ")}</strong>
                    {sorts.length > 0 && ". "}
                  </>
                )}
                {sorts.length > 0 && (
                  <>
                    Sorted by <strong>{sorts.map((o) => o.label).join(" + ")}</strong>, highest
                    combined first.
                  </>
                )}
              </>
            );
          })()}{" "}
          <button className="link-btn" onClick={() => setSortMetrics(new Set())}>
            Clear
          </button>
        </p>
      )}

      <div className="table-head-row">
        <div className="group-tabs">
          {GROUP_TABS.map((t) => (
            <button
              key={t.key}
              className={`group-tab${activeTab === t.key ? " active" : ""}`}
              onClick={() => setActiveTab(t.key)}
            >
              {t.label}
              {tabAggregates && (
                <span className="group-tab-count">{tabAggregates[t.key].toLocaleString()}</span>
              )}
            </button>
          ))}
        </div>
        {weekIncludesToday && (
          <span
            className="sync-lag-note"
            title="Email and WhatsApp activity syncs into Salesforce ~1 day behind. The most recent day or two in this week may still be incomplete."
          >
            Email &amp; WhatsApp data lags ~1 day
          </span>
        )}
      </div>

      <div className="table-scroll">
      <table className="account-table">
        <thead>
          <tr>
            <th className="sticky-col sticky-col-1" rowSpan={2}>
              Account
            </th>
            <th className="sticky-col sticky-col-2" rowSpan={2}>
              Owner
            </th>
            <th className="sticky-col sticky-col-3" rowSpan={2}>
              Contacts
            </th>
            <th
              className="sticky-col sticky-col-4"
              rowSpan={2}
              title="Weighted priority score (0-100) - marketing engagement only. Frozen alongside the identifiers since it's the deciding factor for prioritizing accounts, not just another metric to scroll past."
            >
              Score
            </th>
            <th
              className="sticky-col sticky-col-5"
              rowSpan={2}
              title={
                factorsIsLive
                  ? "Factors.ai Engagement Level - LIVE from Salesforce right now, since today hasn't been written to history yet. Click any value for the full day-by-day trend."
                  : `Factors.ai Engagement Level as of ${factorsAsOfDate ?? "the selected period"} - permanent history, click for the full day-by-day trend.`
              }
            >
              Factor
            </th>
            <th colSpan={groupColCount} className="group-header">
              {groupHeaderLabel}
            </th>
          </tr>
          <tr>
            {/* Only the active tab's columns render - a single group header above spans whichever set is showing. */}
            {activeTab === "marketing" && (
              <>
                <th className="group-col-marketing">Website sessions</th>
                {MARKETING_TOUCHPOINT_KEYS.map((k) => (
                  <th key={k} className="group-col-marketing">
                    {TOUCHPOINTS[k]}
                  </th>
                ))}
              </>
            )}
            {activeTab === "linkedin" &&
              LINKEDIN_COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className="linkedin-col-header"
                  title={
                    currentLiSnapshot
                      ? `Last 7 days: ${currentLiSnapshot.windowStart} to ${currentLiSnapshot.asOfDate} (pushed ${currentLiSnapshot.receivedDate})`
                      : "No LinkedIn data available yet as of this week"
                  }
                >
                  {c.label}
                </th>
              ))}
            {activeTab === "mdr" &&
              MDR_TOUCHPOINT_KEYS.map((k) => (
                <th key={k} className="group-col-mdr">
                  {TOUCHPOINTS[k]}
                </th>
              ))}
            {activeTab === "sdr" &&
              SDR_TOUCHPOINT_KEYS.map((k) => (
                <th key={k} className="group-col-sdr">
                  {TOUCHPOINTS[k]}
                </th>
              ))}
            {activeTab === "sales" &&
              SALES_TOUCHPOINT_KEYS.map((k) => (
                <th key={k} className="group-col-sales">
                  {TOUCHPOINTS[k]}
                </th>
              ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((a) => {
            const contacts = contactCounts[a.accountId];
            const r = ranksReady ? ranks[a.accountId] : undefined;
            const li = currentLiSnapshot?.metrics[a.accountId];
            return (
              <tr key={a.accountId}>
                <td className="cell-account sticky-col sticky-col-1">
                  <div className="cell-account-stack">
                    {instanceUrl ? (
                      <a
                        href={`${instanceUrl}/lightning/r/Account/${a.accountId}/view`}
                        target="_blank"
                        rel="noreferrer"
                        className="account-link"
                      >
                        <HoverCell text={a.accountName} />
                      </a>
                    ) : (
                      <HoverCell text={a.accountName} />
                    )}
                    <span className="cell-account-domain">{a.website}</span>
                  </div>
                </td>
                <td className="cell-owner sticky-col sticky-col-2">
                  <HoverCell text={a.accountOwner} />
                </td>
                <td className="sticky-col sticky-col-3">
                  <button
                    className="metric-btn"
                    disabled={contacts === undefined}
                    onClick={() =>
                      setModal({ kind: "contacts", accountId: a.accountId, accountName: a.accountName })
                    }
                  >
                    {contacts !== undefined ? contacts : "…"}
                  </button>
                </td>
                <td className="sticky-col sticky-col-4">
                  {engagementScores && scoreTiers ? (
                    <span
                      className={
                        "score-pill " +
                        (scoreTiers[a.accountId] >= 66
                          ? "score-high"
                          : scoreTiers[a.accountId] >= 33
                          ? "score-mid"
                          : "score-low")
                      }
                      title="This week's raw engagement sum - color reflects where it ranks vs. other accounts this week"
                    >
                      {engagementScores[a.accountId]}
                    </span>
                  ) : (
                    "…"
                  )}
                </td>
                <td className="sticky-col sticky-col-5">
                  {factorsReady ? (
                    <button
                      className={`factor-pill ${factorClass(factorsScores[a.accountId]?.level)}`}
                      onClick={() =>
                        setModal({ kind: "factorsHistory", accountId: a.accountId, accountName: a.accountName })
                      }
                      title="Click for the full day-by-day history"
                    >
                      {factorsScores[a.accountId]?.level || "—"}
                      {factorsScores[a.accountId]?.score !== undefined && factorsScores[a.accountId]?.score !== null
                        ? ` ${factorsScores[a.accountId]!.score}`
                        : ""}
                    </button>
                  ) : (
                    "…"
                  )}
                </td>
                {activeTab === "marketing" && (
                  <>
                    <td className="group-col-marketing">
                      <button
                        className={`metric-btn${
                          r && r.highIntentSessions > 0
                            ? " metric-btn-fire"
                            : r && r.mediumIntentSessions > 0
                            ? " metric-btn-sun"
                            : ""
                        }`}
                        disabled={!r}
                        title={
                          r && r.highIntentSessions > 0
                            ? "Visited a high-intent page this period"
                            : r && r.mediumIntentSessions > 0
                            ? "Visited a medium-intent page this period"
                            : undefined
                        }
                        onClick={() =>
                          setModal({ kind: "website", accountId: a.accountId, accountName: a.accountName })
                        }
                      >
                        {r && r.highIntentSessions > 0 && <span className="fire-icon">🔥</span>}
                        {r && r.highIntentSessions === 0 && r.mediumIntentSessions > 0 && (
                          <span className="fire-icon">☀️</span>
                        )}
                        {fmtMetric(r?.websiteSessions)}
                      </button>
                    </td>
                    {MARKETING_TOUCHPOINT_KEYS.map((k) => (
                      <td key={k} className="group-col-marketing">
                        <button
                          className="metric-btn"
                          disabled={!r}
                          onClick={() =>
                            setModal({
                              kind: "touchpoint",
                              touchpoint: k,
                              accountId: a.accountId,
                              accountName: a.accountName,
                            })
                          }
                        >
                          {fmtMetric(r?.[k])}
                        </button>
                      </td>
                    ))}
                  </>
                )}
                {activeTab === "linkedin" &&
                  LINKEDIN_COLUMNS.map((c) => (
                    <td key={c.key} className="linkedin-col">
                      {fmtMetric(li ? li[c.key] : currentLiSnapshot ? 0 : undefined)}
                    </td>
                  ))}
                {activeTab === "mdr" &&
                  MDR_TOUCHPOINT_KEYS.map((k) => (
                    <td key={k} className="group-col-mdr">
                      <button
                        className="metric-btn"
                        disabled={!r}
                        onClick={() =>
                          setModal({
                            kind: "touchpoint",
                            touchpoint: k,
                            accountId: a.accountId,
                            accountName: a.accountName,
                          })
                        }
                      >
                        {fmtMetric(r?.[k])}
                      </button>
                    </td>
                  ))}
                {activeTab === "sdr" &&
                  SDR_TOUCHPOINT_KEYS.map((k) => (
                    <td key={k} className="group-col-sdr">
                      <button
                        className="metric-btn"
                        disabled={!r}
                        onClick={() =>
                          setModal({
                            kind: "touchpoint",
                            touchpoint: k,
                            accountId: a.accountId,
                            accountName: a.accountName,
                          })
                        }
                      >
                        {fmtMetric(r?.[k])}
                      </button>
                    </td>
                  ))}
                {activeTab === "sales" &&
                  SALES_TOUCHPOINT_KEYS.map((k) => (
                    <td key={k} className="group-col-sales">
                      <button
                        className="metric-btn"
                        disabled={!r}
                        onClick={() =>
                          setModal({
                            kind: "touchpoint",
                            touchpoint: k,
                            accountId: a.accountId,
                            accountName: a.accountName,
                          })
                      }
                    >
                      {fmtMetric(r?.[k])}
                    </button>
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>

      <div className="pager">
        <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          ← Prev
        </button>
        <span>
          Page {page + 1} of {pageCount} · showing {visible.length} of {filtered.length} matching accounts
        </span>
        <button disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)}>
          Next →
        </button>
      </div>

      {modal?.kind === "contacts" && (
        <ContactsModal
          accountId={modal.accountId}
          accountName={modal.accountName}
          range={dateRange}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === "touchpoint" && (
        <TouchpointEventsModal
          accountId={modal.accountId}
          accountName={modal.accountName}
          touchpoint={modal.touchpoint}
          range={dateRange}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === "website" && (
        <WebsiteSessionsModal
          accountId={modal.accountId}
          accountName={modal.accountName}
          range={dateRange}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === "factorsHistory" && (
        <FactorsHistoryModal
          accountId={modal.accountId}
          accountName={modal.accountName}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
