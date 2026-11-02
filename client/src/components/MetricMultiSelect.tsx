import { useEffect, useRef, useState } from "react";

export interface MetricOption {
  key: string;
  label: string;
  group: string;
}

/**
 * Grouped checkbox dropdown for picking several "top accounts by" metrics at
 * once (e.g. "most email opens" AND "most website sessions" together),
 * instead of only being able to apply one quick-sort at a time.
 */
export function MetricMultiSelect({
  options,
  selected,
  onChange,
  defaultLabel,
}: {
  options: MetricOption[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  defaultLabel: string;
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

  function toggle(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  }

  const groups = Array.from(new Set(options.map((o) => o.group)));
  const triggerLabel =
    selected.size === 0
      ? defaultLabel
      : selected.size === 1
      ? `Engagement: ${options.find((o) => selected.has(o.key))?.label}`
      : `Engagement: ${selected.size} metrics`;

  return (
    <div className="col-filter" ref={ref}>
      <button
        className="col-filter-trigger active"
        onClick={() => setOpen((o) => !o)}
        title="Pick one or more metrics to rank accounts by - combine as many as you want"
      >
        {triggerLabel}
        {selected.size > 0 && (
          <span
            className="filter-chip-x"
            onClick={(e) => {
              e.stopPropagation();
              onChange(new Set());
            }}
          >
            ×
          </span>
        )}
      </button>
      {open && (
        <div className="col-filter-menu metric-multiselect-menu">
          <div className="col-filter-actions">
            <button onClick={() => onChange(new Set())}>Clear</button>
          </div>
          <div className="col-filter-list">
            {groups.map((group) => (
              <div key={group}>
                <div className="col-filter-group-label">{group}</div>
                {options
                  .filter((o) => o.group === group)
                  .map((o) => (
                    <label key={o.key} className="col-filter-option">
                      <input type="checkbox" checked={selected.has(o.key)} onChange={() => toggle(o.key)} />
                      {o.label}
                    </label>
                  ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
