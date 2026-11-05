import { useEffect, useMemo, useState } from "react";
import { fetchFactorSpikes, type FactorSpikesResult, type SpikeAccount } from "../api";
import { Modal } from "./Modal";
import { Timeline, TimelineItem } from "./Timeline";
import { ModernSelect } from "./ModernSelect";
import { monthWeeks, currentWeekNumber } from "../weeks";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const LEVEL_ICON: Record<string, string> = { Hot: "🔥", Warm: "🟠" };

function SpikeSignals({ account }: { account: SpikeAccount }) {
  if (account.signals.length === 0) return null;
  return (
    <div className="spike-signals">
      <div className="spike-signals-label">Why Factors.ai scored this:</div>
      <div className="spike-signals-list">
        {account.signals.map((s, i) => (
          <span key={i} className="spike-signal-chip">
            {s.label}
            {s.count !== null ? ` · ${s.count}` : ""}
          </span>
        ))}
      </div>
      <div className="spike-signals-note">
        These signals come straight from Factors.ai - LinkedIn ad impressions and website form
        submissions in particular are not currently tracked anywhere else in this dashboard.
      </div>
    </div>
  );
}

function SpikeGroup({ title, icon, accounts }: { title: string; icon: string; accounts: SpikeAccount[] }) {
  if (accounts.length === 0) return null;
  return (
    <>
      <h4 className="spike-group-title">
        {icon} {title} ({accounts.length})
      </h4>
      <Timeline>
        {accounts.map((a) => (
          <TimelineItem
            key={a.accountId}
            icon={LEVEL_ICON[a.toLevel] || "⚪"}
            title={a.accountName}
            subtitle={`${a.fromLevel} (${a.fromScore ?? "—"}) → ${a.toLevel} (${a.toScore ?? "—"})${
              a.crossedDate ? ` · ${a.crossedDate}` : ""
            }`}
            caption={<SpikeSignals account={a} />}
          />
        ))}
      </Timeline>
    </>
  );
}

/**
 * Week-scoped version of the spike banner's breakdown - mirrors the same
 * Week 1/2/3... boundaries as the main dashboard's Week filter instead of a
 * freeform date picker, so "who just heated up" reads as one running total
 * for the week in progress (filling in further each day as that week's
 * syncs land) with earlier weeks still a click away to look back on.
 */
export function FactorSpikesModal({ onClose }: { onClose: () => void }) {
  // Scoped to the CURRENT calendar month, same convention the rest of the
  // dashboard uses for its Week filter - a fresh set of weeks to navigate as
  // each new month starts.
  const weeks = useMemo(() => monthWeeks(new Date()), []);
  const [selectedWeek, setSelectedWeek] = useState(() => currentWeekNumber(weeks, todayIso()));
  const [result, setResult] = useState<FactorSpikesResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const week = weeks.find((w) => w.week === selectedWeek) ?? weeks[weeks.length - 1];

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    fetchFactorSpikes({ start: week.start, end: week.end })
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch((e) => !cancelled && setError(String(e.message || e)));
    return () => {
      cancelled = true;
    };
  }, [week.start, week.end]);

  const total = result ? result.newlyHot.length + result.newlyWarm.length : null;
  const isCurrentWeek = week.end >= todayIso() && week.start <= todayIso();

  const q = search.trim().toLowerCase();
  const matches = (a: SpikeAccount) => a.accountName.toLowerCase().includes(q);
  // Server already sorts each group newest-crossing-first; filtering here preserves that order.
  const filteredHot = result && q ? result.newlyHot.filter(matches) : result?.newlyHot ?? [];
  const filteredWarm = result && q ? result.newlyWarm.filter(matches) : result?.newlyWarm ?? [];
  const filteredTotal = filteredHot.length + filteredWarm.length;

  return (
    <Modal
      eyebrow="Weekly engagement spikes"
      badge={total !== null ? `${total} account${total === 1 ? "" : "s"}` : undefined}
      title="Who just heated up"
      onClose={onClose}
    >
      <div className="spike-date-row">
        <label>Week:</label>
        <ModernSelect
          value={String(selectedWeek)}
          onChange={(v) => setSelectedWeek(Number(v))}
          options={weeks.map((w) => ({ value: String(w.week), label: `Week ${w.week} (${w.start} – ${w.end})` }))}
        />
      </div>

      {result && result.date && (
        <div className="spike-search-row">
          <input
            type="text"
            className="spike-search-input"
            placeholder="Search accounts…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}

      {error && <p className="error">{error}</p>}
      {!result && !error && <p>Loading…</p>}
      {result && !result.date && (
        <p>
          No Factor Score history captured yet for this week
          {isCurrentWeek ? " - check back after tonight's sync" : ""}.
        </p>
      )}
      {result && result.date && (
        <>
          <p className="modal-summary">
            {isCurrentWeek
              ? `Updated through ${result.date} - this week is still filling in day by day`
              : `As of ${result.date}, the last day captured in this week`}
            , compared against {result.previousDate ?? "no earlier snapshot"} - both permanent, recorded history.
            Newest crossings are listed first.
          </p>
          {total === 0 && <p>No accounts crossed into Hot or Warm this week (so far).</p>}
          {total !== null && total > 0 && filteredTotal === 0 && <p>No accounts match "{search}".</p>}
          <SpikeGroup title="Newly Hot" icon="🔥" accounts={filteredHot} />
          <SpikeGroup title="Newly Warm" icon="🟠" accounts={filteredWarm} />
        </>
      )}
    </Modal>
  );
}
