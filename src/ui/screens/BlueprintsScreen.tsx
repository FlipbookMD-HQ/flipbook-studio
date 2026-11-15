import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ApiRequestError, getWorkspace } from "../api";
import { ErrorNotice, Shell } from "./Shell";
import { DraftKitButton } from "./DraftKitDialog";
import { DuplicateKitButton } from "./Duplicate";

export const blueprintPath = (scope: "library" | "deck", name: string) =>
  scope === "deck" ? `/kits/blueprints/deck/${name}` : `/kits/blueprints/library/${encodeURIComponent(name)}`;

/** Kits → Blueprints: library blueprints and each folder deck's blueprint.yml. */
export function BlueprintsScreen() {
  const workspace = useQuery({ queryKey: ["workspace"], queryFn: getWorkspace });
  if (workspace.isPending) return <Shell crumb="Blueprints">Loading blueprints…</Shell>;
  if (workspace.isError) {
    const error =
      workspace.error instanceof ApiRequestError
        ? workspace.error.error
        : { code: "INTERNAL" as const, message: workspace.error.message };
    return (
      <Shell crumb="Blueprints">
        <ErrorNotice error={error} />
      </Shell>
    );
  }
  const folders = workspace.data.decks.filter((deck) => deck.kind === "folder" && !deck.error);
  return (
    <Shell
      crumb="Blueprints"
      actions={
        <>
          <DraftKitButton kind="blueprint" />
          <Link className="button primary" to="/kits/blueprints/new">
            New library blueprint
          </Link>
        </>
      }
    >
      <h1>Blueprints</h1>
      <p className="muted">
        A blueprint sets a deck's page order and content rules; flipbook check enforces it.
      </p>
      <h2>Library</h2>
      {workspace.data.library.blueprints.length ? (
        <ul className="kit-list">
          {workspace.data.library.blueprints.map((blueprint) => (
            <li key={blueprint.name}>
              <Link to={blueprintPath("library", blueprint.name)}>{blueprint.name}</Link>{" "}
              <span className="badge">Library</span>
              <DuplicateKitButton kind="blueprint" name={blueprint.name} scope="library" />
            </li>
          ))}
        </ul>
      ) : (
        <p>
          No library blueprints yet. They're saved in ~/Documents/flipbook/blueprints and copied into media
          kits.
        </p>
      )}
      <h2>Decks</h2>
      <ul className="kit-list">
        {folders.map((deck) => (
          <li key={deck.id}>
            <Link to={blueprintPath("deck", deck.id)}>{deck.title}</Link>{" "}
            {deck.deckKits.includes("blueprint") ? (
              <span className="badge">blueprint.yml</span>
            ) : (
              <span className="muted">no blueprint yet</span>
            )}
          </li>
        ))}
      </ul>
    </Shell>
  );
}
