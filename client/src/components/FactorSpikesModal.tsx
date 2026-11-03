import { useEffect, useMemo, useState } from "react";
import { fetchFactorSpikes, type FactorSpikesResult, type SpikeAccount } from "../api";
import { Modal } from "./Modal";
import { Timeline, TimelineItem } from "./Timeline";
import { ModernSelect } from "./ModernSelect";

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
            subtitle={`${a.fromLevel} (${a.fromScore ?? "—"}) → ${a.toLevel} (${a.toScore ?? "—"})`}
            caption={<SpikeSignals account={a} />}
          />
        ))}
      </Timeline>
    </>
  );
}

export function FactorSpikesModal({ initialDate, onClose }: { initialDate: string; onClose: () => void }) {
  const [selectedDate, setSelectedDate] = useState(initialDate);
  const [result, setResult] = useState<FactorSpikesResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    fetchFactorSpikes(selectedDate)
      .then((r) => !cancelled && setResult(r))
      .catch((e) => !cancelled && setError(String(e.message || e)));
    return () => {
      cancelled = true;
    };
  }, [selectedDate]);

  // Limited to the selected date's own calendar month, per the request that
  // clicking into a day only shows that day's own batch, not the whole
  // history - a fresh picker each month as new days accumulate.
  const monthDates = useMemo(() => {
    const month = selectedDate.slice(0, 7);
    const dates = (result?.availableDates ?? [initialDate]).filter((d) => d.startsWith(month));
    return Array.from(new Set([...dates, selectedDate])).sort();
  }, [result, selectedDate, initialDate]);

  const total = result ? result.newlyHot.length + result.newlyWarm.length : null;

  return (
    <Modal
      eyebrow="Daily engagement spikes"
      badge={total !== null ? `${total} account${total === 1 ? "" : "s"}` : undefined}
      title="Who just heated up"
      onClose={onClose}
    >
      <div className="spike-date-row">
        <label>Date:</label>
        <ModernSelect
          value={selectedDate}
          onChange={setSelectedDate}
          options={monthDates.map((d) => ({ value: d, label: d }))}
        />
      </div>

      {error && <p className="error">{error}</p>}
      {!result && !error && <p>Loading…</p>}
      {result && !result.date && <p>No Factor Score history captured yet - check back after the next daily sync.</p>}
      {result && result.date && (
        <>
          <p className="modal-summary">
            Showing {result.date}, compared against {result.previousDate ?? "no earlier snapshot"} - both
            permanent, recorded history.
          </p>
          {total === 0 && <p>No accounts crossed into Hot or Warm on this day.</p>}
          <SpikeGroup title="Newly Hot" icon="🔥" accounts={result.newlyHot} />
          <SpikeGroup title="Newly Warm" icon="🟠" accounts={result.newlyWarm} />
        </>
      )}
    </Modal>
  );
}
