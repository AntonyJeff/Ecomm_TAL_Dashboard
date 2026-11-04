import { useEffect, useState } from "react";
import { fetchFactorSpikes } from "../api";
import { FactorSpikesModal } from "./FactorSpikesModal";
import { monthWeeks, currentWeekNumber } from "../weeks";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * "Who just heated up" banner for the week in progress - fetched once per
 * page load, every day, so whoever opens the dashboard first thing in the
 * morning sees it without digging through filters. Clicking it opens the
 * full breakdown, with a Week picker (same Week 1/2/3... boundaries as the
 * rest of the dashboard) so earlier weeks stay their own fixed, separate
 * thing from the week still in progress.
 *
 * Always shows the most recently SYNCED day within the current week, never
 * today mid-day - a spike is a batch day-over-day comparison, and until
 * tonight's run actually happens there's no "today" result yet to show (see
 * the server's comment on computeFactorSpikes). The moment tonight's sync
 * lands, this same request naturally starts reflecting it - no separate step
 * needed.
 */
export function FactorSpikeBanner() {
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

  if (error) return null; // non-critical widget - fail quietly rather than block the whole dashboard
  if (hotCount === null || warmCount === null) return null; // still loading, or no sync has ever run

  const total = hotCount + warmCount;
  const asOfLabel = date ? (date === todayIso() ? "today" : `as of ${date}`) : "this week";

  return (
    <>
      <button className={`spike-banner${total > 0 ? " spike-banner-active" : ""}`} onClick={() => setOpen(true)}>
        {total === 0 ? (
          <>No major engagement spikes this week so far - click to browse by week</>
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
            <span className="spike-banner-sep">({asOfLabel})</span>
            <span className="spike-banner-cta">Click for details and why →</span>
          </>
        )}
      </button>
      {open && <FactorSpikesModal onClose={() => setOpen(false)} />}
    </>
  );
}
