import { useEffect, useState } from "react";
import { fetchFactorsHistory, type FactorsHistoryEntry } from "../api";
import { Modal } from "./Modal";
import { Timeline, TimelineItem } from "./Timeline";

const LEVEL_ICON: Record<string, string> = {
  Hot: "🔥",
  Warm: "🟠",
  Cool: "🧊",
  Ice: "❄️",
};

function levelClass(level: string): string {
  if (level === "Hot") return "factor-hot";
  if (level === "Warm") return "factor-warm";
  if (level === "Cool") return "factor-cool";
  if (level === "Ice") return "factor-ice";
  return "factor-unscored";
}

export function FactorsHistoryModal({
  accountId,
  accountName,
  onClose,
}: {
  accountId: string;
  accountName: string;
  onClose: () => void;
}) {
  const [history, setHistory] = useState<FactorsHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHistory(null);
    fetchFactorsHistory(accountId)
      .then((r) => !cancelled && setHistory(r.history))
      .catch((e) => !cancelled && setError(String(e.message || e)));
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // Oldest first - this is a trajectory ("Hot on Oct 28, dropped to Warm Oct
  // 29, Cold by Nov 2"), not an event log, so it should read top-to-bottom
  // like a story, unlike every other popup here which shows newest first.
  const chronological = history ? [...history].sort((a, b) => (a.date < b.date ? -1 : 1)) : [];

  return (
    <Modal
      eyebrow="Factor Score history"
      badge={history ? `${history.length} day${history.length === 1 ? "" : "s"} tracked` : undefined}
      title={accountName}
      onClose={onClose}
    >
      {error && <p className="error">{error}</p>}
      {!history && !error && <p>Loading…</p>}
      {history && history.length === 0 && (
        <p>No Factor Score data captured yet for this account - the daily tracker started Nov 1, 2026.</p>
      )}
      {history && history.length > 0 && (
        <>
          <p className="modal-summary">
            Every day this account's Factors.ai Engagement Level has been captured, oldest first -
            scroll down to see the most recent. {history.some((h) => h.isLive) && "Today's row is live from Salesforce (not yet written to history)."}
          </p>
          <Timeline>
            {chronological.map((h) => (
              <TimelineItem
                key={h.date}
                icon={LEVEL_ICON[h.level] || "⚪"}
                title={h.level || "Not yet scored"}
                subtitle={h.score !== null ? `Factors Engagement Score: ${h.score}` : undefined}
                pill={h.isLive ? `${h.date} (live)` : h.date}
                pillTone={h.isLive ? "neutral" : undefined}
                caption={
                  <span className={levelClass(h.level)}>
                    {h.isLive ? "Current, as of right now" : "Recorded history - permanent"}
                  </span>
                }
              />
            ))}
          </Timeline>
        </>
      )}
    </Modal>
  );
}
