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
  ["主张", "the gate's word for a claim; a reader sees 结论 (spec §12.4), 循证 GEO's evidence tab included"],
  ["改线", "a tool is chosen before the conversation, not switched after a dispatch"],
  ["按哪条线处理", "same"],
  // The memory page's banned words (build spec 2026-09-21 §10.6): each is the
  // machinery's name for something the reader only needs to see the result of.
  ["置信度", "a number the extractor typed, never a measurement; provenance is said as 推断 or not at all"],
  ["候选", "nothing waits for approval any more; a memory takes effect labelled as what it is"],
  ["蒸馏", "how a method is learned is the platform's business; the reader sees the method"],
  ["采纳", "there is no adoption step on the page; a learned method is simply in force until stopped"],
  // The two modules' names (R10 plan §1, the owner's rulings of 2026-10-07): 「循证 GEO」 again —
  // 「循证传播」 was its name from 2026-10-06 — and 「虚拟临床研究」 for what was 「虚拟临研」. A search
  // still reads the old names as the new ones until 2027-01-07 — `@evimed/domain`'s
  // `retiredNames.mjs`, on lines marked retired-word-ok.
  ["循证传播", "renamed 2026-10-07 by the owner: the module is 「循证 GEO」; its measurement screens are still 「AI 回答监测」"],
  ["虚拟临研", "renamed 2026-10-07 by the owner: the module is 「虚拟临床研究」, in full"],
];

/**
 * Retired words that are also identifiers in code (`status: "approved"`,
 * `payload.digestId`, a skill file's name). The whole-line grep above would
 * flag every one of those, so for these only what a reader can see counts:
 * a JSX text node, or a string literal that carries Chinese — the two shapes a
 * sentence on screen takes in this shell.
 */
const RETIRED_VISIBLE: ReadonlyArray<readonly [string, string]> = [
  ["approved", "a method's review state is internal; the page says 在用 or nothing"],
  ["SKILL.md", "a method is shown as its title and steps, never as the file it is stored in"],
  ["digest", "a content digest is how versions are told apart internally; the reader sees 版本"],
];

const CJK = /[㐀-鿿]/;

/** The parts of one source line a reader can see: JSX text between tags, and
 *  every quoted or template string that carries Chinese. */
function visibleText(line: string): string[] {
  const found: string[] = [];
  for (const match of line.matchAll(/>([^<>{}]+)</g)) {
    if (match[1].trim()) found.push(match[1]);
  }
  for (const match of line.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    // A template's interpolations are code (`${event.digest}`), not words.
    const literal = (match[1] ?? match[2] ?? match[3] ?? "").replace(/\$\{[^}]*\}/g, "");
    if (CJK.test(literal)) found.push(literal);
  }
  return found;
}

/** Every source file under `dir` whose name matches `kind`, tests excluded. */
function sources(dir: string, kind = /\.(ts|tsx)$/, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) { sources(path, kind, found); continue; }
    if (!kind.test(entry) || /\.test\.\w+$/.test(entry)) continue;
    found.push(path);
  }
  return found;
}

/**
 * The domain's sentences reach the same reader: the shell renders the error
 * dictionary (`errorCodes.mjs`), the gate's titles (`gateIssueText.mjs`) and
 * the capability display table (`capability-display.json`) as they are written
 * there. 「运行记录」 outlived its page in six of those sentences, and 「主张」 in
 * three capability descriptions, because this walk read only the shell.
 */
const DOMAIN_SOURCES = join(dirname(fileURLToPath(import.meta.url)), "../../../../packages/domain/src");

/**
 * 「候选」 is retired from the memory page, where nothing waits for approval
 * any more; the domain also says 候选药品, drug selection's word for what the
 * reader is comparing, which is not that word.
 */
const DOMAIN_EXEMPT = new Set(["候选"]);

const comment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

describe("the words the product retired", () => {
  const files = sources(dirname(dirname(fileURLToPath(import.meta.url))));
  const texts = files.map((path) => ({ path, text: readFileSync(path, "utf8") }));
  const relative = (path: string) => path.slice(path.indexOf("/src/") + 1);

  // A walk that found nothing proves nothing: a moved tree or a broken filter
  // would pass every assertion below by reading no file at all.
  it("walks the shell's sources", () => {
    expect(files.length).toBeGreaterThan(150);
    const walked = files.map(relative);
    for (const expected of ["src/app/routes/MemoryHubPage.tsx", "src/components/memory/FactDrawer.tsx", "src/lib/memoryGroups.ts"]) {
      expect(walked).toContain(expected);
    }
    expect(texts.filter(({ text }) => CJK.test(text)).length).toBeGreaterThan(50);
  });

  it("finds a retired word where a reader would see it, and not in an identifier", () => {
    expect(visibleText(`<p>已 approved</p>`).join("")).toContain("approved");
    expect(visibleText(`toast.success("方法已 approved");`).join("")).toContain("approved");
    expect(visibleText(`status: "candidate" | "approved" | "retired";`)).toEqual([]);
    expect(visibleText(`const digest = item.source.type === "digest";`)).toEqual([]);
    expect(visibleText("[`综述：${event.digest}`]").join("")).not.toContain("digest");
  });

  it.each(RETIRED)("does not say 「%s」 anywhere a reader can see", (word, why) => {
    const guilty = texts
      // A comment may name a retired word to explain why it went, and a line
      // marked `retired-word-ok` may hold one as DATA about records written
      // before the rename; a string a reader can see may not.
      .filter(({ text }) => text.split("\n").some((line) =>
        line.includes(word) && !comment(line) && !line.includes("retired-word-ok")))
      .map(({ path }) => relative(path));
    expect(guilty, `${word}: ${why}`).toEqual([]);
  });

  const domainFiles = sources(DOMAIN_SOURCES, /\.(mjs|json)$/);
  const domainTexts = domainFiles.map((path) => ({ path, text: readFileSync(path, "utf8") }));
  const domainRelative = (path: string) => path.slice(path.indexOf("/packages/domain/") + 1);

  it("walks the domain's sources", () => {
    expect(domainFiles.length).toBeGreaterThan(40);
    const walked = domainFiles.map(domainRelative);
    for (const expected of ["packages/domain/src/errorCodes.mjs", "packages/domain/src/gateIssueText.mjs", "packages/domain/src/capability-display.json"]) {
      expect(walked).toContain(expected);
    }
    expect(domainTexts.filter(({ text }) => CJK.test(text)).length).toBeGreaterThan(20);
  });

  it.each(RETIRED.filter(([word]) => !DOMAIN_EXEMPT.has(word)))("does not say 「%s」 in a domain sentence", (word, why) => {
    const guilty = domainTexts
      .filter(({ text }) => text.split("\n").some((line) =>
        line.includes(word) && !comment(line) && !line.includes("retired-word-ok")))
      .map(({ path }) => domainRelative(path));
    expect(guilty, `${word}: ${why}`).toEqual([]);
  });

  it.each(RETIRED_VISIBLE)("does not show 「%s」 in any text a reader can see", (word, why) => {
    const guilty = texts
      .filter(({ text }) => text.split("\n").some((line) =>
        !comment(line) && !line.includes("retired-word-ok") && visibleText(line).some((part) => part.includes(word))))
      .map(({ path }) => relative(path));
    expect(guilty, `${word}: ${why}`).toEqual([]);
  });
});
