// @vitest-environment node
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import baseline from "./layout-lint-baseline.json";

/**
 * The page framework's lint rules (`.eslintrc.cjs`, the layout block) are errors; the files that still break one are on
 * `layout-lint-baseline.json`, where the import rule is a warning. This holds each of those files to its recorded number of sites —
 * it may fall, it may not rise — and the list to what is true: a file that is clean leaves it (r19-guards2, 2026-10-17).
 */
const WEB = fileURLToPath(new URL("../..", import.meta.url));
const files = baseline.files as Record<string, number>;
const eslint = new ESLint({ cwd: WEB });

/** The layout sites of one result: the import rule is the layout block's alone. */
const layoutSites = (result: ESLint.LintResult) => result.messages.filter((message) => message.ruleId === "no-restricted-imports");

describe("the page framework's lint rules", () => {
  it("hold every file on the baseline to its recorded number, and a clean file leaves the list", async () => {
    const results = await eslint.lintFiles(Object.keys(files));
    const rose: string[] = [];
    const lower: string[] = [];
    for (const result of results) {
      const name = result.filePath.slice(WEB.length).split("\\").join("/").replace(/^\//, "");
      const now = layoutSites(result).length;
      const was = files[name] ?? 0;
      if (now > was) rose.push(`${name}: ${now} now, ${was} recorded`);
      if (now < was) lower.push(`${name}: ${was} -> ${now}`);
      // On the list the rule is a warning; nothing else of the layout block is downgraded there.
      for (const message of layoutSites(result)) expect(message.severity, name).toBe(1);
    }
    expect(results.length, "every file on the list exists").toBe(Object.keys(files).length);
    expect(rose, "a page-framework site was added to a file on the baseline: use PageShell's slots or a Toolbar").toEqual([]);
    expect(lower, "layout-lint-baseline.json can be lowered (a file at 0 leaves the list)").toEqual([]);
  }, 120_000);

  it("records a total that is the sum of its files", () => {
    expect(Object.values(files).reduce((a, b) => a + b, 0)).toBe(baseline.total);
  });

  it("is an error in a file not on the list, and a warning in one on it", async () => {
    const code = 'import { FilterChips } from "@/components/ui/FilterChips";\nexport const used = FilterChips;\n';
    const [fresh] = await eslint.lintText(code, { filePath: `${WEB}/src/app/routes/NewPageNobodyWrote.tsx` });
    expect(layoutSites(fresh).map((message) => message.severity)).toEqual([2]);
    const listed = Object.keys(files).find((name) => name.startsWith("src/app/") || name.startsWith("src/components/"));
    if (listed) {
      const [held] = await eslint.lintText(code, { filePath: `${WEB}/${listed}` });
      expect(layoutSites(held).map((message) => message.severity)).toEqual([1]);
    }
    const [tag] = await eslint.lintText('import { tagClasses } from "@/components/ui/Tag";\nexport const used = tagClasses;\n', { filePath: `${WEB}/src/lib/anything.ts` });
    expect(layoutSites(tag).map((message) => message.severity)).toEqual([2]);
  }, 60_000);
});
