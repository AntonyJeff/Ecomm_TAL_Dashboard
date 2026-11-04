import { useEffect, useRef, useState } from "react";

/**
 * Google-Sheets-style column filter: a header button that opens a checkbox
 * list of every distinct value in that column. `selected` must contain the
 * full option set to mean "no filter applied" (the caller initializes it
 * that way whenever `options` changes).
 */
export function ColumnFilter({
  label,
  options,
  selected,
  onChange,
  dotClassFor,
  subLabelFor,
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  /** Optional per-option color dot (e.g. Hot/Warm/Cool/Ice), same colors used in the Factor Score Split card. */
  dotClassFor?: (opt: string) => string | undefined;
  /** Optional per-option muted sublabel, shown right-aligned next to the option (e.g. its official score range). */
  subLabelFor?: (opt: string) => string | undefined;
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

  const active = selected.size < options.length;

  // Shows exactly what's applied right in the trigger, not just "is a
  // filter active" - picking one or two values names them; picking more
  // just gives a count, since listing them all would overflow the button.
  function selectionSummary(): string {
    if (selected.size === 0) return "None";
    if (selected.size <= 2) return Array.from(selected).join(", ");
    return `${selected.size} selected`;
  }

  function toggle(value: string) {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  }

  return (
    <div className="col-filter" ref={ref}>
      <button
        className={`col-filter-trigger${active ? " active" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title={`Filter ${label}`}
      >
        {active ? (
          <>
            {label}: {selectionSummary()}
            <span
              className="filter-chip-x"
              onClick={(e) => {
                e.stopPropagation();
                onChange(new Set(options));
              }}
            >
              ×
            </span>
          </>
        ) : (
          <>+ {label}</>
        )}
      </button>
      {open && (
        <div className="col-filter-menu">
          <div className="col-filter-actions">
            <button onClick={() => onChange(new Set(options))}>All</button>
            <button onClick={() => onChange(new Set())}>None</button>
          </div>
          <div className="col-filter-list">
            {options.map((opt) => {
              const dotClass = dotClassFor?.(opt);
              const subLabel = subLabelFor?.(opt);
              return (
                <label key={opt} className="col-filter-option">
                  <input
                    type="checkbox"
                    className="col-filter-checkbox"
                    checked={selected.has(opt)}
                    onChange={() => toggle(opt)}
                  />
                  {dotClass && <span className={`col-filter-dot ${dotClass}`} />}
                  <span className="col-filter-option-label">{opt}</span>
                  {subLabel && <span className="col-filter-count">{subLabel}</span>}
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
