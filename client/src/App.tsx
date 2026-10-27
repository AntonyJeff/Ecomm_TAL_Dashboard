import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchAccounts,
  fetchContactCounts,
  fetchLinkedinSnapshots,
  fetchRank,
  TOUCHPOINTS,
  TOUCHPOINT_SOURCE,
  type DateRange,
  type LinkedinMetrics,
  type LinkedinSnapshot,
  type RankEntry,
  type TouchpointKey,
} from "./api";
import type { SheetAccount } from "./types";
import { monthWeeks, currentWeekNumber } from "./weeks";
import { ContactsModal } from "./components/ContactsModal";
import { TouchpointEventsModal } from "./components/TouchpointEventsModal";
import { WebsiteSessionsModal } from "./components/WebsiteSessionsModal";
import { ColumnFilter } from "./components/ColumnFilter";
import { ThemeToggle } from "./components/ThemeToggle";
import { HelpModal } from "./components/HelpModal";
import { HoverCell } from "./components/HoverCell";
import { computeEngagementScores, percentileRanks } from "./score";
import { MetricMultiSelect } from "./components/MetricMultiSelect";
import { loadPersistedState, savePersistedState } from "./persist";

const PAGE_SIZE = 25;
const TOUCHPOINT_KEYS = Object.keys(TOUCHPOINTS) as TouchpointKey[];

// The three effort groups shown as distinct, clearly-labeled sections in the
// table, left to right: Marketing (what marketing sent/ran), MDR, then Sales
// (both from Outreach.io, split by who owns the Task).
const MARKETING_TOUCHPOINT_KEYS = TOUCHPOINT_KEYS.filter((k) => TOUCHPOINT_SOURCE[k] === "marketing");
const MDR_TOUCHPOINT_KEYS = TOUCHPOINT_KEYS.filter((k) => TOUCHPOINT_SOURCE[k] === "mdr");
const SALES_TOUCHPOINT_KEYS = TOUCHPOINT_KEYS.filter((k) => TOUCHPOINT_SOURCE[k] === "sales");

const LINKEDIN_COLUMNS: { key: keyof LinkedinMetrics; label: string }[] = [
  { key: "organicImpressions", label: "LI Organic Impr. (7d)" },
  { key: "organicEngagements", label: "LI Organic Eng. (7d)" },
  { key: "paidImpressions", label: "LI Paid Impr. (7d)" },
  { key: "paidEngagements", label: "LI Paid Eng. (7d)" },
  { key: "paidClicks", label: "LI Paid Clicks (7d)" },
];

/** One-click "top accounts by X" quick sorts - the predefined filters leaders actually ask for. */
type SortOption =
  | { key: string; label: string; group: string; kind: "touchpoint"; tKey: TouchpointKey }
  | { key: string; label: string; group: string; kind: "website" }
  | { key: string; label: string; group: string; kind: "linkedin"; liKey: keyof LinkedinMetrics };

const SOURCE_GROUP_LABEL: Record<string, string> = {
  marketing: "Marketing",
  mdr: "MDR",
  sales: "Sales",
};

const SORT_OPTIONS: SortOption[] = [
  ...TOUCHPOINT_KEYS.map(
    (k): SortOption => ({
      key: k,
      label: TOUCHPOINTS[k],
      group: SOURCE_GROUP_LABEL[TOUCHPOINT_SOURCE[k]],
      kind: "touchpoint",
      tKey: k,
    })
  ),
  { key: "websiteSessions", label: "Website sessions", group: "Website", kind: "website" },
  ...LINKEDIN_COLUMNS.map(
    (c): SortOption => ({ key: `li_${c.key}`, label: c.label, group: "LinkedIn", kind: "linkedin", liKey: c.key })
  ),
];

function sortOptionValue(
  opt: SortOption,
  accountId: string,
  ranks: Record<string, RankEntry>,
  liMetrics: Record<string, LinkedinMetrics> | undefined
): number {
  if (opt.kind === "touchpoint") return ranks[accountId]?.[opt.tKey] ?? 0;
  if (opt.kind === "website") return ranks[accountId]?.websiteSessions ?? 0;
  return liMetrics?.[accountId]?.[opt.liKey] ?? 0;
}

