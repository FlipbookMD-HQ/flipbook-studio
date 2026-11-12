import { Link } from "react-router-dom";
import type { SlideDoc, Violation } from "../../shared/api";

/** A slide's violations. Violations name slides by source (a manifest path, or "slide N"). */
export function violationsFor(violations: Violation[], slide: Pick<SlideDoc, "source">): Violation[] {
  return violations.filter((violation) => violation.source === slide.source);
}

const plural = (count: number) => `${count} blueprint issue${count === 1 ? "" : "s"}`;

/** A count badge for a slide row or thumbnail. Renders nothing when the slide is clean. */
export function ViolationBadge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span
      className="violation-badge"
      title={plural(count)}
      aria-label={plural(count)}
      data-testid="violation-badge"
    >
      {count}
    </span>
  );
}

/**
 * The deck header's check panel. Each message is exactly what `flipbook check` prints; a message
 * that names a slide links to it. Hidden for decks without a blueprint.
 */
export function ViolationsPanel({
  deckId,
  slides,
  violations,
  hasBlueprint,
  currentSlideId,
}: {
  deckId: string;
  slides: SlideDoc[];
  violations: Violation[];
  hasBlueprint: boolean;
  currentSlideId?: string;
}) {
  if (!hasBlueprint) return null;
  if (!violations.length) {
    return (
      <p className="check-ok" role="status" data-testid="check-panel">
        Matches the blueprint.
      </p>
    );
  }
  return (
    <section className="check-panel" aria-labelledby="check-title" data-testid="check-panel">
      <h2 id="check-title">{plural(violations.length)}</h2>
      <ul>
        {violations.map((violation, index) => {
          const slide = slides.find((item) => item.source === violation.source);
          return (
            <li key={`${index}:${violation.message}`} data-code={violation.code}>
              {slide && slide.id !== currentSlideId ? (
                <Link to={`/decks/${deckId}/slides/${encodeURIComponent(slide.id)}`}>
                  {violation.message}
                </Link>
              ) : (
                <span>{violation.message}</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The open slide's violations, shown above its fields. */
export function SlideViolations({ violations }: { violations: Violation[] }) {
  if (!violations.length) return null;
  return (
    <ul
      className="slide-violations"
      aria-label="Blueprint issues on this slide"
      data-testid="slide-violations"
    >
      {violations.map((violation, index) => (
        <li key={`${index}:${violation.message}`} data-code={violation.code}>
          {violation.message}
        </li>
      ))}
    </ul>
  );
}
