import { useEffect, useRef, useState } from "react";

export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
}

/**
 * Custom single-select dropdown styled to match the rest of this dashboard
 * (same card/menu look as the filter chips) - a native <select>'s own
 * popup can't be styled in most browsers, which is why it looked out of
 * place next to everything else here. Same value/onChange contract as a
 * native select, just with a themed trigger and an animated menu.
 */
export function ModernSelect<T extends string | number>({
  value,
  options,
  onChange,
  title,
  className,
}: {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  title?: string;
  className?: string;
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

  const current = options.find((o) => o.value === value);

  return (
    <div className={`modern-select${className ? ` ${className}` : ""}`} ref={ref}>
      <button
        className={`modern-select-trigger${open ? " open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title={title}
        type="button"
      >
        <span className="modern-select-value">{current?.label ?? ""}</span>
        <span className="modern-select-caret">▾</span>
      </button>
      {open && (
        <div className="modern-select-menu">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`modern-select-option${o.value === value ? " selected" : ""}`}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              <span className="modern-select-check">{o.value === value ? "✓" : ""}</span>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
