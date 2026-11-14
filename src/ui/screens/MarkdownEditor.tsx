import { useEffect, useRef, type MutableRefObject } from "react";
import { EditorView, basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";

/** Files dropped or pasted into the editor, with the document position they landed at. */
export type FilesHandler = (files: File[], pos: number) => void;

/**
 * A controlled CodeMirror 6 Markdown editor. External value changes (reload) replace the document.
 * `viewRef` exposes the editor (cursor, inserts); `onFiles` takes dropped or pasted files (US-16).
 */
export function MarkdownEditor({
  value,
  onChange,
  viewRef,
  onFiles,
}: {
  value: string;
  onChange: (value: string) => void;
  viewRef?: MutableRefObject<EditorView | null>;
  onFiles?: FilesHandler;
}) {
  return (
    <CodeEditor
      value={value}
      onChange={onChange}
      language="markdown"
      label="Markdown"
      viewRef={viewRef}
      onFiles={onFiles}
    />
  );
}

const filesOf = (data: DataTransfer | null): File[] => [...(data?.files ?? [])];

/** A controlled CodeMirror 6 editor for Markdown or CSS. */
export function CodeEditor({
  value,
  onChange,
  language,
  label,
  viewRef,
  onFiles,
}: {
  value: string;
  onChange: (value: string) => void;
  /** yaml is shown as plain text (no extra language package). */
  language: "markdown" | "css" | "yaml";
  label: string;
  viewRef?: MutableRefObject<EditorView | null>;
  onFiles?: FilesHandler;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(onChange);
  latest.current = onChange;
  const latestFiles = useRef(onFiles);
  latestFiles.current = onFiles;

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      doc: value,
      extensions: [
        basicSetup,
        ...(language === "css" ? [css()] : language === "markdown" ? [markdown()] : []),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": label }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) latest.current(update.state.doc.toString());
        }),
        // Dropped or pasted files go to onFiles instead of being read in as text.
        EditorView.domEventHandlers({
          drop(event, editorView) {
            const files = filesOf(event.dataTransfer);
            if (!latestFiles.current || !files.length) return false;
            event.preventDefault();
            const pos =
              editorView.posAtCoords({ x: event.clientX, y: event.clientY }) ??
              editorView.state.selection.main.head;
            latestFiles.current(files, pos);
            return true;
          },
          paste(event, editorView) {
            const files = filesOf(event.clipboardData);
            if (!latestFiles.current || !files.length) return false;
            event.preventDefault();
            latestFiles.current(files, editorView.state.selection.main.head);
            return true;
          },
        }),
      ],
    });
    view.current = editor;
    if (viewRef) viewRef.current = editor;
    return () => {
      if (viewRef) viewRef.current = null;
      editor.destroy();
    };
    // The editor is created once; `value` changes are synced below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div ref={host} className="markdown-editor" data-testid={`${language}-editor`} />;
}
