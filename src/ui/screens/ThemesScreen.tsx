import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ApiRequestError, getWorkspace } from "../api";
import { ErrorNotice, Shell } from "./Shell";
import { DraftKitButton } from "./DraftKitDialog";

export const themePath = (scope: string, name: string) => `/kits/themes/${scope}/${encodeURIComponent(name)}`;

/** Kits → Themes: library, deck and built-in themes. */
export function ThemesScreen() {
  const workspace = useQuery({ queryKey: ["workspace"], queryFn: getWorkspace });
  if (workspace.isPending) return <Shell crumb="Themes">Loading themes…</Shell>;
  if (workspace.isError) {
    const error =
      workspace.error instanceof ApiRequestError
        ? workspace.error.error
        : { code: "INTERNAL" as const, message: workspace.error.message };
    return (
      <Shell crumb="Themes">
        <ErrorNotice error={error} />
      </Shell>
    );
  }
  const { themes } = workspace.data.library;
  const decks = workspace.data.decks.filter((deck) => deck.deckKits.includes("theme"));
  const rows = [
    ...themes
      .filter((theme) => theme.scope === "library")
      .map((theme) => ({
        key: `l-${theme.name}`,
        label: theme.name,
        badge: "Library",
        to: themePath("library", theme.name),
      })),
    ...decks.map((deck) => ({
      key: `d-${deck.id}`,
      label: `${deck.title} (presentation.css)`,
      badge: "Deck",
      to: themePath("deck", deck.id),
    })),
    ...themes
      .filter((theme) => theme.scope === "builtin")
      .map((theme) => ({
        key: `b-${theme.name}`,
        label: theme.name,
        badge: "Built-in",
        to: themePath("builtin", theme.name),
      })),
  ];
  return (
    <Shell crumb="Themes" actions={<DraftKitButton kind="theme" />}>
      <h1>Themes</h1>
      <p className="muted">
        Library themes are used by decks with <code>style: &lt;name&gt;</code>. Built-in themes are copied
        before editing.
      </p>
      {rows.length ? (
        <ul className="kit-list">
          {rows.map((row) => (
            <li key={row.key}>
              <Link to={row.to}>{row.label}</Link>{" "}
              <span className={`badge badge-${row.badge.toLowerCase()}`}>{row.badge}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p>No themes yet.</p>
      )}
    </Shell>
  );
}
