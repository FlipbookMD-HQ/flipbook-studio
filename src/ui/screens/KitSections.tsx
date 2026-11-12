import { useState } from "react";
import type { KitRef } from "../../shared/api";
import type { Problem } from "../../shared/blueprintModel";
import {
  BAND_LINES,
  CANVASES,
  CORNERS,
  COUNTER_LINES,
  LINE_ALIGNS,
  SHAPES,
  type Band,
  type Counter,
  type Group,
  type GroupTemplate,
} from "../../shared/groupModel";
import { LAYOUTS, ROLES, type Region } from "../../shared/templateFields";
import { GridEditor } from "./GridEditor";

/** Sets or removes (undefined) a key, keeping the others in place. */
export function setKey<T extends object>(object: T, key: string, value: unknown): T {
  const next = { ...object } as Record<string, unknown>;
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next as T;
}

export function Inline({ problems }: { problems: Problem[] }) {
  return problems.length ? (
    <ul className="inline-problems" role="status">
      {problems.map((problem) => (
        <li key={problem.message}>{problem.message}</li>
      ))}
    </ul>
  ) : null;
}

type Section = { group: Group; onChange: (group: Group) => void; problems: Problem[] };

export function OverviewSection({
  group,
  onChange,
  problems,
  nameField,
}: Section & { nameField: React.ReactNode }) {
  return (
    <div className="kit-section">
      {nameField}
      <label className="field">
        <span>Description</span>
        <textarea
          rows={2}
          value={group.description ?? ""}
          onChange={(event) => onChange(setKey(group, "description", event.target.value))}
        />
      </label>
      <fieldset className="choices">
        <legend>Canvas</legend>
        {CANVASES.map((canvas) => (
          <label key={canvas} className="choice">
            <input
              type="radio"
              name="canvas"
              checked={(group.canvas ?? "midnight") === canvas}
              onChange={() => onChange({ ...group, canvas })}
            />
            {canvas}
          </label>
        ))}
      </fieldset>
      <Inline problems={problems.filter((problem) => problem.where === "overview")} />
    </div>
  );
}

export function ThemesSection({ group, onChange, problems, themes }: Section & { themes: KitRef[] }) {
  const toggle = (name: string) => {
    const selected = group.themes.includes(name)
      ? group.themes.filter((theme) => theme !== name)
      : [...group.themes, name];
    const style = group.themes.length === 0 && selected.length === 1 ? selected[0]! : group.style;
    onChange({ ...group, themes: selected, style });
  };
  return (
    <div className="kit-section">
      <fieldset className="choices">
        <legend>Themes in this kit</legend>
        {themes.map((theme) => (
          <label key={theme.name} className="choice">
            <input
              type="checkbox"
              checked={group.themes.includes(theme.name)}
              onChange={() => toggle(theme.name)}
            />
            {theme.name}
            {theme.scope === "builtin" ? <span className="badge">Built-in</span> : null}
          </label>
        ))}
      </fieldset>
      <label className="field narrow">
        <span>Style (default theme)</span>
        <select
          value={group.style}
          onChange={(event) => onChange({ ...group, style: event.target.value })}
          aria-invalid={group.themes.includes(group.style) ? undefined : "true"}
        >
          {(group.themes.includes(group.style) ? group.themes : [group.style, ...group.themes]).map(
            (theme) => (
              <option key={theme} value={theme}>
                {group.themes.includes(theme) ? theme : `${theme} (not selected)`}
              </option>
            ),
          )}
        </select>
      </label>
      <Inline problems={problems.filter((problem) => problem.where === "themes")} />
    </div>
  );
}

