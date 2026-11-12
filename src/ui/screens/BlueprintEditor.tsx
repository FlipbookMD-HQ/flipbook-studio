import { useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  CONTENT_KINDS,
  renameType,
  repeatOf,
  type Blueprint,
  type Problem,
  type Rules,
  type Step,
} from "../../shared/blueprintModel";

type RuleKey = "max_chars" | "max_items" | "require" | "allow" | "forbid";

/** Sets or removes (undefined) a key, keeping the others in place. */
function setKey<T extends object>(object: T, key: string, value: unknown): T {
  const next = { ...object } as Record<string, unknown>;
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next as T;
}

function NumberField({
  label,
  value,
  onChange,
  min = 0,
}: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  min?: number;
}) {
  return (
    <label className="field compact">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        value={value ?? ""}
        placeholder="—"
        onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
      />
    </label>
  );
}

function Chips({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[] | undefined;
  onChange: (value: string[] | undefined) => void;
}) {
  const selected = new Set(value ?? []);
  return (
    <fieldset className="chips">
      <legend>{label}</legend>
      {CONTENT_KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          aria-pressed={selected.has(kind)}
          aria-label={`${label}: ${kind}`}
          onClick={() => {
            const next = CONTENT_KINDS.filter((item) =>
              item === kind ? !selected.has(item) : selected.has(item),
            );
            onChange(next.length ? next : undefined);
          }}
        >
          {kind}
        </button>
      ))}
    </fieldset>
  );
}

/** max_chars, max_items and the require/allow/forbid chips, shared by types and page overrides. */
function RuleFields<T extends Rules | Step>({
  rules,
  onChange,
  label,
}: {
  rules: T;
  onChange: (rules: T) => void;
  label: string;
}) {
  const set = (key: RuleKey, value: unknown) => onChange(setKey(rules, key, value));
  return (
    <div className="rule-fields">
      <div className="rule-numbers">
        <NumberField
          label={`${label} max chars`}
          value={rules.max_chars}
          onChange={(value) => set("max_chars", value)}
        />
        <NumberField
          label={`${label} max items`}
          value={rules.max_items}
          onChange={(value) => set("max_items", value)}
        />
      </div>
      <Chips label={`${label} require`} value={rules.require} onChange={(value) => set("require", value)} />
      <Chips label={`${label} allow`} value={rules.allow} onChange={(value) => set("allow", value)} />
      <Chips label={`${label} forbid`} value={rules.forbid} onChange={(value) => set("forbid", value)} />
    </div>
  );
}

function Inline({ problems }: { problems: Problem[] }) {
  return problems.length ? (
    <ul className="inline-problems" role="status">
      {problems.map((problem) => (
        <li key={problem.message}>{problem.message}</li>
      ))}
    </ul>
  ) : null;
}

