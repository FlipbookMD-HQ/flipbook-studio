import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { ApiRequestError, getDeck } from "../api";
import { ErrorNotice, Shell } from "./Shell";

export function DeckScreen() {
  const { id = "" } = useParams();
  const deck = useQuery({ queryKey: ["deck", id], queryFn: () => getDeck(id) });

  if (deck.isPending) return <Shell>Loading deck…</Shell>;
  if (deck.isError) {
    const error =
      deck.error instanceof ApiRequestError
        ? deck.error.error
        : { code: "INTERNAL" as const, message: deck.error.message };
    return (
      <Shell>
        <ErrorNotice error={error} />
      </Shell>
    );
  }

  const { title, path, slides } = deck.data;
  return (
    <Shell crumb={path}>
      <h1>{title}</h1>
      <ol className="slide-grid">
        {slides.map((slide) => (
          <li key={slide.id} className="slide-thumb" data-testid="slide-thumb">
            <Link to={`/decks/${deck.data.id}/slides/${encodeURIComponent(slide.id)}`} className="thumb-link">
              <div className="frame">
                {/* Rendered slide HTML only ever appears here: no allow-scripts, no allow-same-origin. */}
                <iframe
                  title={`Slide ${slide.index + 1}: ${slide.title}`}
                  sandbox=""
                  srcDoc={slide.html}
                  loading="lazy"
                />
              </div>
              <p className="meta">
                {slide.index + 1}. {slide.title || "Untitled"}
              </p>
            </Link>
          </li>
        ))}
      </ol>
    </Shell>
  );
}
