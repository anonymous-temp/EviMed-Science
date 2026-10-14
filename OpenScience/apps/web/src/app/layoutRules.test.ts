// @vitest-environment node
import { relative } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isPageFile, scanGreySentences, scanHandwrittenLists, type Occurrence } from "../test/layoutScan";
import { shellSources } from "../test/sourceStrings";
import baseline from "./layout-baseline.json";

/**
 * Two structural rules of the page framework, held by a count that may fall and may not rise (R19, plan §3 S2 and S3; audit D
 * C3, C5 and §4). They are baselines now because 103 sentences and 46 lists are already written; each migration batch deletes
 * the ones on the pages it moves, lowers `layout-baseline.json` (this test prints what can be lowered), and the last batch
 * deletes the file and turns the counts into zero.
 *
 *  1. **A grey sentence with no action.** In a page or tab component (`app/**`, and `components/` of geo, vcr, memory, sources,
 *     frontier, inbox, autopilot, capsule, settings and skills), a `<p>` / `<span>` / `<div>` / `<li>` of at least 14 Chinese
 *     characters in `text-text-2`, `text-text-3` or `text-muted` that holds no clickable thing is a line nobody can act on —
 *     how a thing was made, what it may be used for, what the engine did. The cure is the model's context, a log or an
 *     operator's view; or, where the person can do something about it, a `Note` with that action; or, where it is a conclusion,
 *     a `Note` with a number that opens what it counts.
 *  2. **A hand-written divided list.** A `<ul>` or `<ol>` with `divide-y` outside `components/ui/` has no hover, no mark that
 *     says what a press does, no selected state: `List` and `ListRow` are the one list.
 *
 * Sentences held in a variable or a copy table are not seen, so the first count is a floor, and a new file with any is a new
 * violation however small (`app/copyRules.test.ts` reads the same sources for the words).
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));
const sources = shellSources(SRC).filter((path) => path.endsWith(".tsx")).map((path) => ({ path, relative: relative(SRC, path).split("\\").join("/") }));

interface Recorded {
  total: number;
  files: Record<string, number>;
}

function count(scan: (path: string, text: string) => Occurrence[], include: (relative: string) => boolean): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { path, relative: name } of sources) {
    if (!include(name)) continue;
    const found = scan(path, readFileSync(path, "utf8")).length;
    if (found > 0) counts.set(name, found);
  }
  return counts;
}

/** Files whose count rose above what is recorded (a file not recorded has none), and files that can be lowered. */
function against(counts: Map<string, number>, recorded: Recorded): { rose: string[]; lower: string[] } {
  const rose: string[] = [];
  const lower: string[] = [];
  for (const [file, now] of counts) {
    const was = recorded.files[file] ?? 0;
    if (now > was) rose.push(`${file}: ${now} now, ${was} recorded`);
  }
  for (const [file, was] of Object.entries(recorded.files)) {
    const now = counts.get(file) ?? 0;
    if (now < was) lower.push(`${file}: ${was} -> ${now}`);
  }
  return { rose, lower };
}

const sum = (counts: Map<string, number>) => [...counts.values()].reduce((a, b) => a + b, 0);

