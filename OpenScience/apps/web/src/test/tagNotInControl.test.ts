import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { shellSources } from "./sourceStrings";

/**
 * A tag is a label and is never part of a control (DESIGN.md rule 7; the walk's `tag-as-control`). The frontier's hot list drew its 「新」
 * and 「升温」 inside the row's link, and no test found it because no fixture held a hot event with a badge. This reads the sources instead:
 * a `<Tag>` whose ancestors in the JSX include a link, a button or a row's `title` (which `ListRow` draws as its link) is the defect,
 * wherever it stands and whatever data the page holds.
 */
const CONTROLS = new Set(["Link", "a", "button", "NavLink", "Button", "IconButton", "FilterChip", "summary", "ListRow.title"]);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/** The places a `<Tag>` stands inside a control, in a file's text. */
export function tagsInControls(text: string, name = "sample.tsx"): string[] {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const nameOf = (node: ts.JsxElement | ts.JsxSelfClosingElement) => (ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName).getText();
  const visit = (node: ts.Node, stack: readonly string[]) => {
    let next = stack;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = nameOf(node);
      if (tag === "Tag") {
        const inside = stack.filter((entry) => CONTROLS.has(entry));
        if (inside.length > 0) found.push(`${name}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} <Tag> inside ${inside.join(" > ")}`);
      }
      next = [...stack, tag];
    }
    // `ListRow`'s `title` is the row's link.
    if (ts.isJsxAttribute(node) && node.name.getText() === "title" && ts.isJsxAttributes(node.parent)) {
      const owner = node.parent.parent;
      if ((ts.isJsxOpeningElement(owner) || ts.isJsxSelfClosingElement(owner)) && owner.tagName.getText() === "ListRow") next = [...stack, "ListRow.title"];
    }
    ts.forEachChild(node, (child) => visit(child, next));
  };
  visit(source, []);
  return found;
}

describe("a Tag in a control", () => {
  it("is nowhere in the shell's sources", () => {
    const found = shellSources(root)
      .filter((path) => path.endsWith(".tsx"))
      // The gallery is the developer's page of the primitives, and draws a row's tag for what it looks like beside a title.
      .filter((path) => !/routes\/GalleryPage\.tsx$/.test(path))
      .flatMap((path) => tagsInControls(readFileSync(path, "utf8"), relative(root, path)));
    expect(found).toEqual([]);
  });

  it("reads a Tag inside a Link, a button and a ListRow title as the defect it is, and a Tag beside a link as fine", () => {
    // The scan is only worth anything if it can fail.
    const code = [
      "export const a = <Link to=\"/x\"><Tag>新</Tag></Link>;",
      "export const b = <button type=\"button\"><span><Tag>新</Tag></span></button>;",
      "export const c = <ListRow title={<span><Tag>新</Tag></span>} />;",
      "export const d = <div><Tag>新</Tag><Link to=\"/x\">标题</Link></div>;",
      "export const e = <ListRow title=\"标题\" trailing={<Tag>新</Tag>} />;",
    ].join("\n");
    expect(tagsInControls(code).map((line) => line.replace(/^sample\.tsx:/, ""))).toEqual([
      "1 <Tag> inside Link",
      "2 <Tag> inside button",
      "3 <Tag> inside ListRow.title",
    ]);
  });
});
