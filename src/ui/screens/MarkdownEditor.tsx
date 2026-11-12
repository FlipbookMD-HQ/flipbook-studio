import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";

/** A controlled CodeMirror 6 Markdown editor. External value changes (reload) replace the document. */
export function MarkdownEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <CodeEditor value={value} onChange={onChange} language="markdown" label="Markdown" />;
}

/** A controlled CodeMirror 6 editor for Markdown or CSS. */
export function CodeEditor({
  value,
  onChange,
  language,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  language: "markdown" | "css";
  label: string;
}) {
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
        language === "css" ? css() : markdown(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": label }),
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
