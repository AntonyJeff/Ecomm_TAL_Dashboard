import { useEffect, useMemo, useState } from "react";
import { fetchWebsiteSessionEvents, type DateRange, type WebsiteSessionEvent } from "../api";
import { Modal } from "./Modal";
import { Timeline, TimelineItem } from "./Timeline";

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

export function WebsiteSessionsModal({
  accountId,
  accountName,
  range,
  onClose,
}: {
  accountId: string;
  accountName: string;
  range: DateRange;
  onClose: () => void;
}) {
  const [data, setData] = useState<{
    sessionCount: number;
    totalDurationSec: number;
    highIntentCount: number;
    mediumIntentCount: number;
    events: WebsiteSessionEvent[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    setData(null);
    fetchWebsiteSessionEvents(accountId, range)
      .then((r) => !cancelled && setData(r))
      .catch((e) => !cancelled && setError(String(e.message || e)));
    return () => {
      cancelled = true;
    };
  }, [accountId, range.start, range.end]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.events.filter(
      (e) =>
        !q ||
        e.firstPageUrl.toLowerCase().includes(q) ||
        e.latestPageUrl.toLowerCase().includes(q)
    );
  }, [data, search]);

  return (
    <Modal
      eyebrow="Website sessions"
      badge={data ? `${data.sessionCount} session${data.sessionCount === 1 ? "" : "s"}` : undefined}
      title={`${accountName} (${range.start} to ${range.end})`}
      onClose={onClose}
    >
      {error && <p className="error">{error}</p>}
      {!data && !error && <p>Loading…</p>}
      {data && data.events.length === 0 && <p>No website sessions recorded in this range.</p>}
      {data && data.events.length > 0 && (
        <>
          <p className="modal-summary">
            {data.sessionCount} session{data.sessionCount === 1 ? "" : "s"} · total time on site:{" "}
            {formatDuration(data.totalDurationSec)}
            {data.highIntentCount > 0 && (
              <>
                {" "}
                · <span className="high-intent-text">🔥 {data.highIntentCount} high-intent</span>
              </>
            )}
            {data.mediumIntentCount > 0 && (
              <>
                {" "}
                · <span className="medium-intent-text">☀️ {data.mediumIntentCount} medium-intent</span>
              </>
            )}
          </p>
          <div className="modal-search-wrap">
            <span className="modal-search-icon">🔍</span>
            <input
              className="modal-search"
              placeholder="Search by page URL…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {filtered.length === 0 && <p>No sessions match.</p>}
          {filtered.length > 0 && (
            <Timeline>
              {filtered.map((e, i) => (
                <TimelineItem
                  key={i}
                  icon={e.highIntent ? "🔥" : e.mediumIntent ? "☀️" : "🌐"}
                  title={formatDuration(e.durationSec)}
                  subtitle={`${e.firstPageUrl || "—"} → ${e.latestPageUrl || "—"}`}
                  pill={e.date}
                  caption={
                    e.highIntent ? (
                      <span className="high-intent-text">High-intent page visited</span>
                    ) : e.mediumIntent ? (
                      <span className="medium-intent-text">Medium-intent page visited</span>
                    ) : undefined
                  }
                />
              ))}
            </Timeline>
          )}
        </>
      )}
    </Modal>
  );
}
