import { describe, expect, it } from "vitest";
import { isDeckWrite, isTextTarget, undoShortcut } from "../src/ui/undo.js";

// US-17: when the UI treats a key as Undo or Redo, and which requests refresh the history.
const key = (
  key: string,
  mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {},
) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});
const element = (matches: boolean) => ({ closest: () => (matches ? {} : null) }) as unknown as EventTarget;

describe("undo shortcuts", () => {
  it("maps Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl+Y", () => {
    expect(undoShortcut(key("z", { metaKey: true }))).toBe("undo");
    expect(undoShortcut(key("z", { ctrlKey: true }))).toBe("undo");
    expect(undoShortcut(key("Z", { metaKey: true, shiftKey: true }))).toBe("redo");
    expect(undoShortcut(key("y", { ctrlKey: true }))).toBe("redo");
    expect(undoShortcut(key("y", { metaKey: true }))).toBeNull();
    expect(undoShortcut(key("z"))).toBeNull();
    expect(undoShortcut(key("z", { ctrlKey: true, altKey: true }))).toBeNull();
    expect(undoShortcut(key("s", { metaKey: true }))).toBeNull();
  });

  it("leaves text fields and editors to their own undo", () => {
    expect(isTextTarget(element(true))).toBe(true);
    expect(isTextTarget(element(false))).toBe(false);
    expect(isTextTarget(null)).toBe(false);
    expect(isTextTarget({} as EventTarget)).toBe(false);
  });

  it("refreshes the history after deck writes only", () => {
    expect(isDeckWrite("PUT", "/api/decks/dGFsaw/slides/slides%2F01.slide.md")).toBe(true);
    expect(isDeckWrite("POST", "/api/decks/dGFsaw/slides")).toBe(true);
    expect(isDeckWrite("DELETE", "/api/decks/dGFsaw/slides/x?baseHash=1")).toBe(true);
    expect(isDeckWrite("PUT", "/api/decks/dGFsaw/order")).toBe(true);
    expect(isDeckWrite("POST", "/api/decks/dGFsaw/assets")).toBe(true);
    expect(isDeckWrite("DELETE", "/api/decks/dGFsaw/assets/a.png")).toBe(true);
    expect(isDeckWrite("POST", "/api/proposals/p1/apply")).toBe(true);
    expect(isDeckWrite("GET", "/api/decks/dGFsaw/assets")).toBe(false);
    expect(isDeckWrite("POST", "/api/decks/dGFsaw/preview")).toBe(false);
    expect(isDeckWrite("POST", "/api/decks/dGFsaw/undo")).toBe(false);
    expect(isDeckWrite("PUT", "/api/settings")).toBe(false);
  });
});
