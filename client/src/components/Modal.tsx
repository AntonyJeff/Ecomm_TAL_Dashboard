import { ReactNode } from "react";
import { createPortal } from "react-dom";

export function Modal({
  eyebrow,
  badge,
  title,
  onClose,
  children,
}: {
  /** Small colored label above the title, e.g. "CONTACTS", "EMAIL OPENS". */
  eyebrow?: string;
  /** Count pill next to the eyebrow, e.g. "24 contacts". */
  badge?: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  // Rendered into document.body rather than in place - a `position: fixed`
  // backdrop gets trapped inside the bounds of any ancestor with a `transform`
  // (e.g. a card's hover-lift effect), which shrinks the modal down to that
  // card's box instead of covering the screen. A portal sidesteps that
  // entirely, regardless of what this is opened from.
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-header-text">
            {(eyebrow || badge) && (
              <div className="modal-eyebrow-row">
                {eyebrow && <span className="modal-eyebrow">{eyebrow}</span>}
                {badge && <span className="modal-badge">{badge}</span>}
              </div>
            )}
            <h3 title={title}>{title}</h3>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body
  );
}
