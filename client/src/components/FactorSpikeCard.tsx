import { useEffect, useState } from "react";
import { fetchFactorSpikes } from "../api";
import { FactorSpikesModal } from "./FactorSpikesModal";
import { monthWeeks, currentWeekNumber } from "../weeks";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Compact weekly spike card (see FactorSpikeBanner for the full reasoning on
 * why this is scoped to the current week and never shows a live/mid-day
 * "today" - same data, same rule, just restyled per the reference mockup: a
 * number, a one-line breakdown, and a text link instead of a button).
 */
export function FactorSpikeCard() {
  const [hotCount, setHotCount] = useState<number | null>(null);
  const [warmCount, setWarmCount] = useState<number | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const weeks = monthWeeks(new Date());
    const week = weeks.find((w) => w.week === currentWeekNumber(weeks, todayIso())) ?? weeks[weeks.length - 1];
    fetchFactorSpikes({ start: week.start, end: week.end })
      .then((r) => {
        if (cancelled) return;
        setHotCount(r.newlyHot.length);
        setWarmCount(r.newlyWarm.length);
        setDate(r.date);
      })
      .catch((e) => !cancelled && setError(String(e.message || e)));
    return () => {
      cancelled = true;
    };
  }, []);

  const total = hotCount !== null && warmCount !== null ? hotCount + warmCount : null;
  const isToday = date === todayIso();
  const dateSuffix = date ? (isToday ? "Today" : date) : "";

  return (
    <div className="bento-card">
      <div className="bento-card-top">
        <span className="bento-card-label">Weekly spikes{dateSuffix ? ` · ${dateSuffix}` : ""}</span>
      </div>

      {error && <div className="spike-card-value">—</div>}
      {!error && total === null && <div className="spike-card-value">…</div>}
      {!error && total !== null && (
        <>
          <div className="spike-card-value">{total}</div>
          <div className="spike-card-breakdown">
            {total === 0
              ? "No major engagement spikes"
              : [hotCount! > 0 ? `${hotCount} Hot` : null, warmCount! > 0 ? `${warmCount} Warm` : null]
                  .filter(Boolean)
                  .join(" · ")}
          </div>
          <button className="spike-card-link" onClick={() => setOpen(true)}>
            View spikes and reasons →
          </button>
        </>
      )}

      {open && <FactorSpikesModal onClose={() => setOpen(false)} />}
    </div>
  );
}
