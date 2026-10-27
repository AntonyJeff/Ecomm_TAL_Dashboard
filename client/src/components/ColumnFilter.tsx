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
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
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
        {label} <span className="col-filter-caret">▾</span>
      </button>
      {open && (
        <div className="col-filter-menu">
          <div className="col-filter-actions">
            <button onClick={() => onChange(new Set(options))}>All</button>
            <button onClick={() => onChange(new Set())}>None</button>
          </div>
          <div className="col-filter-list">
            {options.map((opt) => (
              <label key={opt} className="col-filter-option">
                <input type="checkbox" checked={selected.has(opt)} onChange={() => toggle(opt)} />
                {opt}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
