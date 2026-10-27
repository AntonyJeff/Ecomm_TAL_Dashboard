import { useEffect, useMemo, useState } from "react";
import { fetchContacts, type ContactsSummary, type DateRange } from "../api";
import type { ContactRow } from "../types";
import { personaTier } from "../persona";
import { Modal } from "./Modal";
import { Timeline, TimelineItem } from "./Timeline";

export function ContactsModal({
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
  const [contacts, setContacts] = useState<ContactRow[] | null>(null);
  const [summary, setSummary] = useState<ContactsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    setContacts(null);
    fetchContacts(accountId, range)
      .then((r) => {
        if (cancelled) return;
        setContacts(r.contacts);
        setSummary(r.summary);
      })
      .catch((e) => !cancelled && setError(String(e.message || e)));
    return () => {
      cancelled = true;
    };
  }, [accountId, range.start, range.end]);

  const sorted = useMemo(() => {
    if (!contacts) return [];
    const q = search.trim().toLowerCase();
    return contacts
      .filter((c) => !q || c.Name.toLowerCase().includes(q) || (c.Title || "").toLowerCase().includes(q))
      .sort((a, b) => {
        const tierDiff = personaTier(b.Title) - personaTier(a.Title);
        if (tierDiff !== 0) return tierDiff;
        return a.Name.localeCompare(b.Name);
      });
  }, [contacts, search]);

  return (
    <Modal
      eyebrow="Contacts"
      badge={contacts ? `${contacts.length} contact${contacts.length === 1 ? "" : "s"}` : undefined}
      title={`${accountName} (week of ${range.start} to ${range.end})`}
      onClose={onClose}
    >
      {error && <p className="error">{error}</p>}
      {!contacts && !error && <p>Loading…</p>}
      {contacts && (
        <>
          {summary && (
            <p className="modal-summary">
              {summary.total} total · {summary.active} active (touched this week) ·{" "}
              {summary.inactive} inactive ·{" "}
              <strong className={summary.inactivePct >= 50 ? "pct-bad" : "pct-ok"}>
                {summary.inactivePct}% inactive
              </strong>
            </p>
          )}
          <div className="modal-search-wrap">
            <span className="modal-search-icon">🔍</span>
            <input
              className="modal-search"
              placeholder="Search by name or title…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {sorted.length === 0 && <p>No contacts match.</p>}
          {sorted.length > 0 && (
            <Timeline>
              {sorted.map((c) => (
                <TimelineItem
                  key={c.Id}
                  icon={personaTier(c.Title) > 0 ? "★" : "👤"}
                  title={c.Name}
                  titleHref={c.sfUrl}
                  subtitle={c.Title || "No title on file"}
                  pill={c.active === null ? undefined : c.active ? "Active" : "Inactive"}
                  pillTone={c.active === null ? "neutral" : c.active ? "good" : "bad"}
                  caption={
                    <>
                      {c.Email && <span title={c.Email}>{c.Email}</span>}
                      <a href={c.sfUrl} target="_blank" rel="noreferrer">
                        Open in Salesforce ↗
                      </a>
                    </>
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