function TypeCard({
  name,
  rules,
  templates,
  problems,
  onRename,
  onChange,
  onRemove,
}: {
  name: string;
  rules: Rules;
  templates: string[];
  problems: Problem[];
  onRename: (to: string) => void;
  onChange: (rules: Rules) => void;
  onRemove: () => void;
}) {
  const [draftName, setDraftName] = useState(name);
  const options =
    rules.template && !templates.includes(rules.template) ? [...templates, rules.template] : templates;
  return (
    <li className="bp-card" data-testid={`type-${name}`}>
      <div className="bp-card-head">
        <label className="field compact">
          <span>Type name</span>
          <input
            value={draftName}
            onChange={(event) => setDraftName(event.target.value.trim())}
            onBlur={() => (draftName && draftName !== name ? onRename(draftName) : setDraftName(name))}
            onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
          />
        </label>
        <label className="field compact">
          <span>{name} template</span>
          <select
            value={rules.template ?? ""}
            onChange={(event) => onChange(setKey(rules, "template", event.target.value || undefined))}
            aria-invalid={rules.template && !templates.includes(rules.template) ? "true" : undefined}
          >
            <option value="">Any (slide decides)</option>
            {options.map((template) => (
              <option key={template} value={template}>
                {templates.includes(template) ? template : `${template} (unknown)`}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="danger" onClick={onRemove} aria-label={`Remove type ${name}`}>
          Remove
        </button>
      </div>
      <RuleFields rules={rules} onChange={onChange} label={name} />
      <Inline problems={problems} />
    </li>
  );
}

function StepCard({
  id,
  index,
  step,
  types,
  problems,
  onChange,
  onRemove,
}: {
  id: string;
  index: number;
  step: Step;
  types: string[];
  problems: Problem[];
  onChange: (step: Step) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const { min, max } = repeatOf(step);
  const mode = step.any ? "any" : "type";
  const setRepeat = (next: { min: number; max: number }) =>
    onChange(setKey(step, "repeat", next.min === 1 && next.max === 1 ? undefined : next));
  const [overrides, setOverrides] = useState(
    ["max_chars", "max_items", "require", "allow", "forbid"].some((key) => key in step),
  );
  return (
    <li
      ref={setNodeRef}
      className={isDragging ? "bp-card dragging" : "bp-card"}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid={`step-${index + 1}`}
    >
      <div className="bp-card-head">
        <button
          type="button"
          className="drag-handle"
          aria-label={`Move page step ${index + 1}`}
          {...attributes}
          {...listeners}
        >
          ⋮⋮
        </button>
        <span className="step-number">{index + 1}.</span>
        <label className="field compact">
          <span>Step {index + 1} matches</span>
          <select
            value={mode}
            onChange={(event) => {
              const next = setKey(setKey(step, "type", undefined), "any", undefined);
              onChange(
                event.target.value === "any"
                  ? { ...next, any: step.type ? [step.type] : [] }
                  : { ...next, type: step.any?.[0] ?? "" },
              );
            }}
          >
            <option value="type">One type</option>
            <option value="any">Any of several types</option>
          </select>
        </label>
        {mode === "type" ? (
          <label className="field compact">
            <span>Step {index + 1} type</span>
            <select
              value={step.type ?? ""}
              onChange={(event) => onChange({ ...step, type: event.target.value })}
            >
              <option value="">Pick a type…</option>
              {(step.type && !types.includes(step.type) ? [...types, step.type] : types).map((type) => (
                <option key={type} value={type}>
                  {types.includes(type) ? type : `${type} (undefined)`}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <fieldset className="chips">
            <legend>Step {index + 1} types</legend>
            {types.map((type) => (
              <button
                key={type}
                type="button"
                aria-pressed={step.any?.includes(type) ?? false}
                onClick={() =>
                  onChange({
                    ...step,
                    any: step.any?.includes(type)
                      ? step.any.filter((item) => item !== type)
                      : [...(step.any ?? []), type],
                  })
                }
              >
                {type}
              </button>
            ))}
          </fieldset>
        )}
        <NumberField
          label={`Step ${index + 1} min`}
          value={min}
          onChange={(value) => setRepeat({ min: value ?? 0, max })}
        />
        <NumberField
          label={`Step ${index + 1} max`}
          value={max}
          onChange={(value) => setRepeat({ min, max: value ?? 0 })}
        />
        <button
          type="button"
          className="danger"
          onClick={onRemove}
          aria-label={`Remove page step ${index + 1}`}
        >
          Remove
        </button>
      </div>
      <label className="choice">
        <input type="checkbox" checked={overrides} onChange={(event) => setOverrides(event.target.checked)} />
        Override the type's rules for this step
      </label>
      {overrides ? <RuleFields rules={step} onChange={onChange} label={`Step ${index + 1}`} /> : null}
      <Inline problems={problems} />
    </li>
  );
}

/**
 * Form editor for a blueprint: a Types panel (template, limits, content rules) and an ordered,
 * draggable Pages panel. Standalone: value/onChange with no route coupling (US-10 reuses it).
 */
export function BlueprintEditor({
  value,
  onChange,
  templates,
  problems = [],
}: {
  value: Blueprint;
  onChange: (value: Blueprint) => void;
  /** Template names the blueprint may use. */
  templates: string[];
  problems?: Problem[];
}) {
  const types = Object.keys(value.types);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = value.pages.map((_, index) => `step-${index}`);
  const setPages = (pages: Step[]) => onChange({ ...value, pages });
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setPages(arrayMove(value.pages, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))));
  };
  const addType = () => {
    let index = types.length + 1;
    while (`type-${index}` in value.types) index += 1;
    onChange({ ...value, types: { ...value.types, [`type-${index}`]: {} } });
  };
  return (
    <div className="blueprint-editor">
      <section aria-labelledby="types-title">
        <h2 id="types-title">Types</h2>
        <ul className="bp-list">
          {Object.entries(value.types).map(([name, rules], index) => (
            <TypeCard
              key={`${index}-${name}`}
              name={name}
              rules={rules ?? {}}
              templates={templates}
              problems={problems.filter((problem) => problem.where === `types.${name}`)}
              onRename={(to) => onChange(renameType(value, name, to))}
              onChange={(next) => onChange({ ...value, types: { ...value.types, [name]: next } })}
              onRemove={() => onChange({ ...value, types: setKey(value.types, name, undefined) })}
            />
          ))}
        </ul>
        <button type="button" onClick={addType}>
          Add type
        </button>
      </section>
      <section aria-labelledby="pages-title">
        <h2 id="pages-title">Pages</h2>
        <p className="muted">Slides must follow these steps in order. Drag a step to reorder it.</p>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <ol className="bp-list">
              {value.pages.map((step, index) => (
                <StepCard
                  key={ids[index]}
                  id={ids[index]!}
                  index={index}
                  step={step}
                  types={types}
                  problems={problems.filter((problem) => problem.where === `pages.${index + 1}`)}
                  onChange={(next) => setPages(value.pages.map((item, at) => (at === index ? next : item)))}
                  onRemove={() => setPages(value.pages.filter((_, at) => at !== index))}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
        <button type="button" onClick={() => setPages([...value.pages, { type: types[0] ?? "" }])}>
          Add page step
        </button>
        <Inline problems={problems.filter((problem) => problem.where === "blueprint")} />
      </section>
    </div>
  );
}
