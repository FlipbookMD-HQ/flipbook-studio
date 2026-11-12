import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("ESLint security rules", () => {
  it("fails on dangerouslySetInnerHTML in the UI", async () => {
    const eslint = new ESLint({ cwd: root });
    const source =
      "export const Bad = ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html }} />;\n";
    const [result] = await eslint.lintText(source, { filePath: path.join(root, "src/ui/screens/Bad.tsx") });
    expect(result!.errorCount).toBeGreaterThan(0);
    expect(result!.messages.map((message) => message.message)).toContain(
      "Render slide HTML only in the sandboxed preview iframe.",
    );
  });
});
