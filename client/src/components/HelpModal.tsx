import { Modal } from "./Modal";
import { SCORE_METRICS } from "../score";

export function HelpModal({ onClose }: { onClose: () => void }) {
  const summedMetricLabels = SCORE_METRICS.map((m) => m.label).join(", ");

  return (
    <Modal title="How to read this dashboard" onClose={onClose}>
      <div className="help-content">
        <h4>🔥 High-intent and ☀️ medium-intent website visits</h4>
        <p>
          Pulled from the Factors.ai website scoring sheet, which grades every page on the site
          High, Medium, or Low intent. Pages like pricing, request-demo, contact-us, and compare are
          High; product/channel/industry pages are mostly Medium; blog/newsroom/about-us are Low
          (nothing shown for Low - it's not meant to be a signal). If an account's entry or exit
          page on any session this period matches High, its <strong># Website sessions</strong>{" "}
          number glows orange with a 🔥; Medium glows gold with a ☀️ instead. High always wins if a
          session matches both. Inside the Website Sessions popup, each individual session that
          matches is flagged the same way, so you can see exactly which visit triggered it.
        </p>
        <p>
          Both are also checkboxes inside the <strong>Engagement filter</strong> dropdown (next to
          Potential MRR) - check one to instantly narrow the whole table down to only accounts that
          visited that intent tier this period, built for a daily glance rather than digging
          through filters.
        </p>

        <h4>Four sections: Marketing, MDR, SDR, Sales</h4>
        <p>
          The table's columns are grouped left to right into four clearly colored sections, in the
          order the real workflow happens: <strong>Marketing</strong> (website sessions, email,
          WhatsApp, LinkedIn - what marketing ran) comes first, then <strong>MDR</strong>, then{" "}
          <strong>SDR</strong>, then <strong>Sales</strong> (MDR/SDR/Sales all come from
          Outreach.io, your 1:1 sales engagement tool). Which of the three a touch belongs to is
          decided by who owns the Task in Salesforce - fixed lists of named MDRs and SDRs, with
          every other owner falling under Sales - so the exact same email-sent/opened/clicked/
          replied and call-answered touchpoints are tracked for all three groups, just attributed
          to whichever team actually did the outreach. The idea: marketing engagement tells
          MDR/SDR/Sales which accounts are worth prioritizing in the first place, so all four
          stages are tracked side by side, in that sequence.
        </p>
        <p>
          These counts include activity logged against both <strong>Contacts and Leads</strong> for
          the account - e.g. an event attendee MDR/SDR is working before they've been converted to a
          Contact. Click into any touchpoint's popup and a name tagged <strong>(Lead)</strong> shows
          exactly which of its events came from that pre-conversion activity.
        </p>
        <p>
          <strong>Calls</strong> count both ways a call gets recorded: Outreach.io's own dialer
          (synced only once a call actually connects) and a rep manually logging a Zoom Phone call
          in Salesforce (no disposition data, so every logged one counts). A separate{" "}
          <strong>WhatsApp calls</strong> column tracks the same idea for calls a rep makes from
          their own personal WhatsApp number instead of a phone line - manually logged the same way.
          A bare "Call" entry with no number or app name is just a duplicate confirmation of one of
          those two, not a separate call, so it's intentionally not counted.
        </p>

        <h4>The Score column</h4>
        <p>
          A single 0-100 priority number so the table can be sorted into one ranked list instead of
          scanning a dozen columns by eye. It is <strong>marketing-only, by design</strong> - MDR,
          SDR, and Sales activity are real columns but intentionally excluded from the score. The
          score's job is to tell MDR/SDR/Sales which accounts marketing has already warmed up; if
          their own outreach could also raise the score, an account could score itself up just by
          getting called or emailed, which defeats the point of using it to decide who to reach out
          to.
        </p>
        <p>
          It's a <strong>plain sum</strong>, not an average or a 0-100 index: add up every one of
          these raw counts for the selected week - {summedMetricLabels}.
        </p>
        <p>
          <strong>LinkedIn is the one exception</strong>, scored with its own weighted formulas
          instead of being added in as raw counts - a single impression or like is far weaker
          evidence of interest than a click or a reply, and summing it directly would let a number
          in the hundreds or thousands drown out every other metric.
        </p>
        <p>
          <strong>LinkedIn paid score</strong> = (paid impressions / 500) + (paid clicks × 3). A
          paid click is a deliberate, costly action - the account left the ad to visit the site -
          so it's weighted heavily; impressions are a cheap reach signal worth 1 point per 500.
        </p>
        <p>
          <strong>LinkedIn organic score</strong> = (organic impressions / 500) + (√organic
          engagement × 3). Organic engagement (likes/comments/shares combined) is a much weaker,
          higher-volume signal than a paid click, so a square root is used instead of a straight
          multiply - going from 10 to 1,000 engagements no longer multiplies the score by 100x,
          since raw engagement volume isn't linearly proportional to buying intent.
        </p>
        <p>
          The number shown is this exact sum - uncapped, so there's no fixed "good" number to
          memorize. The pill's color instead reflects where that sum ranks <strong>relative to all
          other accounts this week</strong>: green = this week's hottest third, amber = the middle
          third, pink = the bottom third. Leave the <strong>Engagement filter</strong> dropdown
          empty to sort by this Score (the default), or check specific metrics in it for a narrower
          question like "who got the most WhatsApp clicks this week."
        </p>
        <p>
          That dropdown deliberately only lists <strong>clicked, replied, and answered-call</strong>{" "}
          signals (plus the two intent tiers above) - not "opened," "sent," "read," or raw LinkedIn
          impressions. Those lower-value signals still have their own dedicated column to check
          manually, but they're left out of this quick filter since they don't indicate the
          prospect actually did anything.
        </p>

        <h4>Frozen columns: Account, Domain, Owner, # Contacts, Score</h4>
        <p>
          These five stay in place while you scroll right. The first four are identifiers, not
          metrics. Score is the one exception - it IS a metric, but it's frozen alongside them
          anyway because it's the deciding factor for prioritizing accounts, not just one more
          number to scroll past. Everything to the right of it (Website Sessions, Email, WhatsApp,
          LinkedIn, MDR/SDR/Sales) scrolls normally.
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
