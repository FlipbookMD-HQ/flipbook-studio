import { describe, expect, it } from "vitest";
import { copyName, copyTitle, deckBaseName } from "../src/ui/screens/Duplicate.js";

// US-20 · 2.2.1: the names and titles the Duplicate dialogs suggest.

describe("Duplicate suggestions", () => {
  it("suggests <name>-copy, then -copy-2, -copy-3 when taken, ignoring case", () => {
    expect(copyName("talk", ["talk"])).toBe("talk-copy");
    expect(copyName("talk", ["talk", "TALK-copy"])).toBe("talk-copy-2");
    expect(copyName("talk", ["talk-copy", "talk-copy-2"])).toBe("talk-copy-3");
  });

  it("keeps names within 60 characters", () => {
    const long = "a".repeat(60);
    expect(copyName(long, [])).toHaveLength(60);
    expect(copyName(long, [])).toMatch(/-copy$/);
    expect(copyName(`${"b".repeat(54)}-x`, [])).not.toMatch(/--/);
  });

  it("suggests '<title> (copy)' within 120 characters", () => {
    expect(copyTitle("Q3 review")).toBe("Q3 review (copy)");
    expect(copyTitle("t".repeat(120))).toHaveLength(120);
  });

  it("takes the name part of a deck path", () => {
    expect(deckBaseName("talk")).toBe("talk");
    expect(deckBaseName("intro.slide.md")).toBe("intro");
    expect(deckBaseName("talks/q3")).toBe("q3");
  });
});
