import { useEffect, useState } from "react";
import { fetchFactorSpikes } from "../api";
import { FactorSpikesModal } from "./FactorSpikesModal";

/**
 * Daily "who just heated up" banner - fetched once per page load, every day,
 * so whoever opens the dashboard first thing in the morning sees it without
 * digging through filters. Clicking it opens the full breakdown, with a date
 * picker scoped to the current month so yesterday's batch stays its own
 * fixed, separate thing from today's.
 */
export function FactorSpikeBanner() {
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

  if (error) return null; // non-critical widget - fail quietly rather than block the whole dashboard
  if (hotCount === null || warmCount === null) return null; // still loading - nothing to show yet

  const total = hotCount + warmCount;

  return (
    <>
      <button className={`spike-banner${total > 0 ? " spike-banner-active" : ""}`} onClick={() => setOpen(true)}>
        {total === 0 ? (
          <>No major engagement spikes today - click to check any day this month</>
        ) : (
          <>
            {hotCount > 0 && (
              <span>
                🔥 <strong>{hotCount}</strong> account{hotCount === 1 ? "" : "s"} just went Hot
              </span>
            )}
            {hotCount > 0 && warmCount > 0 && <span className="spike-banner-sep">·</span>}
            {warmCount > 0 && (
              <span>
                🟠 <strong>{warmCount}</strong> jumped to Warm
              </span>
            )}
            <span className="spike-banner-cta">Click for details and why →</span>
          </>
        )}
      </button>
      {open && date && <FactorSpikesModal initialDate={date} onClose={() => setOpen(false)} />}
    </>
  );
}
