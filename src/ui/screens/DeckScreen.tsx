import { useQuery } from "@tanstack/react-query";
import { useState, type CSSProperties } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { ViolationBadge, ViolationsPanel, violationsFor } from "./Violations";
import { ApiRequestError, getDeck } from "../api";
import { ErrorNotice, Shell } from "./Shell";
import { DeckActions } from "./DeckActions";
import { ImagesPanel } from "./ImagesPanel";
import { DuplicateDeckButton } from "./Duplicate";
import { GeneratedUsageNotice } from "./GenerateProgress";

export function DeckScreen() {
  const { id = "" } = useParams();
  const deck = useQuery({ queryKey: ["deck", id], queryFn: () => getDeck(id) });
  // US-20: after Duplicate, say where the copy came from and which symlinks it left out.
  const duplicated = useLocation().state as { duplicatedFrom?: string; skipped?: string[] } | null;
  const [view, setView] = useState<"grid" | "list">("grid");
  const [zoom, setZoom] = useState(1);

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

  const { title, path, slides, violations, hasBlueprint } = deck.data;
  const segments = path.split("/").filter(Boolean);
  const slideUrl = (slideId: string) => `/decks/${deck.data.id}/slides/${encodeURIComponent(slideId)}`;
  return (
    <Shell
      wide
      crumb={path}
      status={
        <span>
          {slides.length} {slides.length === 1 ? "slide" : "slides"}
          {hasBlueprint ? ` · ${violations.length} violations` : ""}
        </span>
      }
      actions={
        <>
          <DuplicateDeckButton deckId={deck.data.id} />
          <DeckActions deckId={deck.data.id} slideIndex={0} />
        </>
      }
    >
      <header className="deck-head">
        <p className="breadcrumb mono">
          {segments.map((part, i) => (
            <span key={i} className={i === segments.length - 1 ? "current" : undefined}>
              {part}
            </span>
          ))}
        </p>
        <div className="deck-title-row">
          <h1>{title}</h1>
          <span className="chip mono">
            {deck.data.kind === "folder" ? "Folder deck" : "Single file"} · {slides.length}{" "}
            {slides.length === 1 ? "slide" : "slides"}
          </span>
          {hasBlueprint && violations.length ? (
            <span className="tag danger">
              ⚠ {violations.length} blueprint {violations.length === 1 ? "violation" : "violations"}
            </span>
          ) : null}
        </div>
        <div className="toolbar" role="toolbar" aria-label="Deck view">
          <div className="segmented">
            <button type="button" aria-pressed={view === "grid"} onClick={() => setView("grid")}>
              Slide sorter
            </button>
            <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>
              List view
            </button>
          </div>
          {slides[0] ? (
            <Link className="button-like" to={slideUrl(slides[0].id)}>
              Open editor
            </Link>
          ) : null}
          <a className="button-like" href="#deck-assets">
            Asset manager
          </a>
        </div>
      </header>
      <GeneratedUsageNotice />
      {duplicated?.duplicatedFrom != null ? (
        <div className="notice" role="status" data-testid="duplicated-notice">
          <p>
            Duplicated from <strong>{duplicated.duplicatedFrom}</strong>.
          </p>
          {duplicated.skipped?.length ? (
            <p>
              Left out (symlinks):{" "}
              {duplicated.skipped.map((item) => (
                <code key={item}>{item} </code>
              ))}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="deck-layout">
        <section className="sorter" aria-label="Slides">
          <div className="sorter-head mono">
            <strong>SLIDE SORTER</strong>
            <span className="muted">
              {slides.length} {slides.length === 1 ? "slide" : "slides"}
            </span>
            <span className="spacer" />
            {view === "grid" ? (
              <span className="segmented small" aria-label="Zoom">
                {[0.6, 1, 1.25].map((z) => (
                  <button key={z} type="button" aria-pressed={zoom === z} onClick={() => setZoom(z)}>
                    {Math.round(z * 100)}%
                  </button>
                ))}
              </span>
            ) : null}
          </div>
          <ol
            className={view === "grid" ? "slide-grid" : "slide-grid as-list"}
            style={
              view === "grid"
                ? ({
                    gridTemplateColumns: `repeat(auto-fill, ${270 * zoom}px)`,
                    "--thumb-scale": 0.25 * zoom,
                  } as CSSProperties)
                : undefined
            }
          >
            {slides.map((slide) => {
              const count = hasBlueprint ? violationsFor(violations, slide).length : 0;
              return (
                <li
                  key={slide.id}
                  className={count ? "slide-thumb has-issues" : "slide-thumb"}
                  data-testid="slide-thumb"
                >
                  <Link to={slideUrl(slide.id)} className="thumb-link">
                    <div className="thumb-head mono">
                      <span className="num">{String(slide.index + 1).padStart(2, "0")}</span>
                      {slide.template ? <span className="tag accent">{slide.template}</span> : null}
                      <span className="spacer" />
                      {hasBlueprint ? <ViolationBadge count={count} /> : null}
                    </div>
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
              );
            })}
          </ol>
        </section>
        <aside className="diagnostics" aria-label="Diagnostics">
          <section className="panel-card">
            <h3>Blueprint health</h3>
            <ViolationsPanel
              deckId={deck.data.id}
              slides={slides}
              violations={violations}
              hasBlueprint={hasBlueprint}
            />
          </section>
          <section className="panel-card" id="deck-assets">
            <h2>Images</h2>
            <ImagesPanel deckId={deck.data.id} mode="manage" />
          </section>
        </aside>
      </div>
    </Shell>
  );
}
