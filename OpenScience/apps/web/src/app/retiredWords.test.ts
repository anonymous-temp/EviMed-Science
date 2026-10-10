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
  // The owner's ruling of 2026-10-10 (「也不要标这些……这些后台的安全提醒，全平台都不要呈现给用户看」): a scan verdict, a trust
  // verdict, a provenance label and a verification note are the back office's, never a line on a researcher's screen. Each phrase
  // below was drawn until then (S1 inventory, `reviews/1010/research/S1-notices.md`); the engineering behind it stays, only the
  // sentence goes.
  ["来源未验证", "whether a sender could be verified is the back office's; a received pack is shown as what comes in"],
  ["不会带上", "what the automatic scan left out is not listed, counted or explained; the scan still gates the mount, on the server"],
  ["没有通过自动检查", "same"],
  ["没有带上", "same"],
  ["不含脚本", "what a shared file holds is not assured to the researcher; the export is text by construction"],
  ["只含文字", "same"],
  ["脚本不会随", "same"],
  ["引用时只引用原始来源", "how a subscribed zone is cited is the model's context, not a sentence on the zone page"],
  ["引文核对中", "the citation checker's own state: under an answer nothing is drawn while it works or when it fails (as the reply check)"],
  ["引文暂时无法核对", "same"],
  // The result inspector (R22-R24): a digest, the image a run was in, and the platform's list of what it did not record are the back office's.
  ["文件摘要", "a file's digest is how versions are told apart internally; the reader sees 第 N 版 and the day"],
  ["摘要未记录", "a source's digest is not shown, recorded or not"],
  ["记录不完整：", "what the platform did not record about a version is not a line on the page (the colon: a gate's title for a measurement says 记录不完整 on its own)"],
  ["运行镜像", "the image a run was in is the operator's"],
  ["未被观察的部分", "what the platform did not observe about how a result was made is not said"],
  ["生成过程未被观察", "same"],
  ["没有记录生成过程", "same"],
  ["没有可读取的核对意见", "a version with nothing to show is not a version that 「was not verified」"],
  ["已保存此版本", "whether the platform kept a copy of an input is not a line in the lineage"],
  // The error registry (R27): sentences from when the gate withheld a delivery, and a chore handed to the reader.
  ["退回修复", "a gate verdict never withholds a delivery (ruling of 2026-09-17), so no run is sent back for repair"],
  ["未经校验的文件不会被当作交付物", "same: what a run wrote is delivered"],
  ["请自行复核", "a chore the platform hands its reader; the per-claim marks say what was checked"],
  ["用密钥验回执", "what a receipt key signs is not the reader's to know (owner decision 2026-09-29)"],
  // The evidence cards and their upkeep (R29): whether an AI has reviewed a card and what the maintenance rounds kept from the last
  // reading are the pipeline's bookkeeping. The card's findings, its source status and its claim marks are its content.
  ["AI 已评议", "whether an AI reviewed the card is not a label on it"],
  ["AI 待评议", "same"],
  ["当前内容已完成 AI 评议", "same"],
  ["当前内容待重新评议", "same"],
  ["沿用上次保留内容", "what the upkeep kept from the last reading is not said"],
  ["上次成功读取于", "when the pipeline last read a source is not said"],
  ["本轮未能重新读取", "same"],
  ["本轮尚未核查", "same"],
  ["缺少原文链接", "same"],
  ["部分来源待复核", "same"],
  ["部分来源本轮尚未完成复核", "same"],
  // An evidence card's engine, method and receipt id (R30), and the notices about a receipt that did not hold, are the back office's; the claim
  // type 平台计算, the claim's mark and the card's own content are not.
  ["没有对上引擎回执", "a receipt that did not hold is a claim that did not check out (未核对上), not a sentence about the engine"],
  ["引擎回执没有对上", "same"],
  ["回执没有对上这些数字", "same"],
  ["平台保存的回执", "same"],
  ["本卡由平台议程完成", "a card does not say that the platform's agenda made it"],
  ["证明哈希", "a card does not carry the evaluator's proof hash"],
  ["内部研究记录", "a card does not tell its reader what the platform keeps in its internal project"],
  // 数据含义 (R34): who vouches for a meaning is the contract; on the page it is a fact's own line (「依据：AI 判断」), not a count and not a tag.
  ["模型推断", "the page says 「依据：AI 判断」 on a fact's own line; there is no count of inferred facts and no tag"],
  ["你已确认", "same"],
  ["数据字典所述", "same"],
  ["确认以上推断", "the button confirms the meanings shown (确认这些含义); it does not name an inference"],
  ["来源未登记", "same"],
  // Disclaimers and "not verified" notes the platform wrote about itself (R31).
  ["不为它们背书", "the platform does not disclaim the cards of other users on the page that lists them"],
  ["是平台还没核对这一项", "a condition the platform has not checked is not listed, and nothing says so"],
  ["三项都未核实", "same"],
  ["未做独立复核", "why a finding will not be independently re-checked is the platform's reason, not the reader's"],
  ["未安排独立复核", "same"],
  // Why the platform routed a request as it did (R28) is the ledger's machine reason, for operations; no sentence for the reader.
  ["按问题内容交给", "a run's route is not explained to the researcher"],
  ["不需要交付报告", "same"],
  ["你在问题里点名了", "same"],
  ["按你的选择", "same: a choice the researcher made is not repeated back to them as a routing reason"],
  ["路由判断没有给出结论", "same"],
  ["引用均为来源原文片段", "a coding file's quotes are spans of its source by construction; the viewer does not vouch for them"],
  ["不由模型生成", "same"],
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
