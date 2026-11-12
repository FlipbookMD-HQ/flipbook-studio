import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ApiRequestError, getKit, getWorkspace } from "../api";
import { ErrorNotice, Shell } from "./Shell";

export const templatePath = (scope: "library" | "deck", name: string, deckId?: string) =>
  scope === "deck"
    ? `/kits/templates/deck/${deckId}/${encodeURIComponent(name)}`
    : `/kits/templates/library/${encodeURIComponent(name)}`;

/** Kits → Templates: library templates, each folder deck's templates.yml, and the built-ins. */
export function TemplatesScreen() {
  const workspace = useQuery({ queryKey: ["workspace"], queryFn: getWorkspace });
  const decks = (workspace.data?.decks ?? []).filter((deck) => deck.deckKits.includes("template"));
  const deckKits = useQueries({
    queries: decks.map((deck) => ({
      queryKey: ["kit", "template", "deck", deck.id],
      queryFn: () => getKit("template", "templates", "deck", deck.id),
    })),
  });
  if (workspace.isPending) return <Shell crumb="Templates">Loading templates…</Shell>;
  if (workspace.isError) {
    const error =
      workspace.error instanceof ApiRequestError
        ? workspace.error.error
        : { code: "INTERNAL" as const, message: workspace.error.message };
    return (
      <Shell crumb="Templates">
        <ErrorNotice error={error} />
      </Shell>
    );
  }
  const library = workspace.data.library.templates.filter((template) => template.scope === "library");
  const builtIn = workspace.data.library.templates.filter((template) => template.scope === "builtin");
  return (
    <Shell
      crumb="Templates"
      actions={
        <Link className="button primary" to="/kits/templates/new">
          New template
        </Link>
      }
    >
      <h1>Templates</h1>
      <p className="muted">
        A template places a slide's content on a 3×3 grid. Slides pick one with{" "}
        <code>&lt;!-- template: name --&gt;</code>.
      </p>
      <h2>Library</h2>
      {library.length ? (
        <ul className="kit-list">
          {library.map((template) => (
            <li key={template.name}>
              <Link to={templatePath("library", template.name)}>{template.name}</Link>{" "}
              <span className="badge">Library</span>
            </li>
          ))}
        </ul>
      ) : (
        <p>No library templates yet.</p>
      )}
      {decks.map((deck, index) => {
        const parsed = deckKits[index]?.data?.parsed as Record<string, unknown> | undefined;
        return (
          <section key={deck.id}>
            <h2>
              {deck.title} <span className="muted">templates.yml</span>
            </h2>
            <ul className="kit-list">
              {Object.keys(parsed ?? {}).map((name) => (
                <li key={name}>
                  <Link to={templatePath("deck", name, deck.id)}>{name}</Link>{" "}
                  <span className="badge">Deck</span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <h2>Built-in</h2>
      <ul className="kit-list">
        {builtIn.map((template) => (
          <li key={template.name}>
            {template.name} <span className="badge badge-built-in">Built-in</span>
          </li>
        ))}
      </ul>
    </Shell>
  );
}
