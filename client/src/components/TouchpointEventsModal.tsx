import { useEffect, useMemo, useState } from "react";
import { fetchTouchpointEvents, TOUCHPOINTS, TOUCHPOINT_SOURCE, type DateRange, type TouchpointKey } from "../api";
import type { EmailEvent } from "../types";
import { Modal } from "./Modal";
import { Timeline, TimelineItem } from "./Timeline";
import { EmailContentModal } from "./EmailContentModal";

const TOUCHPOINT_ICON: Record<TouchpointKey, string> = {
  emailOpens: "📧",
  emailClicks: "🖱️",
  waRead: "💬",
  waReplied: "↩️",
  waClicked: "🖱️",
  mdrEmailOut: "📤",
  mdrEmailOpened: "📬",
  mdrEmailClicked: "🖱️",
  mdrEmailReplied: "↩️",
  mdrCalls: "📞",
  salesEmailOut: "📤",
  salesEmailOpened: "📬",
  salesEmailClicked: "🖱️",
  salesEmailReplied: "↩️",
  salesCalls: "📞",
};

export function TouchpointEventsModal({
  accountId,
  accountName,
  touchpoint,
  range,
  onClose,
}: {
  accountId: string;
  accountName: string;
  touchpoint: TouchpointKey;
  range: DateRange;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<EmailEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [viewingContent, setViewingContent] = useState<EmailEvent | null>(null);
  const label = TOUCHPOINTS[touchpoint];

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    fetchTouchpointEvents(accountId, touchpoint, range)
      .then((r) => !cancelled && setEvents(r.events))
      .catch((e) => !cancelled && setError(String(e.message || e)));
    return () => {
      cancelled = true;
    };
  }, [accountId, touchpoint, range.start, range.end]);

  const filtered = useMemo(() => {
    if (!events) return [];
    const q = search.trim().toLowerCase();
    return events.filter(
      (e) =>
        !q ||
        e.person.toLowerCase().includes(q) ||
        e.campaign.toLowerCase().includes(q) ||
        (e.sender || "").toLowerCase().includes(q)
    );
  }, [events, search]);

  const source = TOUCHPOINT_SOURCE[touchpoint];
  const isOutreachSourced = source === "mdr" || source === "sales";
  const isCallTouchpoint = touchpoint === "mdrCalls" || touchpoint === "salesCalls";

  return (
    <Modal
      eyebrow={label}
      badge={events ? `${events.length} event${events.length === 1 ? "" : "s"}` : undefined}
      title={`${accountName} (${range.start} to ${range.end})`}
      onClose={onClose}
    >
      {error && <p className="error">{error}</p>}
      {!events && !error && <p>Loading…</p>}
      {events && events.length === 0 && <p>No {label.toLowerCase()} recorded.</p>}
      {isOutreachSourced && events && events.length > 0 && (
        <p className="modal-summary">
          {isCallTouchpoint
            ? "Logged by Outreach.io from the rep's dialer - only the call outcome is synced, no recording or transcript."
            : "Cards with a 📄 have the full email content - click to read it. \"Opened\"/\"Clicked\" are tracking pings fired after the fact, so they don't carry a copy of the body."}
        </p>
      )}
      {events && events.length > 0 && (
        <>
          <div className="modal-search-wrap">
            <span className="modal-search-icon">🔍</span>
            <input
              className="modal-search"
              placeholder="Search by name or campaign…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {filtered.length === 0 && <p>No events match.</p>}
          {filtered.length > 0 && (
            <Timeline>
              {filtered.map((e) => (
                <TimelineItem
                  key={e.taskId}
                  icon={TOUCHPOINT_ICON[touchpoint]}
                  title={e.person}
                  titleHref={e.sfContactUrl}
                  subtitle={e.description ? `📄 ${e.campaign}` : e.campaign}
                  pill={e.date}
                  onCardClick={e.description ? () => setViewingContent(e) : undefined}
                  caption={
                    <>
                      {isOutreachSourced && e.sender && (
                        <span title={e.senderEmail || undefined}>Sent by {e.sender}</span>
                      )}
                      {e.description && <span className="timeline-card-view-hint">Click to read email ↗</span>}
                      <a href={e.sfTaskUrl} target="_blank" rel="noreferrer">
                        Open task ↗
                      </a>
                    </>
                  }
                />
              ))}
            </Timeline>
          )}
        </>
      )}
      {viewingContent && viewingContent.description && (
        <EmailContentModal
          subject={viewingContent.campaign}
          sender={viewingContent.sender}
          date={viewingContent.date}
          content={viewingContent.description}
          onClose={() => setViewingContent(null)}
        />
      )}
    </Modal>
  );
}
