// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * A tooltip is the `Tooltip` primitive (spec §22.8; appendix E.6 #8), never
 * the browser's `title`: the native one has the browser's own delay and look,
 * never opens on keyboard focus and cannot be dismissed with Escape. So no
 * element the shell draws carries `title` — on an intrinsic element, or on a
 * component that hands its props to one (`Link`, `NavLink`, `Button`,
 * `Switch`, the inputs) — except where `title` is not a tooltip at all: an
 * `<iframe>`'s `title` is its accessible name, and an `<abbr>`'s is its
 * expansion. The walk is over the parsed JSX, so a comment or a string that
 * mentions `title=` cannot trip it.
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));
/** Where `title` means something other than a tooltip. */
const NOT_A_TOOLTIP = new Set(["iframe", "abbr"]);
/** Components that pass `title` straight to the element they draw. */
const FORWARDS_TO_DOM = new Set(["Link", "NavLink", "Button", "Switch", "SearchInput", "Input", "Textarea"]);

function files(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) => files(join(path, entry)));
}

const sources = files(SRC).filter((path) => path.endsWith(".tsx") && !/\.test\.tsx$/.test(path));

function nativeTitles(path: string): { line: number; tag: string }[] {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: { line: number; tag: string }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      const native = /^[a-z]/.test(tag) || FORWARDS_TO_DOM.has(tag);
      const titled = node.attributes.properties.some((attr) => ts.isJsxAttribute(attr) && attr.name.getText(source) === "title");
      if (native && titled) found.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, tag });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("native title attributes", () => {
  const all = sources.flatMap((path) => nativeTitles(path).map((entry) => ({ ...entry, path: relative(SRC, path) })));

  it("are not tooltips anywhere in the shell: the Tooltip primitive is", () => {
    const offenders = all.filter((entry) => !NOT_A_TOOLTIP.has(entry.tag)).map((entry) => `${entry.path}:${entry.line} <${entry.tag} title>`);
    expect(offenders).toEqual([]);
  });

  it("walked the shell, and found the titles that are names", () => {
    expect(sources.length).toBeGreaterThan(120);
    // The frames name themselves with `title`, as an iframe must.
    expect(all.filter((entry) => entry.tag === "iframe").map((entry) => entry.path)).toEqual(expect.arrayContaining([
      "app/routes/RuntimeUiFrame.tsx",
      "components/inspector/FilePreviewInspector.tsx",
    ]));
  });
});
