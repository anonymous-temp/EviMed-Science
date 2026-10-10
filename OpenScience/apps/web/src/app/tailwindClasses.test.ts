// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import tailwindConfig from "../../tailwind.config.js";

/**
 * A class that Tailwind has no utility for emits no CSS, and nothing says so.
 *
 * ESLint bans arbitrary values and retired names, and TypeScript sees a class as a
 * string, so a mistyped one passes both and the element simply loses the rule: on
 * 2026-10-10 `max-w-body` (nine uses, in the drug-value section and the task pane)
 * and `min-h-control-primary` had been drawing without their measure and their
 * minimum height since they were written — the tokens are `max-w-measure` and
 * `min-h-form-primary`.
 *
 * This reads every string and template literal under `src` (not comments, not JSX
 * text), sends each class-shaped token through the app's own `tailwind.config.js`
 * and PostCSS, and fails naming any token that was meant as a class — it shares a
 * family prefix (`max-w-`, `min-h-`, `bg-`) with classes that do generate CSS — and
 * produced none. A token that is not a class at all (an HTTP header, an enum value,
 * CSS text) goes in `NOT_UTILITIES` with its reason.
 */
const WEB = fileURLToPath(new URL("../..", import.meta.url));
const SRC = join(WEB, "src");

const require = createRequire(import.meta.url);
const postcss = require("postcss");
const tailwind = require("tailwindcss");
// The parser Tailwind itself escapes selectors with: a class such as
// `grid-cols-[auto_minmax(0,1fr)]` is `\[`…`\2c ` in the sheet, and only a parser reads it back.
const selectorParser = createRequire(require.resolve("tailwindcss"))("postcss-selector-parser");

/** Strings that look like a utility and are not one. Each names why; a stale entry fails below. */
const NOT_UTILITIES: Readonly<Record<string, string>> = {
  "content-type": "an HTTP header name",
  "content-disposition": "an HTTP header name",
  "font-size": "a tailwind-merge class-group name (lib/cn.ts)",
  "min-h": "a tailwind-merge class-group name (lib/cn.ts)",
  "not-assessed": "an enum value (lib/resultProvenance.ts)",
  "not-configured": "an enum value (lib/imClient.ts)",
  "not-offered": "an enum value (app/routes/FrontierEventPage.tsx)",
  "width:max-content": "CSS text written into a rendered Office document",
};

/** A class the shell must never ship: the tokens are `var()` colours, so Tailwind emits nothing for an opacity modifier on one. */
// eslint-disable-next-line no-restricted-syntax -- the probe needs the dead class itself, and the rule that bans it would otherwise forbid the proof it is seen
const OPACITY_ON_TOKEN = "bg-accent/10";

function files(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) => files(join(path, entry)));
}

const sources = files(SRC).filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) && !path.endsWith(".d.ts") && !/__fixtures__|\/test\//.test(path));

/** Every whitespace-separated token of every string a source file holds, with where it is. */
function stringTokens(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const path of sources) {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        const where = `${relative(SRC, path)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
        for (const token of node.text.split(/\s+/)) {
          if (!token) continue;
          const places = found.get(token) ?? [];
          if (places.length < 3) places.push(where);
          found.set(token, places);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

/** The characters a Tailwind class can be written with, arbitrary values included. */
const CLASS_SHAPED = /^[!a-z0-9:[\]/_.,()%#&>*~='"@+$-]+$/i;

/** A token without its variants (`md:hover:`), its important mark and its negation. */
function baseOf(token: string): string {
  let depth = 0;
  let current = "";
  for (const character of token) {
    if (character === "[") depth += 1;
    if (character === "]") depth -= 1;
    if (character === ":" && depth === 0) current = "";
    else current += character;
  }
  return current.replace(/^!/, "").replace(/^-/, "");
}

/**
 * The class-shaped tokens among `tokens` that were meant as a class and have none: no CSS came out for them, and
 * their family (everything before a trailing `-segment`) is one that other tokens did get CSS for.
 */
async function withoutUtility(tokens: readonly string[]): Promise<{ missing: string[]; emitted: Set<string> }> {
  const candidates = tokens.filter((token) => token.length <= 120 && CLASS_SHAPED.test(token) && /[a-z]/i.test(token));
  const config = { ...tailwindConfig, content: [{ raw: candidates.join(" ") }], corePlugins: { preflight: false } };
  const result = await postcss([tailwind(config)]).process("@tailwind utilities;", { from: undefined });
  const selectors: string[] = [];
  postcss.parse(result.css).walkRules((rule: { selector: string }) => selectors.push(rule.selector));
  const emitted = new Set<string>();
  selectorParser((root: { walkClasses: (visit: (node: { value: string }) => void) => void }) => root.walkClasses((node) => emitted.add(node.value))).processSync(selectors.join(",\n"));

  const families = new Set<string>();
  for (const name of emitted) {
    const base = baseOf(name);
    for (let at = base.indexOf("-"); at >= 0; at = base.indexOf("-", at + 1)) families.add(base.slice(0, at + 1));
  }
  const intended = (token: string) => {
    const base = baseOf(token);
    for (let at = base.lastIndexOf("-"); at > 0; at = base.lastIndexOf("-", at - 1)) {
      if (base.slice(at + 1) && families.has(base.slice(0, at + 1))) return true;
    }
    return false;
  };
  return { missing: candidates.filter((token) => !emitted.has(token) && intended(token)), emitted };
}

describe("every Tailwind class in the source generates CSS", () => {
  const tokens = stringTokens();

  it("walked the whole shell and read the stylesheet back", async () => {
    // Prove the walk walked before trusting what it did not find.
    expect(sources.length).toBeGreaterThan(300);
    expect(tokens.size).toBeGreaterThan(5000);
    const { emitted } = await withoutUtility([...tokens.keys()]);
    expect(emitted.size).toBeGreaterThan(700);
    for (const known of ["max-w-measure", "max-w-wide", "text-ui", "bg-surface", "sr-only"]) expect(emitted.has(known)).toBe(true);
    // Variants, and arbitrary values with the characters CSS escapes, come back out of the sheet.
    expect([...emitted].some((name) => name.startsWith("hover:"))).toBe(true);
    expect([...emitted].some((name) => name.includes("[") && name.includes(","))).toBe(true);
  });

  it("finds no class that was meant and has none", async () => {
    const { missing } = await withoutUtility([...tokens.keys()]);
    const unexplained = missing.filter((token) => !(token in NOT_UTILITIES));
    expect(unexplained.map((token) => `${token.padEnd(32)} ${(tokens.get(token) ?? []).join("  ")}`)).toEqual([]);
  });

  it("lists only strings that are still in the source", () => {
    expect(Object.keys(NOT_UTILITIES).filter((token) => !tokens.has(token))).toEqual([]);
  });

  it("would see a mistyped class, a mistyped variant and an opacity modifier on a token colour", async () => {
    const probe = await withoutUtility(["max-w-measure", "max-w-body", "min-h-form-primary", "min-h-control-primary", "hover:bg-surface-2", "hoverr:bg-surface-2", "bg-surface", OPACITY_ON_TOKEN, "grid-cols-[auto_minmax(0,1fr)]", "flex"]);
    expect(probe.missing).toEqual(["max-w-body", "min-h-control-primary", "hoverr:bg-surface-2", OPACITY_ON_TOKEN]);
  });
});
