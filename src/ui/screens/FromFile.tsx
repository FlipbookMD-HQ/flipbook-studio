import { useRef, useState, type DragEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import type { SourceDocument } from "../../shared/api";
import { SOURCE_EXTENSIONS, SOURCE_MAX_BYTES } from "../../shared/api";
import { ApiRequestError, uploadSource } from "../api";
import { droppedText, plural } from "../sourceText";

// US-18: pick or drop a .md, .txt or .docx; Studio reads it and shows what it found before anything
// is created (tech-spec D22-D24).

const FORMAT_NAMES: Record<SourceDocument["format"], string> = {
  md: "Markdown",
  txt: "Text",
  docx: "Word",
};

const sizeText = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} kB`;

export function FromFile({
  source,
  onSource,
  disabled,
}: {
  source: SourceDocument | null;
  onSource: (source: SourceDocument | null) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: uploadSource,
    onSuccess: ({ source: read }) => onSource(read),
  });
  const error =
    localError ??
    (upload.error instanceof ApiRequestError
      ? upload.error.error.message
      : upload.error
        ? String(upload.error.message)
        : null);

  const pick = (file: File | undefined) => {
    if (!file) return;
    setLocalError(null);
    upload.reset();
    onSource(null);
    // The server checks again; these answer at once without sending 25 MB first.
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (!(SOURCE_EXTENSIONS as readonly string[]).includes(ext))
      return setLocalError("Pick a Markdown, text or Word (.docx) file.");
    if (file.size > SOURCE_MAX_BYTES) return setLocalError("Files can be at most 25 MB.");
    upload.mutate(file);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (!disabled) pick(event.dataTransfer.files[0]);
  };

  return (
    <fieldset className="field from-file" disabled={disabled}>
      <legend>File</legend>
      <div
        className={dragging ? "drop-zone dragging" : "drop-zone"}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p>
          {upload.isPending ? (
            <span role="status">Reading the file…</span>
          ) : (
            <>
              Drop a <code>.md</code>, <code>.txt</code> or <code>.docx</code> file here, or{" "}
              <button type="button" className="link" onClick={() => input.current?.click()}>
                choose one
              </button>
              . Up to 25 MB.
            </>
          )}
        </p>
        <input
          ref={input}
          type="file"
          hidden
          aria-label="Source file"
          accept=".md,.markdown,.txt,.docx"
          onChange={(event) => {
            pick(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {source ? (
        <section className="source-preview" aria-label="What Studio read">
          <h3>{source.title}</h3>
          <p className="hint">
            {source.fileName} · {FORMAT_NAMES[source.format]} · {plural(source.sections, "section")} ·{" "}
            {plural(source.chars, "character")}
          </p>
          {source.images.length ? (
            <ul className="image-grid source-images" aria-label="Images">
              {source.images.map((image) => (
                <li key={image.id}>
                  {image.thumbnail ? (
                    <img src={image.thumbnail} alt={image.name} />
                  ) : (
                    <span className="thumb-placeholder" aria-hidden="true" />
                  )}
                  <small>
                    {image.name}
                    <br />
                    {image.width && image.height ? `${image.width}×${image.height} · ` : ""}
                    {sizeText(image.bytes)}
                  </small>
                </li>
              ))}
            </ul>
          ) : null}
          {source.dropped.length ? (
            <div className="dropped">
              <p>Left out:</p>
              <ul>
                {source.dropped.map((item) => (
                  <li key={`${item.kind}:${item.reason}:${item.detail ?? ""}`}>{droppedText(item)}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
    </fieldset>
  );
}
