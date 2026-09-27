// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The writing rules a string can be checked for mechanically (spec §14.1,
 * §13.7; appendix E #25, #26):
 *
 *  - quotation marks are “” (and ‘’ inside them), never 「」『』, which belong
 *    to vertical and Hong Kong / Taiwan typesetting;
 *  - status text is 正在 + a verb with no ellipsis — 「加载中…」 is the shape
 *    this replaced.
 *
 * Scoped to the design system's own code — the primitives, the layout, the
 * shell, the report reader's text and the formatters — which is where a
 * string is copied from. The repo-wide sweep widens `SCOPE` as each area
 * converges; comments are exempt (they quote old copy to say why it went).
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));
const SCOPE = [
  "components/ui",
  "components/layout",
  "components/markdown-viewer",
  "app/layout/AppShell.tsx",
  "app/layout/embed.ts",
  "app/routes/GalleryPage.tsx",
  "lib/format.ts",
  "lib/toast.ts",
];

function files(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) => files(join(path, entry)));
}

/** The file without its comments: block comments, JSX comments, line comments. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
}

describe("copy follows the writing rules", () => {
  const sources = SCOPE.flatMap((path) => files(join(SRC, path))).filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path));

  it("walks the scope it names", () => {
    expect(sources.length).toBeGreaterThan(30);
    expect(sources.map((path) => relative(SRC, path))).toContain("components/ui/Toaster.tsx");
  });

  it("quotes with “”, never 「」 or 『』", () => {
    const offenders = sources.filter((path) => /[「」『』]/.test(code(readFileSync(path, "utf8")))).map((path) => relative(SRC, path));
    expect(offenders).toEqual([]);
  });

  it("writes status as 正在 + a verb, without an ellipsis", () => {
    const offenders = sources
      .filter((path) => /(正在[^"'`\n]{0,12}|[一-鿿]中)(…|\.\.\.)/.test(code(readFileSync(path, "utf8"))))
      .map((path) => relative(SRC, path));
    expect(offenders).toEqual([]);
  });

  it("strips comments before it looks, and would see a string that breaks a rule", () => {
    expect(code('const a = "x"; // 「旧」\n/* 「旧」 */ const b = "加载中…";')).not.toMatch(/「/);
    expect(/(正在[^"'`\n]{0,12}|[一-鿿]中)(…|\.\.\.)/.test(code('const b = "加载中…";'))).toBe(true);
  });
});
