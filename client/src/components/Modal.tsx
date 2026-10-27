import { ReactNode } from "react";

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
  return (
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
    </div>
  );
}
