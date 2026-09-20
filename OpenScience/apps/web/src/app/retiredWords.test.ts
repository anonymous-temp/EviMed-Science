import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Words the product retired must not come back.
 *
 * Each of these named a thing the 2026-09-20 rectification removed or renamed,
 * and each was a word a reader had to learn before the page made sense:
 * 「运行记录」 a page that no longer exists, 「无痕」 a mode that was deleted,
 * 「交付物」/「主张」/「核验」 the delivery gate's own vocabulary shown to a
 * clinician, 「待你复核」 a chore the product invented for its reader.
 *
 * A grep, deliberately: the alternative is asserting a sentence per surface,
 * and the surfaces move. What this protects is the vocabulary, over every
 * string the shell can render.
 */
const RETIRED: ReadonlyArray<readonly [string, string]> = [
  ["运行记录", "the ledger page was deleted; a conversation is where its rows live now"],
  ["无痕", "the session-level incognito mode was deleted; the memory switch is the control"],
  ["本次用到的背景", "the per-conversation background panel was deleted; each memory row says when it was last used"],
  ["写一个方法", "a method is learned from adopted work and corrections, never typed into a form"],
  ["放进胶囊", "a source's facts enter memory when its understanding completes, labelled and reversible"],
  ["待你复核", "the verdict says what is true (some conclusions were not matched word for word), not what a person owes"],
  ["待人工复核", "same"],
  ["自证未通过", "same"],
  ["改线", "a tool is chosen before the conversation, not switched after a dispatch"],
  ["按哪条线处理", "same"],
];

/** Every source file the shell can render a string from. */
function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) { sources(path, found); continue; }
    if (!/\.(ts|tsx)$/.test(entry) || /\.test\.(ts|tsx)$/.test(entry)) continue;
    found.push(path);
  }
  return found;
}

describe("the words the product retired", () => {
  const files = sources(dirname(dirname(fileURLToPath(import.meta.url))));

  it.each(RETIRED)("does not say 「%s」 anywhere a reader can see", (word, why) => {
    const guilty = files
      .map((path) => ({ path, text: readFileSync(path, "utf8") }))
      // A comment may name a retired word to explain why it went, and a line
      // marked `retired-word-ok` may hold one as DATA about records written
      // before the rename; a string a reader can see may not.
      .filter(({ text }) => text.split("\n").some((line) =>
        line.includes(word) && !/^\s*(\/\/|\*|\/\*)/.test(line) && !line.includes("retired-word-ok")))
      .map(({ path }) => path.slice(path.indexOf("/src/") + 1));
    expect(guilty, `${word}: ${why}`).toEqual([]);
  });
});