function TemplateCard({
  name,
  prefix,
  template,
  problems,
  onChange,
  onRemove,
}: {
  name: string;
  prefix: string;
  template: GroupTemplate;
  problems: Problem[];
  onChange: (template: GroupTemplate) => void;
  onRemove: () => void;
}) {
  const short = name.startsWith(prefix) ? name.slice(prefix.length) : name;
  const region: Region = {
    column: template.column,
    row: template.row,
    width: template.width,
    height: template.height,
  };
  return (
    <li className="bp-card" data-testid={`kit-template-${short}`}>
      <div className="bp-card-head">
        <strong>
          <span className="muted">{prefix}</span>
          {short}
        </strong>
        <button type="button" className="danger" onClick={onRemove} aria-label={`Remove template ${short}`}>
          Remove
        </button>
      </div>
      <div className="kit-template">
        <GridEditor
          value={region}
          onChange={(next) => onChange({ ...template, ...next })}
          label={`${short} region`}
        />
        <div className="kit-template-fields">
          <fieldset className="choices">
            <legend>{short} alignment</legend>
            {(["start", "center", "end"] as const).map((align) => (
              <label key={align} className="choice">
                <input
                  type="radio"
                  name={`align-${name}`}
                  checked={(template.align ?? "start") === align}
                  onChange={() => onChange({ ...template, align })}
                />
                {align}
              </label>
            ))}
          </fieldset>
          <label className="field compact">
            <span>{short} role</span>
            <select
              value={template.role ?? ""}
              onChange={(event) => onChange(setKey(template, "role", event.target.value || undefined))}
            >
              <option value="">None</option>
              {ROLES.map((role) => (
                <option key={role}>{role}</option>
              ))}
            </select>
          </label>
          <label className="field compact">
            <span>{short} layout</span>
            <select
              value={template.layout ?? ""}
              onChange={(event) => onChange(setKey(template, "layout", event.target.value || undefined))}
            >
              <option value="">None</option>
              {LAYOUTS.map((layout) => (
                <option key={layout}>{layout}</option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <Inline problems={problems} />
    </li>
  );
}

export function TemplatesSection({
  group,
  onChange,
  problems,
  library,
  onImport,
}: Section & { library: KitRef[]; onImport: (name: string) => void }) {
  const prefix = `${group.name}_`;
  const [newName, setNewName] = useState("");
  const [importing, setImporting] = useState("");
  const setTemplates = (templates: Group["templates"]) => onChange({ ...group, templates });
  const addName = `${prefix}${newName}`;
  const addProblem = !/^[a-z][a-z0-9_-]*$/.test(newName)
    ? "Use lowercase letters, digits, - or _."
    : addName in group.templates
      ? "The kit already has that template."
      : null;
  return (
    <div className="kit-section">
      <ul className="bp-list">
        {Object.entries(group.templates).map(([name, template]) => (
          <TemplateCard
            key={name}
            name={name}
            prefix={prefix}
            template={template}
            problems={problems.filter((problem) => problem.where === `templates.${name}`)}
            onChange={(next) => setTemplates({ ...group.templates, [name]: next })}
            onRemove={() => setTemplates(setKey(group.templates, name, undefined))}
          />
        ))}
      </ul>
      <div className="kit-row">
        <label className="field compact">
          <span>New template name</span>
          <input
            value={newName}
            onChange={(event) => setNewName(event.target.value.trim())}
            placeholder="quote"
          />
        </label>
        <button
          type="button"
          disabled={Boolean(addProblem)}
          title={newName ? (addProblem ?? undefined) : undefined}
          onClick={() => {
            setTemplates({
              ...group.templates,
              [addName]: { column: 1, row: 1, width: 3, height: 3, align: "start" },
            });
            setNewName("");
          }}
        >
          Add template
        </button>
      </div>
      <div className="kit-row">
        <label className="field compact">
          <span>Import from library</span>
          <select value={importing} onChange={(event) => setImporting(event.target.value)}>
            <option value="">Pick a library template…</option>
            {library.map((template) => (
              <option key={template.name} value={template.name}>
                {template.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!importing || `${prefix}${importing}` in group.templates}
          onClick={() => {
            onImport(importing);
            setImporting("");
          }}
        >
          Import as {importing ? `${prefix}${importing}` : "a kit template"}
        </button>
      </div>
      {library.length ? null : <p className="muted">No library templates to import yet.</p>}
    </div>
  );
}

function BandFields({
  edge,
  band,
  onChange,
}: {
  edge: string;
  band: Band | undefined;
  onChange: (band: Band | undefined) => void;
}) {
  const kind = band?.kind ?? "none";
  return (
    <fieldset className="kit-band">
      <legend>{edge}</legend>
      <label className="field compact">
        <span>{edge} kind</span>
        <select
          value={kind}
          onChange={(event) => {
            const next = event.target.value;
            onChange(
              next === "none"
                ? undefined
                : next === "line"
                  ? { kind: "line", line: "straight" }
                  : { kind: "shapes", shape: "circle" },
            );
          }}
        >
          <option value="none">None</option>
          <option value="line">Line</option>
          <option value="shapes">Shapes</option>
        </select>
      </label>
      {kind === "line" ? (
        <label className="field compact">
          <span>{edge} line</span>
          <select
            value={band?.line ?? "straight"}
            onChange={(event) => onChange({ kind: "line", line: event.target.value })}
          >
            {BAND_LINES.map((line) => (
              <option key={line}>{line}</option>
            ))}
          </select>
        </label>
      ) : null}
      {kind === "shapes" ? (
        <label className="field compact">
          <span>{edge} shape</span>
          <select
            value={band?.shape ?? "circle"}
            onChange={(event) => onChange({ kind: "shapes", shape: event.target.value })}
          >
            {SHAPES.map((shape) => (
              <option key={shape}>{shape}</option>
            ))}
          </select>
        </label>
      ) : null}
    </fieldset>
  );
}

const DEFAULT_COUNTER: Counter = {
  corner: "bottom-right",
  line: "solid",
  line_align: "middle",
  line_length: "40%",
};

export function ChromeSection({ group, onChange, problems }: Section) {
  const chrome = group.chrome;
  const counter = chrome?.counter ?? DEFAULT_COUNTER;
  const setChrome = (next: Group["chrome"] | undefined) => onChange(setKey(group, "chrome", next));
  const setCounter = (key: keyof Counter, value: string | undefined) =>
    setChrome({ ...(chrome ?? {}), counter: setKey(counter, key, value) });
  const select = (key: keyof Counter, label: string, options: readonly string[]) => (
    <label className="field compact">
      <span>{label}</span>
      <select value={String(counter[key] ?? "")} onChange={(event) => setCounter(key, event.target.value)}>
        {options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="kit-section">
      <label className="choice">
        <input
          type="checkbox"
          checked={Boolean(chrome)}
          onChange={(event) => setChrome(event.target.checked ? { counter: DEFAULT_COUNTER } : undefined)}
        />
        Show page chrome (page counter, header and footer)
      </label>
      {chrome ? (
        <>
          <fieldset className="kit-band">
            <legend>Page counter</legend>
            {select("corner", "Counter corner", CORNERS)}
            {select("line", "Counter line", COUNTER_LINES)}
            {select("line_align", "Line align", LINE_ALIGNS)}
            <label className="field compact">
              <span>Line length</span>
              <input
                value={counter.line_length ?? ""}
                onChange={(event) => setCounter("line_length", event.target.value.trim())}
              />
            </label>
            <label className="field compact">
              <span>Ornament (glyph or image path)</span>
              <input
                value={counter.ornament ?? ""}
                onChange={(event) => setCounter("ornament", event.target.value.trim() || undefined)}
              />
            </label>
          </fieldset>
          <BandFields
            edge="Header"
            band={chrome.header}
            onChange={(band) => setChrome(setKey(chrome, "header", band))}
          />
          <BandFields
            edge="Footer"
            band={chrome.footer}
            onChange={(band) => setChrome(setKey(chrome, "footer", band))}
          />
        </>
      ) : null}
      <Inline problems={problems.filter((problem) => problem.where === "chrome")} />
    </div>
  );
}
