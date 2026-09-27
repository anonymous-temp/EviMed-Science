// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The writing rules a string can be checked for mechanically, held on every
 * 循证 GEO file (spec §5.3, §14.1, §13.7; the lead's 2026-09-27 GEO sweep) —
 * the same rules `app/copyRules.test.ts` holds on the design system, which
 * can take this scope over once it widens to the whole app:
 *
 *  - quotation marks are “” (and ‘’ inside them), never 「」『』;
 *  - status text is 正在 + a verb with no ellipsis, and never 加载中;
 *  - Chinese is set at 400 or 600: no `font-medium`, no `font-bold`.
 *
 * Comments are exempt: they quote old copy to say why it went.
 */
const SRC = fileURLToPath(new URL("../..", import.meta.url));
const SCOPE = ["components/geo", "components/charts", "lib/geoClient.ts"];

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

const sources = [
  ...SCOPE.flatMap((path) => files(join(SRC, path))),
  ...readdirSync(join(SRC, "app/routes")).filter((name) => name.startsWith("Geo")).map((name) => join(SRC, "app/routes", name)),
].filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path));

const offenders = (rule: RegExp) => sources.filter((path) => rule.test(code(readFileSync(path, "utf8")))).map((path) => relative(SRC, path));

describe("循证 GEO copy follows the writing rules", () => {
  it("walks the files it names", () => {
    const names = sources.map((path) => relative(SRC, path));
    expect(names.length).toBeGreaterThan(30);
    expect(names).toEqual(expect.arrayContaining(["components/geo/tabs/OverviewTab.tsx", "components/charts/TrendChart.tsx", "app/routes/GeoProjectPage.tsx"]));
  });

  it("quotes with “”, never 「」 or 『』", () => {
    expect(offenders(/[「」『』]/)).toEqual([]);
  });

  it("writes status as 正在 + a verb, without an ellipsis, and never 加载中", () => {
    expect(offenders(/(正在[^"'`\n]{0,12}|[一-鿿]中)(…|\.\.\.)|加载中/)).toEqual([]);
  });

  it("sets Chinese at 400 or 600 only", () => {
    expect(offenders(/\bfont-(medium|bold)\b/)).toEqual([]);
  });
});
