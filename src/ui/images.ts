// US-16: the Markdown text edits behind Insert image, Replace image, and drop or paste.

/** A deck image path as a Markdown link target: segments encoded, parentheses too. */
export function imageTarget(assetPath: string): string {
  return assetPath
    .split("/")
    .map((part) => encodeURIComponent(part).replace(/\(/g, "%28").replace(/\)/g, "%29"))
    .join("/");
}

/** Alt text that can't break out of `![…]`. */
export function cleanAlt(alt: string): string {
  return alt
    .replace(/[[\]\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A default alt text from the file name: "assets/team-photo-2.png" → "team photo 2". */
export function altFromPath(assetPath: string): string {
  const name = assetPath.split("/").pop() ?? "";
  return (
    name
      .replace(/\.[^.]+$/, "")
      .replace(/[-_]+/g, " ")
      .trim() || "image"
  );
}

export function imageLine(alt: string, assetPath: string): string {
  return `![${cleanAlt(alt)}](${imageTarget(assetPath)})`;
}

/**
 * The text to insert at `pos` so the image line sits in its own paragraph: blank lines are added
 * only where the neighbours don't already provide them.
 */
export function imageInsertion(doc: string, pos: number, line: string): string {
  const before = doc.slice(0, pos);
  const after = doc.slice(pos);
  const lead = before === "" || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const trail = after === "" ? "\n" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  return `${lead}${line}${trail}`;
}

// A Markdown image: ![alt](target) or ![alt](target "title"), target possibly in <angle brackets>.
const IMAGE = /!\[((?:\\.|[^\]\\])*)\]\(\s*(<[^>]*>|[^\s)]+)(\s+"[^"]*")?\s*\)/;

/** True when the Markdown has an image `replaceFirstImage` can swap. */
export function hasImage(markdown: string): boolean {
  return IMAGE.test(markdown);
}

/** Swaps the first image's alt and target, keeping its title; null when there is no image. */
export function replaceFirstImage(markdown: string, alt: string, assetPath: string): string | null {
  const match = IMAGE.exec(markdown);
  if (!match) return null;
  const replacement = `![${cleanAlt(alt)}](${imageTarget(assetPath)}${match[3] ?? ""})`;
  return markdown.slice(0, match.index) + replacement + markdown.slice(match.index + match[0].length);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
