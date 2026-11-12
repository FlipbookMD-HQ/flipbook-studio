import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";

/** A controlled CodeMirror 6 Markdown editor. External value changes (reload) replace the document. */
export function MarkdownEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(onChange);
  latest.current = onChange;

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      doc: value,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": "Markdown" }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) latest.current(update.state.doc.toString());
        }),
      ],
    });
    view.current = editor;
    return () => editor.destroy();
    // The editor is created once; `value` changes are synced below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div ref={host} className="markdown-editor" />;
}
