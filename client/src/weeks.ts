export interface MonthWeek {
  week: number; // 1-based
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

/** The Monday on or after the given date (unchanged if it's already a Monday). */
function mondayOnOrAfter(d: Date): Date {
  const day = d.getDay(); // 0 = Sun, 1 = Mon, ...
  const delta = day === 0 ? 1 : day === 1 ? 0 : 8 - day;
  return addDays(d, delta);
}

/**
 * Monday-Sunday weeks covering every day of the given date's month, industry
 * standard "partial boundary week" convention (how Google Analytics,
 * Mixpanel, Looker, etc. bucket weeks within a month). If the 1st isn't a
 * Monday, Week 1 is the short leading stub (1st through the Sunday before
 * the first Monday); if the month doesn't end on a Sunday, the last week is
 * a short trailing stub clipped to the last day of the month. Every day of
 * the month belongs to exactly one week, none dropped.
 *
 * Example - October 2026 (1st is a Thursday):
 *   Week 1: Oct 1-4   (partial, 4 days)
 *   Week 2: Oct 5-11
 *   Week 3: Oct 12-18
 *   Week 4: Oct 19-25
 *   Week 5: Oct 26-31 (partial, 6 days)
 */
export function monthWeeks(date: Date): MonthWeek[] {
  const firstOfMonth = new Date(date.getFullYear(), date.getMonth(), 1);
  const lastOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0);

  const weeks: MonthWeek[] = [];
  let week = 1;

  const firstMonday = mondayOnOrAfter(firstOfMonth);
  if (firstMonday > firstOfMonth) {
    const partialEnd = addDays(firstMonday, -1);
    const end = partialEnd < lastOfMonth ? partialEnd : lastOfMonth;
    weeks.push({ week, start: iso(firstOfMonth), end: iso(end) });
    week++;
  }

  let cursor = firstMonday;
  while (cursor <= lastOfMonth) {
    const fullEnd = addDays(cursor, 6);
    const end = fullEnd < lastOfMonth ? fullEnd : lastOfMonth;
    weeks.push({ week, start: iso(cursor), end: iso(end) });
    cursor = addDays(cursor, 7);
    week++;
  }

  return weeks;
}

export function currentWeekNumber(weeks: MonthWeek[], todayIso: string): number {
  const match = weeks.find((w) => todayIso >= w.start && todayIso <= w.end);
  return match?.week ?? weeks[0]?.week ?? 1;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "YYYY-MM" for the given date's month - the value used throughout for the month selector. */
export function monthValueOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export interface MonthOption {
  value: string; // "YYYY-MM"
  label: string; // "October 2026"
}

/**
 * Every month from startValue through endValue (inclusive), oldest first.
 * The list grows automatically as real time passes - no manual upkeep
 * needed once a start month is picked (the month this dashboard went live).
 */
export function monthOptionsRange(startValue: string, endValue: string): MonthOption[] {
  const [startYear, startMonth] = startValue.split("-").map(Number);
  const [endYear, endMonth] = endValue.split("-").map(Number);

  const opts: MonthOption[] = [];
  let y = startYear;
  let m = startMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    opts.push({ value: `${y}-${String(m).padStart(2, "0")}`, label: `${MONTH_NAMES[m - 1]} ${y}` });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return opts;
}
