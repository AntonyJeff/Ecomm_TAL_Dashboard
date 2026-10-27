import { Modal } from "./Modal";
import { SCORE_METRICS } from "../score";

export function HelpModal({ onClose }: { onClose: () => void }) {
  const byWeight = (w: number) => SCORE_METRICS.filter((m) => m.weight === w).map((m) => m.label);

  return (
    <Modal title="How to read this dashboard" onClose={onClose}>
      <div className="help-content">
        <h4>Three sections: Marketing, MDR, Sales</h4>
        <p>
          The table's columns are grouped left to right into three clearly labeled sections, in the
          order the real workflow happens: <strong>Marketing</strong> (website sessions, email,
          WhatsApp, LinkedIn - what marketing ran) comes first, then <strong>MDR</strong>, then{" "}
          <strong>Sales</strong> (both from Outreach.io, your 1:1 sales engagement tool). MDR vs.
          Sales is decided by who owns the Task in Salesforce - a fixed list of named MDRs - so the
          exact same email-sent/opened/clicked/replied and call-answered touchpoints are tracked
          for both groups, just attributed to whichever team actually did the outreach. The idea:
          marketing engagement tells MDR/Sales which accounts are worth prioritizing in the first
          place, so all three stages are tracked side by side, in that sequence.
        </p>

        <h4>The Score column</h4>
        <p>
          A single 0-100 priority number so the table can be sorted into one ranked list instead of
          scanning a dozen columns by eye. It is <strong>marketing-only, by design</strong> - MDR
          and Sales activity are real columns but intentionally excluded from the score. The score's
          job is to tell MDR/Sales which accounts marketing has already warmed up; if MDR/Sales
          outreach could also raise the score, an account could score itself up just by getting
          called or emailed, which defeats the point of using it to decide who to reach out to.
        </p>
        <p>
          This is <strong>not</strong> a plain average: each marketing metric is first converted to
          a percentile rank (where does this account stand vs. every other account this week?),
          because raw counts aren't comparable across channels - a LinkedIn impression count in the
          hundreds and a WhatsApp reply count of 0 or 1 can't just be averaged together without the
          bigger number drowning out the more meaningful one.
        </p>
        <p>
          Each metric is also weighted by how much buying intent it signals, not just how often it
          happens:
        </p>
        <p>
          <strong>Weight 3</strong> (active, effortful response): {byWeight(3).join(", ")}
          <br />
          <strong>Weight 2</strong> (engaged but passive): {byWeight(2).join(", ")}
          <br />
          <strong>Weight 1</strong> (passive/algorithmic exposure): {byWeight(1).join(", ")}
        </p>
        <p>
          The score is the weighted average of those percentiles, 0-100. Green (66+) = this
          week's hottest accounts, amber (33-65) = moderate, pink (under 33) = little to no
          engagement this week. Use the "Top accounts by: Engagement Score" sort (the default) to
          see the full ranked list, or switch to any single metric in that same dropdown - including
          MDR/Sales ones - to answer a narrower question like "who got the most WhatsApp clicks this
          week."
        </p>

        <h4>Frozen columns: Account, Domain, # Contacts</h4>
        <p>
          Only these three stay in place while you scroll right - they're identifiers, not metrics.
          Everything else, including the Score, scrolls normally since it's measuring something
          rather than naming something.
        </p>

        <h4>The Week selector (top left)</h4>
        <p>
          Weeks run Monday-Sunday and cover every day of the month, so the first and last week of
          a month can be short (e.g. Oct 1-4, then Oct 5-11, ... Oct 26-31) - nothing is ever left
          out of a week. This selector controls <strong>Contacts, Website Sessions, Email, and
          WhatsApp</strong>: exact, real numbers for whichever week you pick. Click any number in
          the table to see exactly who or what made it up.
        </p>

        <h4>
          The <span className="linkedin-col-header-sample">shaded LinkedIn columns (7d)</span>
        </h4>
        <p>
          LinkedIn works differently and is <strong>not</strong> tied to the Week selector's exact
          dates. LinkedIn's data provider doesn't run on a weekly schedule - new numbers show up
          every 4-6 days, whenever they happen to be ready (confirmed directly with their team),
          and each export is always a <strong>trailing 7-day window</strong> as of its own date,
          not the calendar week you picked. That window also doesn't land the day it ends - e.g.
          a window covering Oct 5-11 might not actually be pushed into the sheet until Oct 13. So
          "available by the end of your selected week" is judged by the date it was{" "}
          <strong>actually pushed</strong>, not the dates the window covers - otherwise a week
          could show LinkedIn numbers that, in reality, hadn't landed yet by that week's end. The
          note above the table always states both: the real 7-day date range, and the date it was
          pushed. Hover over any LinkedIn column heading for the same detail.
        </p>

        <h4>One rule for LinkedIn: never calculate a "change"</h4>
        <p>
          Don't subtract one week's LinkedIn number from another's to get a trend - LinkedIn's
          windows overlap each other, so that math double-counts. Read each LinkedIn figure as its
          own standalone snapshot, not a point on a trend line.
        </p>

        <h4>The 15-day staleness cutoff</h4>
        <p>
          If no LinkedIn export has landed in the 15 days before the end of your selected week, the
          LinkedIn columns show a dash instead of a number. This isn't a bug - it means the data is
          too old to trust, so the dashboard refuses to guess rather than silently showing a
          month-old figure as if it were current.
        </p>
      </div>
    </Modal>
  );
}
