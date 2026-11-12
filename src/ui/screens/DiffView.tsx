import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MergeView } from "@codemirror/merge";

const readOnly = (label: string) => [
  EditorView.editable.of(false),
  EditorState.readOnly.of(true),
  EditorView.lineWrapping,
  EditorView.contentAttributes.of({ "aria-label": label }),
];

/** A read-only side-by-side diff (CodeMirror merge view): the current text and the proposal. */
export function DiffView({ before, after, label }: { before: string; after: string; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const view = new MergeView({
      parent: host.current!,
      a: { doc: before, extensions: readOnly(`${label}: current`) },
      b: { doc: after, extensions: readOnly(`${label}: proposed`) },
      collapseUnchanged: { margin: 3, minSize: 6 },
    });
    return () => view.destroy();
  }, [before, after, label]);
  return (
    <div className="diff" data-testid="diff">
      <div className="diff-heads" aria-hidden="true">
        <span>Current</span>
        <span>Proposed</span>
      </div>
      <div ref={host} />
    </div>
  );
}
