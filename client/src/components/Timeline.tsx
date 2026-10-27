import type { ReactNode } from "react";

export function Timeline({ children }: { children: ReactNode }) {
  return <div className="timeline">{children}</div>;
}

export function TimelineItem({
  icon,
  title,
  titleHref,
  subtitle,
  caption,
  pill,
  pillTone = "neutral",
  onCardClick,
}: {
  icon: ReactNode;
  title: string;
  titleHref?: string;
  subtitle?: string;
  caption?: ReactNode;
  pill?: string;
  pillTone?: "neutral" | "good" | "bad";
  /** Makes the whole card clickable (e.g. "open this email's content") - independent of titleHref, which stays a normal link. */
  onCardClick?: () => void;
}) {
  return (
    <div className="timeline-item">
      <div className="timeline-rail">
        <div className="timeline-marker">{icon}</div>
        <div className="timeline-line" />
      </div>
      <div
        className={`timeline-card${onCardClick ? " timeline-card-clickable" : ""}`}
        onClick={onCardClick}
        role={onCardClick ? "button" : undefined}
        tabIndex={onCardClick ? 0 : undefined}
        onKeyDown={
          onCardClick
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onCardClick();
                }
              }
            : undefined
        }
      >
        <div className="timeline-card-top">
          <div className="timeline-card-title" title={title}>
            {titleHref ? (
              <a href={titleHref} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                {title}
              </a>
            ) : (
              title
            )}
          </div>
          {pill && <span className={`timeline-pill timeline-pill-${pillTone}`}>{pill}</span>}
        </div>
        {subtitle && (
          <div className="timeline-card-subtitle" title={subtitle}>
            {subtitle}
          </div>
        )}
        {caption && (
          <div className="timeline-card-caption" onClick={(e) => e.stopPropagation()}>
            {caption}
          </div>
        )}
      </div>
    </div>
  );
}
