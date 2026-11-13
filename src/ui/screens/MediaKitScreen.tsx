import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useLocation, useNavigate, useParams } from "react-router-dom";
import { parse } from "yaml";
import type { ApiError } from "../../shared/api";
import { asBlueprint, mergeDiff, patchYaml } from "../../shared/blueprintModel";
import {
  GROUP_NAME,
  asGroup,
  blueprintTemplates,
  groupProblems,
  groupYaml,
  remapBlueprint,
  renamedGroupSource,
  starterGroup,
  type Group,
} from "../../shared/groupModel";
import {
  ApiRequestError,
  copyGroup,
  createKit,
  getKit,
  getWorkspace,
  previewKit,
  renameGroup,
  updateKit,
} from "../api";
import { BlueprintEditor } from "./BlueprintEditor";
import { ChromeSection, OverviewSection, TemplatesSection, ThemesSection } from "./KitSections";
import { CodeEditor } from "./MarkdownEditor";
import { kitPath } from "./MediaKitsScreen";
import { ErrorNotice, Shell } from "./Shell";
import { DraftKitButton } from "./DraftKitDialog";

const SECTIONS = ["Overview", "Themes", "Templates", "Blueprint", "Chrome", "Raw YAML"] as const;
type SectionName = (typeof SECTIONS)[number];
const PLACEHOLDER = "new_kit";
const asApiError = (error: unknown): ApiError =>
  error instanceof ApiRequestError ? error.error : { code: "INTERNAL", message: (error as Error).message };

function parseSource(source: string): { value: Group | null; error: string | null } {
  try {
    const value = asGroup(parse(source));
    return value ? { value, error: null } : { value: null, error: "A media kit must be a YAML mapping." };
  } catch (error) {
    return { value: null, error: `Not valid YAML: ${(error as Error).message.split("\n")[0]}` };
  }
}

/** Decks named by id, as titles, for the rename warnings. */
function DeckNames({ ids, titles }: { ids: string[]; titles: Map<string, string> }) {
  return (
    <ul>
      {ids.map((id) => (
        <li key={id}>
          <Link to={`/decks/${id}`}>{titles.get(id) ?? id}</Link>
        </li>
      ))}
    </ul>
  );
}

