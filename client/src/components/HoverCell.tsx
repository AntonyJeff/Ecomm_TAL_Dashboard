import { useRef, useState } from "react";

/**
 * Truncated cell that shows the full text (selectable/copyable, not a native
 * title tooltip) on hover - but ONLY when the text is actually cut off.
 * Short text that already fits has nothing to reveal, so showing an empty-
 * looking tooltip box for it was just visual clutter.
 */
export function HoverCell({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);

  function checkTruncation() {
    const el = ref.current;
    if (el) setTruncated(el.scrollWidth > el.clientWidth);
  }

  return (
    <span className={`hover-cell ${className ?? ""}`} onMouseEnter={checkTruncation}>
      <span className="hover-cell-truncated" ref={ref}>
        {text}
      </span>
      {truncated && <span className="hover-cell-tooltip">{text}</span>}
    </span>
  );
}