function parseMrr(v: string): number {
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

type ModalState =
  | { kind: "contacts"; accountId: string; accountName: string }
  | { kind: "touchpoint"; touchpoint: TouchpointKey; accountId: string; accountName: string }
  | { kind: "website"; accountId: string; accountName: string }
  | null;

export default function App() {
  // Restores week, filters, search, sort, and page from the last session in
  // this browser, so switching tabs/reloading to dig into something doesn't
  // throw away where you were. Read once at mount, not on every render.
  const persisted = useMemo(() => loadPersistedState(), []);

  const weeks = useMemo(() => monthWeeks(new Date()), []);
  const [selectedWeekNum, setSelectedWeekNum] = useState(
    () => persisted.weekNum ?? currentWeekNumber(weeks, todayIso())
  );
  const dateRange: DateRange = useMemo(() => {
    const w = weeks.find((x) => x.week === selectedWeekNum) || weeks[0];
    return { start: w.start, end: w.end };
  }, [weeks, selectedWeekNum]);

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

  const [selectedRegions, setSelectedRegions] = useState<Set<string>>(new Set());
  const [selectedMrr, setSelectedMrr] = useState<Set<string>>(new Set());
  const [showHelp, setShowHelp] = useState(false);
  const [sortMetrics, setSortMetrics] = useState<Set<string>>(() => new Set(persisted.sortMetrics ?? []));

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

  const rangeKey = `${dateRange.start}|${dateRange.end}`;
  const ranksReady = rangeKey === rankForRange;
  const weekIncludesToday = dateRange.end >= todayIso();

  // The weighted-percentile priority score (0-100) every account gets for
  // the selected week - see score.ts for the full reasoning. Needs every
  // account's data at once (percentile rank is relative to the whole set),
  // so it's recomputed whenever the week's ranks or LinkedIn snapshot change.
  const engagementScores = useMemo(() => {
    if (!ranksReady) return null;
    return computeEngagementScores(
      accounts.map((a) => a.accountId),
      ranks,
      currentLiSnapshot?.metrics
    );
  }, [accounts, ranks, ranksReady, currentLiSnapshot]);

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

  // Lets someone pick several "top accounts by" metrics at once (e.g. most
  // email opens AND most website sessions) instead of only one at a time.
  // Each selected metric is percentile-ranked (same technique as the main
  // Engagement Score, so metrics on very different scales stay comparable)
  // and averaged - an account strong across all the metrics you picked
  // lands at the top, not just one that happens to dominate a single metric.
  const combinedMetricScores = useMemo(() => {
    if (sortMetrics.size === 0 || !ranksReady) return null;
    const ids = accounts.map((a) => a.accountId);
    const selectedOpts = SORT_OPTIONS.filter((o) => sortMetrics.has(o.key));
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
      .filter(
        (a) =>
          !q ||
          a.accountName.toLowerCase().includes(q) ||
          a.website.toLowerCase().includes(q)
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
  }, [accounts, search, selectedRegions, selectedMrr, ranks, ranksReady, currentLiSnapshot, combinedMetricScores, engagementScores]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

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
  }, [search, selectedRegions, selectedMrr, rankForRange, sortMetrics]);

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
      weekNum: selectedWeekNum,
      search,
      regions: Array.from(selectedRegions),
      mrr: Array.from(selectedMrr),
      sortMetrics: Array.from(sortMetrics),
      page,
    });
  }, [selectedWeekNum, search, selectedRegions, selectedMrr, sortMetrics, page, regionOptions.length]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-row">
          <div>
            <h1>Ecomm TAL Dashboard</h1>
            <p className="subtitle">
              {accounts.length.toLocaleString()} accounts · one Week selector drives everything ·
              LinkedIn shows the most recent data available as of that week
            </p>
          </div>
          <div className="header-actions">
            <button className="help-btn" onClick={() => setShowHelp(true)}>
              ? How to read this
            </button>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="toolbar">
        <select
          className="week-select"
          value={selectedWeekNum}
          onChange={(e) => setSelectedWeekNum(Number(e.target.value))}
        >
          {weeks.map((w) => (
            <option key={w.week} value={w.week}>
              Week {w.week} ({w.start} to {w.end})
            </option>
          ))}
        </select>
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
        <MetricMultiSelect
          options={SORT_OPTIONS}
          selected={sortMetrics}
          onChange={setSortMetrics}
          defaultLabel="Top accounts by: Engagement Score"
        />
        <input
          className="search-input"
          placeholder="Search by account name or domain…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {rankLoading && (
          <span className="loading-pill">
            computing ranking for this week… (first time for this week can take up to a minute)
          </span>
        )}
      </div>

      {weekIncludesToday && (
        <p className="warning">
          Heads up: email and WhatsApp activity syncs into Salesforce ~1 day behind. The most
          recent day or two in this week may still be incomplete.
        </p>
      )}
      {loadError && <p className="error">{loadError}</p>}

      {sortMetrics.size > 0 && (
        <p className="warning sort-active-note">
          Sorted by{" "}
          <strong>
            {SORT_OPTIONS.filter((o) => sortMetrics.has(o.key))
              .map((o) => o.label)
              .join(" + ")}
          </strong>
          , highest combined first.{" "}
          <button className="link-btn" onClick={() => setSortMetrics(new Set())}>
            Clear
          </button>
        </p>
      )}

      <div className="table-scroll">
      <table className="account-table">
        <thead>
          <tr>
            <th className="sticky-col sticky-col-1" rowSpan={2}>
              Account
            </th>
            <th className="sticky-col sticky-col-2" rowSpan={2}>
              Domain
            </th>
            <th className="sticky-col sticky-col-3" rowSpan={2}>
              # Contacts
            </th>
            <th
              rowSpan={2}
              title="Weighted priority score (0-100) - marketing engagement only (see “How to read this” for the formula). Scrolls with the rest, since it's a metric, not an identifier."
            >
              Score
            </th>
            <th
              colSpan={1 + MARKETING_TOUCHPOINT_KEYS.length + LINKEDIN_COLUMNS.length}
              className="group-header group-header-marketing"
            >
              Marketing
            </th>
            <th colSpan={MDR_TOUCHPOINT_KEYS.length} className="group-header group-header-mdr">
              MDR
            </th>
            <th colSpan={SALES_TOUCHPOINT_KEYS.length} className="group-header group-header-sales">
              Sales
            </th>
          </tr>
          <tr>
            <th># Website sessions</th>
            {MARKETING_TOUCHPOINT_KEYS.map((k) => (
              <th key={k}># {TOUCHPOINTS[k]}</th>
            ))}
            {LINKEDIN_COLUMNS.map((c) => (
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
            {MDR_TOUCHPOINT_KEYS.map((k) => (
              <th key={k} className="group-col-mdr">
                # {TOUCHPOINTS[k]}
              </th>
            ))}
            {SALES_TOUCHPOINT_KEYS.map((k) => (
              <th key={k} className="group-col-sales">
                # {TOUCHPOINTS[k]}
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
                </td>
                <td className="cell-domain sticky-col sticky-col-2">
                  <HoverCell text={a.website} />
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
                <td>
                  {engagementScores ? (
                    <span
                      className={
                        "score-pill " +
                        (engagementScores[a.accountId] >= 66
                          ? "score-high"
                          : engagementScores[a.accountId] >= 33
                          ? "score-mid"
                          : "score-low")
                      }
                    >
                      {engagementScores[a.accountId]}
                    </span>
                  ) : (
                    "…"
                  )}
                </td>
                <td>
                  <button
                    className="metric-btn"
                    disabled={!r}
                    onClick={() =>
                      setModal({ kind: "website", accountId: a.accountId, accountName: a.accountName })
                    }
                  >
                    {r ? r.websiteSessions : "…"}
                  </button>
                </td>
                {MARKETING_TOUCHPOINT_KEYS.map((k) => (
                  <td key={k}>
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
                      {r ? r[k] : "…"}
                    </button>
                  </td>
                ))}
                {LINKEDIN_COLUMNS.map((c) => (
                  <td key={c.key} className="linkedin-col">
                    {li ? li[c.key] : currentLiSnapshot ? 0 : "—"}
                  </td>
                ))}
                {MDR_TOUCHPOINT_KEYS.map((k) => (
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
                      {r ? r[k] : "…"}
                    </button>
                  </td>
                ))}
                {SALES_TOUCHPOINT_KEYS.map((k) => (
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
                      {r ? r[k] : "…"}
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
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
    </div>
  );
}
