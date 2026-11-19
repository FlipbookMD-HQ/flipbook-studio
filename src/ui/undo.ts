// US-17: the pure parts of Undo and Redo in the UI.

/** Fired on window after any successful write through the API, so the history labels refresh. */
export const DECK_WRITTEN = "flipbook:deck-written";

/** True for keys typed into a field or a code editor, where Ctrl/Cmd+Z is text undo. */
export function isTextTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false;
  const element = target as Element;
  return Boolean(element.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
}

/** "undo" or "redo" for Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (and Ctrl+Y), else null. */
export function undoShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): "undo" | "redo" | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && event.ctrlKey && !event.metaKey && !event.shiftKey) return "redo";
  return null;
}

/** Writes that can change a deck's history (anything but reads, previews and AI streams). */
export function isDeckWrite(method: string, url: string): boolean {
  if (method === "GET" || method === "HEAD") return false;
  if (/^\/api\/decks\/[^/]+\/(versions\/[^/]+\/restore|discard)$/.test(url)) return true; // US-26
  return /^\/api\/(decks\/[^/]+\/(slides|order|assets)|proposals\/[^/]+\/apply)/.test(url);
}
