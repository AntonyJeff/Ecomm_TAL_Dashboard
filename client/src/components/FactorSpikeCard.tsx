import { useEffect, useState } from "react";
import { fetchFactorSpikes } from "../api";
import { FactorSpikesModal } from "./FactorSpikesModal";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Bento-grid version of the daily spike alert (see FactorSpikeBanner for the
 * full reasoning on why this never shows a live/mid-day "today" - same data,
 * same rule, just restyled to sit as one of the four top cards instead of a
 * full-width banner).
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
  const asOfLabel = date ? (date === todayIso() ? "today" : `as of ${date}`) : "";

  return (
    <div className={`bento-card bento-spike${total && total > 0 ? " bento-spike-active" : ""}`}>
      <div className="bento-card-top">
        <span className="bento-card-label">Daily spikes</span>
        <span className="bento-icon-badge bento-icon-spike">⚡</span>
      </div>

      {error && <div className="bento-card-value">—</div>}
      {!error && total === null && <div className="bento-card-value">…</div>}
      {!error && total !== null && (
        <>
          <div className="bento-card-value">{total}</div>
          <div className="bento-spike-breakdown">
            {hotCount! > 0 && (
              <span>
                🔥 {hotCount} Hot
              </span>
            )}
            {warmCount! > 0 && (
              <span>
                🟠 {warmCount} Warm
              </span>
            )}
            {total === 0 && <span>No major engagement spikes</span>}
          </div>
          <button className="bento-cta" onClick={() => setOpen(true)} disabled={!date}>
            Click for details and why →
          </button>
        </>
      )}
      <div className="bento-card-caption">{asOfLabel || "no sync yet"}</div>

      {open && date && <FactorSpikesModal initialDate={date} onClose={() => setOpen(false)} />}
    </div>
  );
}
