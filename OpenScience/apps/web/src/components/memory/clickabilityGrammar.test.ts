// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The memory section's clickability grammar (owner, 2026-10-27; DESIGN.md 「Colour → Rules」 and 「页面结构」 rule 6), held in its sources so a new
 * component cannot drift back to a title in the accent that opens nothing:
 *
 *  1. Accent text means one thing — it opens or does something — so a class string that sets `text-accent` or `text-link` also underlines
 *     (a link inside a sentence is always underlined) or is the one graphic the section draws in the data colour (`MarkGlyph`).
 *  2. A selection is a ground, never accent text: the selected-row and selected-cell ground is `bg-accent-soft` with the text left in ink.
 *  3. Nothing in the section is a bare `<button>` of accent text: an action is a `Button`.
 */

const src = fileURLToPath(new URL("../..", import.meta.url));
const roots = ["components/memory", "components/capsule", "app/routes"];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__fixtures__" ? [] : sources(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}
const memory = roots.flatMap((root) => sources(join(src, root))).filter((path) => /\/(components\/(memory|capsule)\/|app\/routes\/(Memory|SharedCapsule|CapsuleTransfer))/.test(path));

/** Every `className="…"` and `cn("…")` string literal of a source, with the line it starts on. */
function classStrings(text: string): Array<{ line: number; classes: string }> {
  const found: Array<{ line: number; classes: string }> = [];
  for (const match of text.matchAll(/(?:className=|cn\()\s*\{?\s*(?:"([^"]*)"|`([^`]*)`)/g)) {
    found.push({ line: text.slice(0, match.index).split("\n").length, classes: match[1] ?? match[2] ?? "" });
  }
  return found;
}

describe("the memory section's clickability grammar", () => {
  it("reads the section's sources", () => {
    expect(memory.length).toBeGreaterThan(20);
  });

  it("underlines every link it draws in the accent: accent text is a thing to press, and colour alone does not say so (2.6:1 against body text)", () => {
    const offenders = memory.flatMap((path) => classStrings(readFileSync(path, "utf8"))
      .filter(({ classes }) => /(^|\s)(?:hover:)?text-(?:accent|link)(\s|$)/.test(classes) && !/(^|\s)underline(\s|$)/.test(classes))
      .map(({ line, classes }) => `${relative(src, path)}:${line}  ${classes}`));
    // `MarkGlyph`'s own mark and the graph's legend are graphics in the data colour the picture draws in, not words.
    const allowed = offenders.filter((line) => !/MarkGlyph\.tsx|GraphView\.tsx/.test(line));
    expect(allowed).toEqual([]);
  });

  it("never sets a selection in accent text: the selected row and cell are a ground", () => {
    const offenders = memory.flatMap((path) => classStrings(readFileSync(path, "utf8"))
      .filter(({ classes }) => /bg-accent-soft/.test(classes) && /(^|\s)text-accent(\s|$)/.test(classes))
      .map(({ line, classes }) => `${relative(src, path)}:${line}  ${classes}`));
    expect(offenders).toEqual([]);
  });

  it("draws no bare <button> of accent text that is not a link: an action is a Button (an underlined one, like 「来源对话」, goes somewhere)", () => {
    const offenders = memory.flatMap((path) => {
      const text = readFileSync(path, "utf8");
      return [...text.matchAll(/<button\b[^>]*className=(?:"([^"]*text-(?:accent|link)[^"]*)"|\{`([^`]*text-(?:accent|link)[^`]*)`\})/g)]
        .filter((match) => !/(^|\s)underline(\s|$)/.test(match[1] ?? match[2] ?? ""))
        .map((match) => `${relative(src, path)}:${text.slice(0, match.index).split("\n").length}`);
    });
    expect(offenders).toEqual([]);
  });
});
