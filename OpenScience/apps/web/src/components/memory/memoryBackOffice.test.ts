import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Where a memory came from, and whether a model's note was confirmed, are not on the memory page — or on any page.
 *
 * Owner ruling of 2026-10-10 (review R9–R12, R15): the platform keeps whose words a memory is for the model and the operator;
 * the researcher sees the memory, its date and what they can do with it. The page used to say it four ways — a phrase in every
 * drawer header (你说的 / 你确认的 / 你改过的 / 从对话中学到), the same words on every revision line and on a practice's header,
 * a 「这条推断不对？」 dialog that existed for inferences alone, and a safety tag, 「待确认（用药安全）」, on a record held for a
 * medicine it named — and each was a sentence that disclosed a memory's kind to the person looking at it.
 *
 * A grep over what a reader can see, on the memory page's own sources, so that the next label is caught by this file and not by
 * the owner. The shell-wide list of retired words is `app/retiredWords.test.ts`; this one is the memory page's, with the reason.
 */
const WORDS: ReadonlyArray<readonly [string, string]> = [
  ["你说的", "a drawer header said whose words a memory was"],
  ["你确认的", "same"],
  ["你改过的", "same"],
  ["你改的", "the same, on a revision line"],
  ["系统整理", "the same, naming the back office as the author of a change"],
  ["从对话中学到", "the same, for what the platform learned: the one phrase that said a memory was an inference"],
  ["从你的对话中学到", "the same, on a practice's header"],
  ["你定下的", "the same, on a practice's header"],
  ["推断", "an inference is not something a researcher is told they have; the item that deletes one is on every memory"],
  ["用药安全", "the hold on a memory that named a medicine is retired; a memory takes effect like any other"],
  ["未经确认", "a model's note needs no confirmation and carries no warning that it has none"],
  ["助手记", "assistant-noted: the same warning in other words"],
  ["隐私保护", "the privacy rationale that came with the safety hold"],
];

const comment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

/** Every source file of the memory page, tests excluded. */
function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) { sources(path, found); continue; }
    if (/\.test\.\w+$/.test(entry) || !/\.(ts|tsx)$/.test(entry)) continue;
    found.push(path);
  }
  return found;
}

const src = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("the memory page says nothing of where a memory came from", () => {
  const files = [
    ...sources(join(src, "components/memory")),
    ...readdirSync(join(src, "lib")).filter((name) => /^memory[A-Za-z]*\.ts$/.test(name) && !/\.test\./.test(name)).map((name) => join(src, "lib", name)),
    join(src, "app/routes/MemoryHubPage.tsx"),
  ];
  const texts = files.map((path) => ({ path, text: readFileSync(path, "utf8") }));
  const relative = (path: string) => path.slice(path.indexOf("/src/") + 1);

  // A walk that found nothing proves nothing: a moved tree would pass every assertion below by reading no file at all.
  it("walks the page's sources", () => {
    const walked = files.map(relative);
    for (const expected of ["src/components/memory/FactDrawer.tsx", "src/components/memory/PracticeDrawer.tsx", "src/lib/memoryText.ts", "src/app/routes/MemoryHubPage.tsx"]) {
      expect(walked).toContain(expected);
    }
    expect(texts.every(({ text }) => text.length > 100)).toBe(true);
  });

  it.each(WORDS)("does not say 「%s」 anywhere a reader can see", (word, why) => {
    // A comment may name a retired word to explain why it went; a string a reader can see may not.
    const guilty = texts
      .filter(({ text }) => text.split("\n").some((line) => line.includes(word) && !comment(line)))
      .map(({ path }) => relative(path));
    expect(guilty, `${word}: ${why}`).toEqual([]);
  });
});
