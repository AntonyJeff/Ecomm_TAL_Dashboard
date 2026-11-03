import { useEffect, useState } from "react";
import { fetchFactorSpikes } from "../api";
import { FactorSpikesModal } from "./FactorSpikesModal";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Compact daily spike card (see FactorSpikeBanner on main for the full
 * reasoning on why this never shows a live/mid-day "today" - same data,
 * same rule, just restyled per the reference mockup: a number, a one-line
 * breakdown, and a text link instead of a button).
 */
export function FactorSpikeCard() {
  const [hotCount, setHotCount] = useState<number | null>(null);
  const [warmCount, setWarmCount] = useState<number | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchFactorSpikes()
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
        <span className="bento-card-label">Daily spikes{dateSuffix ? ` · ${dateSuffix}` : ""}</span>
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
          <button className="spike-card-link" onClick={() => setOpen(true)} disabled={!date}>
            View spikes and reasons →
          </button>
        </>
      )}

      {open && date && <FactorSpikesModal initialDate={date} onClose={() => setOpen(false)} />}
    </div>
  );
}