/** Kits → Media kits → one kit: sections on the left, a live sample deck on the right. */
export function MediaKitScreen() {
  const { name: routeName } = useParams();
  const builtIn = useLocation().pathname.startsWith("/kits/media/builtin/");
  const scope = builtIn ? ("builtin" as const) : ("library" as const);
  const creating = !routeName;
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const workspace = useQuery({ queryKey: ["workspace"], queryFn: getWorkspace });
  const kit = useQuery({
    queryKey: ["kit", "group", scope, routeName],
    queryFn: () => getKit("group", routeName!, scope),
    enabled: !creating,
  });

  const [source, setSource] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ source: string; hash: string } | null>(null);
  const [rawEdited, setRawEdited] = useState(false);
  const [section, setSection] = useState<SectionName>("Overview");
  const [newName, setNewName] = useState("");
  const [html, setHtml] = useState("");
  const [previewErrors, setPreviewErrors] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<null | "copy" | "rename">(null);
  const [dialogName, setDialogName] = useState("");
  const leaving = useRef(false);
  const renamedFrom = (location.state as { renamedFrom?: { name: string; decks: string[] } } | null)
    ?.renamedFrom;

  useEffect(() => {
    if (kit.data) {
      leaving.current = false;
      setSource(kit.data.source);
      setSaved({ source: kit.data.source, hash: kit.data.hash });
      setRawEdited(false);
    } else if (creating && source == null) {
      setSource(groupYaml(starterGroup(PLACEHOLDER)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kit.data, creating]);

  const parsed = source == null ? null : parseSource(source);
  // The sample deck refreshes on each change (debounced, latest wins).
  useEffect(() => {
    if (source == null || parsed?.error) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      previewKit("group", { source }, controller.signal).then(
        (response) => {
          setPreviewErrors(response.errors);
          if (response.html) setHtml(response.html);
        },
        (reason: unknown) => {
          if (!controller.signal.aborted) setPreviewErrors([asApiError(reason).message]);
        },
      );
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [source, parsed?.error]);

  const titles = useMemo(
    () => new Map((workspace.data?.decks ?? []).map((deck) => [deck.id, deck.title])),
    [workspace.data],
  );
  const dirty = source != null && (creating || source !== saved?.source);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !leaving.current && dirty && !creating && currentLocation.pathname !== nextLocation.pathname,
  );

  if (!creating && kit.isPending) return <Shell crumb="Media kits">Loading media kit…</Shell>;
  if (kit.isError) {
    return (
      <Shell crumb={<Link to="/kits/media">Media kits</Link>}>
        <ErrorNotice error={asApiError(kit.error)} />
      </Shell>
    );
  }
  if (source == null || !parsed) return <Shell crumb="Media kits">Loading media kit…</Shell>;

  const group = parsed.value;
  const problems = group ? groupProblems(group) : [];
  const nameTaken = (name: string) =>
    (workspace.data?.library.groups ?? []).some((item) => item.name === name);
  const reason =
    parsed.error ??
    (creating && !GROUP_NAME.test(newName)
      ? "Name the media kit (lowercase letters, digits, - or _)."
      : null) ??
    (creating && nameTaken(newName) ? `A media kit named "${newName}" already exists.` : null) ??
    problems[0]?.message ??
    previewErrors[0] ??
    (!dirty && !builtIn ? "No changes to save." : null);

  const onForm = (next: Group) => {
    const patch = mergeDiff(parse(source), next);
    if (Object.keys(patch).length) setSource(patchYaml(source, patch));
  };

  const onNewName = (name: string) => {
    setNewName(name);
    // The kit's name and template prefixes follow the name as it's typed.
    if (GROUP_NAME.test(name) && group && name !== group.name)
      setSource(renamedGroupSource(source, group.name, name));
  };

  const onImport = async (name: string) => {
    if (!group) return;
    try {
      const template = await getKit("template", name, "library");
      const fields = parse(template.source) as Record<string, unknown>;
      onForm({
        ...group,
        templates: { ...group.templates, [`${group.name}_${name}`]: fields as Group["templates"][string] },
      });
    } catch (error) {
      setSaveError(asApiError(error));
    }
  };

  const startFromBlueprint = async (name: string) => {
    if (!group || !name) return;
    try {
      const blueprint = asBlueprint(parse((await getKit("blueprint", name, "library")).source));
      if (blueprint) onForm({ ...group, blueprint: remapBlueprint(blueprint, group) });
    } catch (error) {
      setSaveError(asApiError(error));
    }
  };

  const finish = (name: string, state?: unknown) => {
    leaving.current = true;
    void queryClient.invalidateQueries({ queryKey: ["workspace"] });
    void queryClient.invalidateQueries({ queryKey: ["kit", "group"] });
    navigate(kitPath("library", name), state ? { state } : undefined);
  };

  const run = async (action: () => Promise<void>) => {
    setSaving(true);
    setSaveError(null);
    try {
      await action();
    } catch (error) {
      setSaveError(asApiError(error));
    } finally {
      setSaving(false);
    }
  };

  const save = () =>
    run(async () => {
      if (creating) {
        const doc = await createKit("group", { name: newName, scope: "library", source });
        finish(doc.ref.name);
        return;
      }
      // Form edits send a patch (comments elsewhere survive); raw edits send the text.
      const change = rawEdited ? { source } : { patch: mergeDiff(parse(saved!.source), parse(source)) };
      const doc = await updateKit("group", routeName!, {
        scope: "library",
        baseHash: saved!.hash,
        ...change,
      });
      setSaved({ source: doc.source, hash: doc.hash });
      setSource(doc.source);
      setRawEdited(false);
      void queryClient.invalidateQueries({ queryKey: ["kit", "group"] });
    });

  const saveCopy = (toName: string) =>
    run(async () => {
      // Unchanged: core copies the file. Edited: the edited text under the new name.
      if (!dirty) await copyGroup(routeName!, { toName, scope });
      else
        await createKit("group", {
          name: toName,
          scope: "library",
          source: renamedGroupSource(source, routeName!, toName),
        });
      setDialog(null);
      finish(toName);
    });

  const rename = (toName: string) =>
    run(async () => {
      const result = await renameGroup(routeName!, { toName, baseHash: saved!.hash });
      setDialog(null);
      finish(toName, { renamedFrom: { name: routeName, decks: result.decksUsingOldName } });
    });

  const title = creating ? "New media kit" : routeName!;
  const themes = workspace.data?.library.themes ?? [];
  const libraryTemplates = (workspace.data?.library.templates ?? []).filter(
    (template) => template.scope === "library",
  );
  const blueprints = workspace.data?.library.blueprints ?? [];
  const sectionProblems = (name: SectionName) =>
    problems.filter((problem) => problem.where.split(".")[0] === name.toLowerCase()).length;
  const dialogProblem = !GROUP_NAME.test(dialogName)
    ? "Use lowercase letters, digits, - or _ (start with a letter)."
    : nameTaken(dialogName)
      ? `A media kit named "${dialogName}" already exists.`
      : null;

  return (
    <Shell
      crumb={
        <>
          <Link to="/kits/media">Media kits</Link> · {title}
        </>
      }
      actions={
        <>
          {creating ? <DraftKitButton kind="group" /> : null}
          {reason && reason !== "No changes to save." ? (
            <span className="muted" data-testid="save-reason">
              {reason}
            </span>
          ) : null}
          {builtIn ? (
            <button
              type="button"
              className="primary"
              disabled={Boolean(reason) || saving}
              onClick={() => {
                setDialogName(`my_${routeName}`);
                setDialog("copy");
              }}
            >
              Save as copy
            </button>
          ) : (
            <>
              {creating ? null : (
                <button
                  type="button"
                  disabled={dirty || saving}
                  title={dirty ? "Save or discard your changes first." : undefined}
                  onClick={() => {
                    setDialogName(routeName!);
                    setDialog("rename");
                  }}
                >
                  Rename
                </button>
              )}
              <button
                type="button"
                className="primary"
                disabled={Boolean(reason) || saving}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          )}
        </>
      }
    >
      <h1>{title}</h1>
      {builtIn ? (
        <p className="warning" data-testid="builtin-note">
          This kit is built in and read-only. Your changes are saved as a copy in your library.
        </p>
      ) : null}
      {renamedFrom && renamedFrom.decks.length ? (
        <div className="warning" role="status" data-testid="rename-result">
          <p>
            {renamedFrom.decks.length} deck(s) use <code>{renamedFrom.name}</code> — they won't load until
            updated:
          </p>
          <DeckNames ids={renamedFrom.decks} titles={titles} />
        </div>
      ) : null}
      {kit.data?.invalid ? (
        <p className="warning">The file on disk doesn't validate: {kit.data.invalid}</p>
      ) : null}
      {saveError ? <ErrorNotice error={saveError} /> : null}
      <div className="kit-layout">
        <section>
          <div role="tablist" className="tabs">
            {SECTIONS.map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={section === name}
                onClick={() => setSection(name)}
              >
                {name}
                {sectionProblems(name) ? (
                  <span className="tab-problems"> ({sectionProblems(name)})</span>
                ) : null}
              </button>
            ))}
          </div>
          {section === "Raw YAML" ? (
            <CodeEditor
              value={source}
              onChange={(next) => {
                setSource(next);
                setRawEdited(true);
              }}
              language="yaml"
              label="Media kit YAML"
            />
          ) : !group ? (
            <p className="warning">{parsed.error} Fix it in the Raw YAML tab.</p>
          ) : section === "Overview" ? (
            <OverviewSection
              group={group}
              onChange={onForm}
              problems={creating ? [] : problems}
              nameField={
                creating ? (
                  <label className="field narrow">
                    <span>Kit name</span>
                    <input value={newName} onChange={(event) => onNewName(event.target.value.trim())} />
                  </label>
                ) : (
                  <p>
                    Name: <code>{group.name}</code>
                  </p>
                )
              }
            />
          ) : section === "Themes" ? (
            <ThemesSection group={group} onChange={onForm} problems={problems} themes={themes} />
          ) : section === "Templates" ? (
            <TemplatesSection
              group={group}
              onChange={onForm}
              problems={problems}
              library={libraryTemplates}
              onImport={(name) => void onImport(name)}
            />
          ) : section === "Blueprint" ? (
            <div className="kit-section">
              <label className="field narrow">
                <span>Start from library blueprint</span>
                <select value="" onChange={(event) => void startFromBlueprint(event.target.value)}>
                  <option value="">Pick a library blueprint…</option>
                  {blueprints.map((blueprint) => (
                    <option key={blueprint.name} value={blueprint.name}>
                      {blueprint.name}
                    </option>
                  ))}
                </select>
              </label>
              <BlueprintEditor
                value={group.blueprint}
                onChange={(blueprint) => onForm({ ...group, blueprint })}
                templates={blueprintTemplates(group)}
                problems={problems
                  .filter((problem) => problem.where.startsWith("blueprint."))
                  .map((problem) => ({ ...problem, where: problem.where.slice("blueprint.".length) }))}
              />
            </div>
          ) : (
            <ChromeSection group={group} onChange={onForm} problems={problems} />
          )}
        </section>
        <section className="kit-preview" aria-label="Sample deck">
          <h2>Sample deck</h2>
          {previewErrors.length ? (
            <ul className="inline-problems" data-testid="preview-errors">
              {previewErrors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : null}
          {html ? (
            <iframe title="Media kit sample deck" sandbox="" srcDoc={html} data-testid="kit-preview" />
          ) : (
            <p>Rendering the sample deck…</p>
          )}
        </section>
      </div>
      {dialog ? (
        <dialog open className="dialog" aria-labelledby="kit-dialog-title">
          <h2 id="kit-dialog-title">{dialog === "copy" ? "Save as a copy" : `Rename ${routeName}`}</h2>
          <label className="field">
            <span>New kit name</span>
            <input
              value={dialogName}
              onChange={(event) => setDialogName(event.target.value.trim())}
              autoFocus
            />
          </label>
          {dialogName && dialogProblem && dialogName !== routeName ? (
            <p className="inline-problems">{dialogProblem}</p>
          ) : null}
          {dialog === "rename" && kit.data?.usedBy.length ? (
            <div className="warning" data-testid="rename-warning">
              <p>
                {kit.data.usedBy.length} deck(s) use <code>{routeName}</code> — they won't load until updated:
              </p>
              <DeckNames ids={kit.data.usedBy} titles={titles} />
            </div>
          ) : null}
          <p className="muted">Template names are renamed to start with the new name.</p>
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={Boolean(dialogProblem) || saving}
              onClick={() => void (dialog === "copy" ? saveCopy(dialogName) : rename(dialogName))}
            >
              {dialog === "copy" ? "Save copy" : "Rename kit"}
            </button>
            <button type="button" onClick={() => setDialog(null)}>
              Cancel
            </button>
          </div>
        </dialog>
      ) : null}
      {blocker.state === "blocked" ? (
        <dialog open className="dialog" aria-labelledby="leave-title">
          <h2 id="leave-title">Leave without saving?</h2>
          <p>Your media kit changes are not saved.</p>
          <div className="actions">
            <button type="button" className="danger" onClick={() => blocker.proceed()}>
              Discard changes
            </button>
            <button type="button" onClick={() => blocker.reset()}>
              Stay
            </button>
          </div>
        </dialog>
      ) : null}
    </Shell>
  );
}
