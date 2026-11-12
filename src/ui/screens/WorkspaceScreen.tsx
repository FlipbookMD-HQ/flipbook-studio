import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ApiRequestError, getWorkspace } from "../api";
import type { DeckSummary } from "../../shared/api";
import { ErrorNotice, Shell } from "./Shell";

function DeckCard({ deck }: { deck: DeckSummary }) {
  if (deck.error) {
    return (
      <li className="deck-card broken" data-testid="deck-card">
        <h2>{deck.path}</h2>
        <p className="meta">Could not load this deck</p>
        <ErrorNotice error={deck.error} />
      </li>
    );
  }
  return (
    <li className="deck-card" data-testid="deck-card">
      <Link to={`/decks/${deck.id}`}>
        <h2>{deck.title}</h2>
        <p className="meta">
          {deck.slideCount} {deck.slideCount === 1 ? "slide" : "slides"} · {deck.path}
          {deck.group ? ` · ${deck.group}` : ""}
        </p>
      </Link>
    </li>
  );
}

export function WorkspaceScreen() {
  const workspace = useQuery({ queryKey: ["workspace"], queryFn: getWorkspace });

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

  const { root, decks } = workspace.data;
  return (
    <Shell crumb={root}>
      <div className="heading-row">
        <h1>Decks</h1>
        {/* Creating decks arrives in US-2. */}
        <button type="button" className="primary" disabled title="Coming soon">
          New deck
        </button>
      </div>
      {decks.length === 0 ? (
        <section className="empty" data-testid="empty-state">
          <h2>No decks in this folder yet</h2>
          <p>Studio lists `*.slide.md` files and folders with a `presentation.yml` at the top of {root}.</p>
          <button type="button" className="primary" disabled title="Coming soon">
            New deck
          </button>
        </section>
      ) : (
        <ul className="deck-grid">
          {decks.map((deck) => (
            <DeckCard key={deck.id} deck={deck} />
          ))}
        </ul>
      )}
    </Shell>
  );
}
