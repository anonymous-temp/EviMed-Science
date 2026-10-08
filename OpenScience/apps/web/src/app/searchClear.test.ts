// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * A search box with text in it has a way out (design reference §3.5, §9.1): the
 * `SearchInput` primitive hides the browser's own cancel glyph, so a box that
 * does not pass `onClear` leaves the query to be deleted by hand, with no
 * 「清除搜索」 button and no Escape. This walks the parsed JSX of every product
 * page and fails on a `<SearchInput>` without `onClear`, and on any other
 * `type="search"` input that hides the browser's clear button without drawing
 * one of its own.
 *
 * `PENDING` is the boxes that belong to another R13 work package (the GEO
 * tabs, the knowledge-base page and the task page) and are wired there; each
 * is a path whose boxes this test does not yet hold. Empty the list the
 * moment those pages carry `onClear` — a path that is gone is reported.
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));

/** The gallery draws the primitive bare, to show its states. */
const NOT_A_PRODUCT_PAGE = new Set(["app/routes/GalleryPage.tsx"]);

/** Boxes wired by the package that owns the page, not by this test's author. */
const PENDING = new Set([
  "app/routes/AutopilotPage.tsx",
  "app/routes/SourcesPage.tsx",
  "components/geo/tabs/ContentTab.tsx",
  "components/geo/tabs/EvidenceTab.tsx",
  "components/geo/tabs/QuestionsTab.tsx",
  "components/geo/tabs/SourcesTab.tsx",
]);

function files(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) => files(join(path, entry)));
}

const sources = files(SRC).filter((path) => path.endsWith(".tsx") && !/\.test\.tsx$/.test(path));

function searchBoxes(path: string): { line: number; tag: string; clearable: boolean }[] {
  const text = readFileSync(path, "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: { line: number; tag: string; clearable: boolean }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
      const named = (name: string) => attrs.some((attr) => attr.name.getText(source) === name);
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      if (tag === "SearchInput") found.push({ line, tag, clearable: named("onClear") });
      if (tag === "input" && attrs.some((attr) => attr.name.getText(source) === "type" && /["']search["']/.test(attr.initializer?.getText(source) ?? ""))) {
        // A hand-made search field is fine while it draws its own clear button next to it.
        found.push({ line, tag, clearable: /label="清除搜索"/.test(text) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("search boxes can be cleared", () => {
  const all = sources
    .filter((path) => !relative(SRC, path).startsWith("components/ui/"))
    .flatMap((path) => searchBoxes(path).map((box) => ({ ...box, path: relative(SRC, path) })))
    .filter((box) => !NOT_A_PRODUCT_PAGE.has(box.path));

  it("walked the product pages and found their search boxes", () => {
    expect(sources.length).toBeGreaterThan(120);
    expect(all.length).toBeGreaterThanOrEqual(15);
    expect(all.map((box) => box.path)).toEqual(expect.arrayContaining([
      "app/routes/MemoryHubPage.tsx",
      "app/routes/CapabilitiesPage.tsx",
      "app/routes/FrontierPage.tsx",
    ]));
  });

  it("gives every product-page search box a clear button and Escape", () => {
    const offenders = all
      .filter((box) => !box.clearable && !PENDING.has(box.path))
      .map((box) => `${box.path}:${box.line} <${box.tag}> has no onClear`);
    expect(offenders).toEqual([]);
  });

  it("names only pages that still exist in the pending list", () => {
    const present = new Set(sources.map((path) => relative(SRC, path)));
    expect([...PENDING].filter((path) => !present.has(path))).toEqual([]);
  });
});
