import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ApiRequestError, getDeck, getWorkspace } from "../api";
import type { DeckSummary } from "../../shared/api";
import { ErrorNotice, Shell } from "./Shell";
import { NewDeckDialog } from "./NewDeckDialog";
import { DuplicateDeckButton } from "./Duplicate";

/** The deck's first slide, rendered in a sandboxed frame (same cache as the deck screen). */
function CoverPreview({ deck }: { deck: DeckSummary }) {
  const detail = useQuery({
    queryKey: ["deck", deck.id],
    queryFn: () => getDeck(deck.id),
    staleTime: 30_000,
  });
  const first = detail.data?.slides[0];
  if (!first) return <span className="deck-cover-title">{deck.title}</span>;
  return (
    <div className="cover-frame" aria-hidden="true">
      <iframe title={`${deck.title} cover`} sandbox="" srcDoc={first.html} loading="lazy" tabIndex={-1} />
    </div>
  );
}

function DeckCard({ deck }: { deck: DeckSummary }) {
  if (deck.error) {
    return (
      <li className="deck-card broken" data-testid="deck-card">
        <div className="deck-cover error-cover">
          <span className="tag danger">Load error</span>
        </div>
        <div className="deck-body">
          <h2>{deck.path}</h2>
          <p className="meta">Could not load this deck</p>
          <ErrorNotice error={deck.error} />
        </div>
      </li>
    );
  }
  return (
    <li className="deck-card" data-testid="deck-card">
      <Link to={`/decks/${deck.id}`}>
        <div className="deck-cover">
          <span className="tag mono">
            {deck.slideCount} {deck.slideCount === 1 ? "slide" : "slides"}
          </span>
          <CoverPreview deck={deck} />
        </div>
        <div className="deck-body">
          <h2>{deck.title}</h2>
          <p className="meta">
            {deck.slideCount} {deck.slideCount === 1 ? "slide" : "slides"} · {deck.path}
            {deck.group ? ` · ${deck.group}` : ""}
          </p>
          <div className="tags">
            <span className="tag">{deck.kind === "folder" ? "Folder deck" : "*.slide.md"}</span>
            {deck.group ? <span className="tag accent">{deck.group}</span> : null}
            {deck.deckKits.map((kit) => (
              <span key={kit} className="tag ok">
                {kit}
              </span>
            ))}
          </div>
        </div>
      </Link>
      <DuplicateDeckButton deckId={deck.id} className="link card-action" />
    </li>
  );
}

type Sort = "title" | "slides" | "path";

export function WorkspaceScreen() {
  const workspace = useQuery({ queryKey: ["workspace"], queryFn: getWorkspace });
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("title");

  if (workspace.isPending) return <Shell>Loading workspace…</Shell>;
  if (workspace.isError) {
    const error =
      workspace.error instanceof ApiRequestError
        ? workspace.error.error
        : { code: "INTERNAL" as const, message: workspace.error.message };
    return (
      <Shell>
        <ErrorNotice error={error} />
      </Shell>
    );
  }

  const { root, decks, library } = workspace.data;
  const q = query.trim().toLowerCase();
  const shown = decks
    .filter((d) => !q || `${d.title} ${d.path} ${d.group ?? ""}`.toLowerCase().includes(q))
    .sort((a, b) =>
      sort === "slides"
        ? b.slideCount - a.slideCount
        : (sort === "path" ? a.path : a.title).localeCompare(sort === "path" ? b.path : b.title),
    );
  const broken = decks.filter((d) => d.error).length;
  const totalSlides = decks.reduce((n, d) => n + d.slideCount, 0);

  return (
    <Shell
      crumb={<span className="mono">{root}</span>}
      status={
        <span>
          {decks.length} decks · {totalSlides} slides
        </span>
      }
    >
      <div className="hub-bar">
        <span className="chip mono">{root}</span>
        <span className="spacer" />
        <button type="button" className="primary" onClick={() => setCreating(true)}>
          + New deck
        </button>
      </div>
      {decks.length === 0 ? (
        <section className="empty" data-testid="empty-state">
          <h2>No decks in this folder yet</h2>
          <p>
            Studio lists <code>*.slide.md</code> files and folders with a <code>presentation.yml</code> at the
            top of {root}.
          </p>
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            New deck
          </button>
        </section>
      ) : (
        <>
          <div className="hub-filters">
            <input
              type="search"
              className="search"
              placeholder="Search decks, paths or kits…"
              aria-label="Search decks"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className="inline-select">
              <span aria-hidden="true">Sort by</span>
              <select aria-label="Sort decks" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                <option value="title">Title</option>
                <option value="slides">Slide count</option>
                <option value="path">Path</option>
              </select>
            </span>
          </div>
          <div className="section-head">
            <h1>Decks</h1>
            <span className="chip mono">{decks.length} in workspace</span>
            <span className="spacer" />
            <span className="legend mono">
              <i className="dot" /> {decks.length - broken} loaded
              {broken ? (
                <>
                  {" "}
                  <i className="dot danger" /> {broken} with errors
                </>
              ) : null}
            </span>
          </div>
          <ul className="deck-grid">
            {shown.map((deck) => (
              <DeckCard key={deck.id} deck={deck} />
            ))}
          </ul>
        </>
      )}
      <section className="hub-panels">
        <div className="panel-card">
          <h3>Workspace footprint</h3>
          <dl className="kv mono">
            <dt>Decks</dt>
            <dd>{decks.length}</dd>
            <dt>Slides</dt>
            <dd>{totalSlides}</dd>
          </dl>
        </div>
        <div className="panel-card">
          <h3>Library kits</h3>
          <dl className="kv mono">
            <dt>Themes</dt>
            <dd>{library.themes.length}</dd>
            <dt>Templates</dt>
            <dd>{library.templates.length}</dd>
            <dt>Blueprints</dt>
            <dd>{library.blueprints.length}</dd>
            <dt>Groups</dt>
            <dd>{library.groups.length}</dd>
          </dl>
        </div>
        <div className="panel-card">
          <h3>
            AI engine{" "}
            <Link to="/settings" className="muted small">
              Settings →
            </Link>
          </h3>
          <p className="muted">Configure the local model used for drafting and rewriting in Settings.</p>
        </div>
      </section>
      {creating ? <NewDeckDialog kits={library.groups} onClose={() => setCreating(false)} /> : null}
    </Shell>
  );
}
