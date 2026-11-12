import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ApiRequestError, getWorkspace } from "../api";
import { ErrorNotice, Shell } from "./Shell";

export const kitPath = (scope: "library" | "builtin", name: string) =>
  `/kits/media/${scope}/${encodeURIComponent(name)}`;

/** Kits → Media kits: the library's kits and the built-in ones. */
export function MediaKitsScreen() {
  const workspace = useQuery({ queryKey: ["workspace"], queryFn: getWorkspace });
  if (workspace.isPending) return <Shell crumb="Media kits">Loading media kits…</Shell>;
  if (workspace.isError) {
    const error =
      workspace.error instanceof ApiRequestError
        ? workspace.error.error
        : { code: "INTERNAL" as const, message: workspace.error.message };
    return (
      <Shell crumb="Media kits">
        <ErrorNotice error={error} />
      </Shell>
    );
  }
  const groups = workspace.data.library.groups;
  const list = (scope: "library" | "builtin") => groups.filter((group) => group.scope === scope);
  return (
    <Shell
      crumb="Media kits"
      actions={
        <Link className="button primary" to="/kits/media/new">
          New media kit
        </Link>
      }
    >
      <h1>Media kits</h1>
      <p className="muted">
        A media kit bundles templates, a blueprint, page chrome and themes. New decks can start from one.
      </p>
      <h2>Library</h2>
      {list("library").length ? (
        <ul className="kit-list">
          {list("library").map((group) => (
            <li key={group.name}>
              <Link to={kitPath("library", group.name)}>{group.name}</Link>{" "}
              {group.description ? <span className="muted">{group.description}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p>No media kits yet. They're saved in ~/Documents/flipbook/templates.</p>
      )}
      <h2>Built-in</h2>
      <ul className="kit-list">
        {list("builtin").map((group) => (
          <li key={group.name}>
            <Link to={kitPath("builtin", group.name)}>{group.name}</Link>{" "}
            <span className="badge">Built-in</span>{" "}
            {group.description ? <span className="muted">{group.description}</span> : null}
          </li>
        ))}
      </ul>
    </Shell>
  );
}
