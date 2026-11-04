import { useEffect, useRef, useState } from "react";
import type { MonthWeek } from "../weeks";

/**
 * Week picker with checkboxes instead of a single-select, so you can combine
 * several weeks (e.g. Week 2 + Week 3) into one view - touchpoint counts sum
 * across every selected week, while the Factor Score column always reflects
 * only the most recent selected week (see App.tsx for why: Hot/Warm/Cool/Ice
 * isn't something that can be summed across weeks).
 */
export function WeekMultiSelect({
  weeks,
  monthLabel,
  selected,
  onChange,
}: {
  weeks: MonthWeek[];
  monthLabel: string;
  selected: Set<number>;
  onChange: (next: Set<number>) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const allWeekNums = weeks.map((w) => w.week);
  const isAllSelected = allWeekNums.length > 0 && allWeekNums.every((w) => selected.has(w));

  function toggleWeek(week: number) {
    const next = new Set(selected);
    if (next.has(week)) {
      if (next.size === 1) return; // always keep at least one week selected
      next.delete(week);
    } else {
      next.add(week);
    }
    onChange(next);
  }

  function selectAll() {
    onChange(new Set(allWeekNums));
  }

  const triggerLabel = isAllSelected
    ? "All weeks"
    : selected.size === 1
    ? `Week ${Array.from(selected)[0]}`
    : `${selected.size} weeks`;

  return (
    <div className="modern-select week-multiselect" ref={ref}>
      <button className={`modern-select-trigger${open ? " open" : ""}`} onClick={() => setOpen((o) => !o)} type="button">
        <span className="modern-select-value">{triggerLabel}</span>
        <span className="modern-select-caret">▾</span>
      </button>
      {open && (
        <div className="modern-select-menu">
          <button
            type="button"
            className={`modern-select-option${isAllSelected ? " selected" : ""}`}
            onClick={selectAll}
          >
            <input type="checkbox" className="col-filter-checkbox" checked={isAllSelected} readOnly />
            <span className="modern-select-option-text">
              <span className="modern-select-option-label">All weeks</span>
              <span className="modern-select-option-sublabel">{monthLabel} total</span>
            </span>
          </button>
          {weeks.map((w) => (
            <button
              key={w.week}
              type="button"
              className={`modern-select-option${selected.has(w.week) ? " selected" : ""}`}
              onClick={() => toggleWeek(w.week)}
            >
              <input type="checkbox" className="col-filter-checkbox" checked={selected.has(w.week)} readOnly />
              <span className="modern-select-option-text">
                <span className="modern-select-option-label">Week {w.week}</span>
                <span className="modern-select-option-sublabel">
                  {w.start} to {w.end}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