describe("layout rules (counts may fall, never rise)", () => {
  it("walks the pages it names", () => {
    // Prove the walk walked before trusting what it did not find.
    expect(sources.length).toBeGreaterThan(250);
    const names = sources.map((entry) => entry.relative);
    for (const name of ["app/routes/GeoProjectPage.tsx", "components/vcr/VcrStates.tsx", "components/memory/map/MapFilters.tsx", "components/ui/Toolbar.tsx"]) {
      expect(names).toContain(name);
    }
    expect(isPageFile("components/vcr/VcrStates.tsx")).toBe(true);
    expect(isPageFile("components/ui/Note.tsx")).toBe(false);
    expect(isPageFile("components/layout/PageShell.tsx")).toBe(false);
  });

  it("keeps the grey sentences with no action to the recorded count, file by file", () => {
    const counts = count(scanGreySentences, isPageFile);
    const { rose, lower } = against(counts, baseline.greySentences);
    if (lower.length > 0) console.info(`layout-baseline.json can be lowered (grey sentences ${sum(counts)} of ${baseline.greySentences.total}):\n  ${lower.join("\n  ")}`);
    expect(rose, "a grey sentence with no action was added: give it an action (Note), a number that opens what it counts, or remove it").toEqual([]);
  });

  it("keeps the hand-written divided lists to the recorded count, file by file", () => {
    const counts = count(scanHandwrittenLists, (name) => !name.startsWith("components/ui/"));
    const { rose, lower } = against(counts, baseline.handwrittenLists);
    if (lower.length > 0) console.info(`layout-baseline.json can be lowered (divided lists ${sum(counts)} of ${baseline.handwrittenLists.total}):\n  ${lower.join("\n  ")}`);
    expect(rose, "a hand-written divide-y list was added: use List and ListRow").toEqual([]);
  });

  it("records totals that are the sum of its files", () => {
    for (const recorded of [baseline.greySentences, baseline.handwrittenLists]) {
      expect(Object.values(recorded.files).reduce((a, b) => a + b, 0)).toBe(recorded.total);
    }
  });

  it("sees a grey sentence with no action, and passes one with an action, a short label and a Note", () => {
    const long = "这一段说明写给没有任何动作可做的人看，只是在说怎么生成的";
    const sentence = `export const A = () => <p className="mt-2 text-caption text-text-3">${long}</p>;`;
    expect(scanGreySentences("a.tsx", sentence)).toHaveLength(1);
    expect(scanGreySentences("a.tsx", `export const A = () => <span className={cn("text-muted", x)}>{"${long}"}</span>;`)).toHaveLength(1);
    expect(scanGreySentences("a.tsx", "export const A = ({ n }: { n: number }) => <p className=\"text-text-2\">{`这一段说明写给没有任何动作可做的人看，已经有 ${n} 条了`}</p>;")).toHaveLength(1);
    // An action beside it, anywhere under it: not a dead line.
    expect(scanGreySentences("a.tsx", `export const A = () => <p className="text-text-3">${long}<button type="button">添加</button></p>;`)).toEqual([]);
    expect(scanGreySentences("a.tsx", `export const A = () => <p className="text-text-3">${long}<Link to="/x">去看看</Link></p>;`)).toEqual([]);
    expect(scanGreySentences("a.tsx", `export const A = () => <p className="text-text-3">${long}<a onClick={go}>看</a></p>;`)).toEqual([]);
    // A label is not a sentence, and a sentence that is not grey is the page's content.
    expect(scanGreySentences("a.tsx", `export const A = () => <p className="text-text-3">共 29 条</p>;`)).toEqual([]);
    expect(scanGreySentences("a.tsx", `export const A = () => <p className="text-text">${long}</p>;`)).toEqual([]);
    // A `Note` is the sanctioned sentence; it is not an element the scan reads.
    expect(scanGreySentences("a.tsx", `export const A = () => <Note action={<button type="button">添加</button>}>${long}</Note>;`)).toEqual([]);
  });

  it("sees a hand-written divided list, and not a list of another kind", () => {
    expect(scanHandwrittenLists("a.tsx", `export const A = () => <ul className="divide-y divide-border"><li>x</li></ul>;`)).toHaveLength(1);
    expect(scanHandwrittenLists("a.tsx", `export const A = () => <ol className={cn("space-y-2", "divide-y")}><li>x</li></ol>;`)).toHaveLength(1);
    expect(scanHandwrittenLists("a.tsx", `export const A = () => <ul className="space-y-2"><li>x</li></ul>;`)).toEqual([]);
    expect(scanHandwrittenLists("a.tsx", `export const A = () => <div className="divide-y"><p>x</p></div>;`)).toEqual([]);
  });
});
