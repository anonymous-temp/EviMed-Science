import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PLATFORM_CONTEXT_TAGS,
  carriesPlatformContext,
  identifierShapesIn,
  maskIdentifiers,
  platformIdentifiersIn,
  stripPlatformTags,
  unwrapUserWrappers,
} from "../index.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Where text that reaches a conversation is written: the socket's plugins and
 *  guidance, the kernel port, the control plane, the research server and the
 *  capability skills. The shell only displays memory and is not an emitter. */
const EMITTER_TREES = [
  "packages/socket/plugins",
  "packages/socket/src",
  "packages/harness-port/src",
  "apps/server/src",
  "runtime/mcp",
  "capabilities",
  "capability-skills",
];

/** @param {string} directory @returns {AsyncGenerator<string>} */
async function* sourceFiles(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "__pycache__" || entry.name === "test" || entry.name === "tests") continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.(?:mjs|js|ts|py|md)$/.test(entry.name) && !/\.test\./.test(entry.name)) yield full;
  }
}

test("every <evimed-*> tag the platform writes is named, and every named tag is still written", async () => {
  /** @type {Map<string, Set<string>>} */
  const emitted = new Map();
  let scanned = 0;
  for (const tree of EMITTER_TREES) {
    for await (const file of sourceFiles(path.join(repoRoot, tree))) {
      scanned += 1;
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(/<\/?(evimed-[a-z][a-z-]*[a-z])/g)) {
        const files = emitted.get(match[1]) ?? new Set();
        files.add(path.relative(repoRoot, file));
        emitted.set(match[1], files);
      }
    }
  }
  // A walk that found nothing proves nothing: the tree moved, or the parse broke.
  assert.ok(scanned >= 150, `scanned only ${scanned} files; the walk is wrong, not the tree`);
  assert.ok(emitted.size >= 15, `found only ${emitted.size} distinct tags; the parse is wrong`);

  const named = new Map(PLATFORM_CONTEXT_TAGS.map((entry) => [entry.tag, entry]));
  const unnamed = [...emitted.keys()].filter((tag) => !named.has(tag)).sort();
  assert.deepEqual(unnamed, [], `written but not listed in PLATFORM_CONTEXT_TAGS: ${unnamed
    .map((tag) => `${tag} (${[...(emitted.get(tag) ?? [])].join(", ")})`).join("; ")}`);

  for (const entry of PLATFORM_CONTEXT_TAGS) {
    if (entry.legacy || entry.upstream) {
      assert.ok(entry.emitters.length === 0, `${entry.tag} is marked legacy or upstream and still names emitters`);
      continue;
    }
    assert.ok(entry.emitters.length > 0, `${entry.tag} names no emitter and is not marked legacy`);
    for (const emitter of entry.emitters) {
      const text = await readFile(path.join(repoRoot, emitter), "utf8").catch(() => "");
      assert.ok(text.includes(`<${entry.tag}`), `${entry.tag} is listed as written by ${emitter}, which no longer writes it`);
    }
  }
});

test("an injected block is recognised with or without attributes; a user wrapper is not machine text", () => {
  for (const entry of PLATFORM_CONTEXT_TAGS.filter((item) => item.role === "injected")) {
    assert.equal(carriesPlatformContext(`前文\n<${entry.tag}>内容</${entry.tag}>`), true, entry.tag);
    assert.equal(carriesPlatformContext(`<${entry.tag} index="1" id="x">`), true, `${entry.tag} with attributes`);
  }
  assert.equal(carriesPlatformContext("<evimed-correction>不对，用中文回答</evimed-correction>"), false);
  // A name that merely begins like a listed tag is not that tag.
  assert.equal(carriesPlatformContext("<evimed-briefing>x</evimed-briefing>"), false);
  assert.equal(carriesPlatformContext("我喜欢 <b>加粗</b> 的结论"), false);
});

test("a correction keeps the researcher's words and loses only our wrapper", () => {
  assert.equal(unwrapUserWrappers("<evimed-correction>剂量按肾功能调整，不要用固定剂量</evimed-correction>"),
    "剂量按肾功能调整，不要用固定剂量");
  assert.equal(stripPlatformTags("<evimed-brief>\n请综述阿司匹林一级预防\n</evimed-brief>"), "请综述阿司匹林一级预防");
});

test("platform identifiers are found in every spelling, and research vocabulary is not", () => {
  assert.deepEqual(
    platformIdentifiersIn("先调用 evimed_submit_deliverable，再用 mcp__evimed__literature_search，结果在 .evimed-run/state.json"),
    ["evimed_submit_deliverable", "mcp__evimed__literature_search", ".evimed-run"],
  );
  assert.deepEqual(platformIdentifiersIn("literature_search returned 12 hits; see delivery-receipt.json"),
    ["literature_search", "delivery-receipt.json"]);
  assert.deepEqual(platformIdentifiersIn("the clinical-evidence-report was accepted"), ["clinical-evidence-report"]);
  // Words the platform also uses are language: a researcher says them about research.
  for (const prose of [
    "偏好随机效应 meta-analysis，报告 health economics 结果",
    "the deliverable passed the gate; the analysis-plan is pre-registered",
    "uses bash and read access to the dataset",
    "prefers peer review by two pharmacists",
  ]) {
    assert.deepEqual(platformIdentifiersIn(prose), [], prose);
  }
});

test("an identifier has the shape of one whether or not its check digit adds up, and a secret typed in a sentence is blanked where it ends", () => {
  // 2026-10-14 probe: a patient's 18-digit ID did not pass GB 11643, was not masked and stood in the stored episode.
  const wrongDigit = "110101199001011234";
  assert.deepEqual(identifierShapesIn(`患者身份证 ${wrongDigit}，住院`), ["resident_id"]);
  assert.equal(maskIdentifiers(`患者身份证 ${wrongDigit}，住院`), "患者身份证 [已省略]，住院");
  assert.equal(maskIdentifiers("110101199001011237"), "[已省略]", "one with a valid check digit is masked as before");
  // The shape is the structure of one: not a longer number, not a date that is no date.
  assert.deepEqual(identifierShapesIn("订单号 1101011990010112345678"), []);
  assert.deepEqual(identifierShapesIn("编号 110101199013011234"), []);
  // The value after the label goes; the sentence around it stays, in either language.
  assert.equal(maskIdentifiers("我的数据库密码是 Xk9#mPq2Lz，帮我写一个连接脚本"), "我的数据库密码是 [已省略]，帮我写一个连接脚本");
  assert.equal(maskIdentifiers("the password: hunter2hunter, then run it"), "the password: [已省略], then run it");
  assert.equal(maskIdentifiers("密码是abc"), "密码是abc", "too short to be one");
  assert.deepEqual(identifierShapesIn("我的数据库密码是 Xk9#mPq2Lz，帮我写"), ["credential"]);
});

test("a long run of the key alphabet is a secret by its shape and not by its length: names and commits stay, keys go (2026-10-23)", () => {
  // The three that were deleted from a memory file with no message, and a commit: all runs of the key alphabet, none a secret.
  for (const name of [
    "数据文件命名规则：NOAC_AF_cohort_2018_2024_main_analysis_v2_final_cleaned，一律这样命名",
    "文件夹用 pneumonia-associated-with-mechanical-ventilation-in-icu-patients 命名",
    "报告文件一律叫 Quarterly_Sales_Report_FY2024_Final_Reviewed_V3_Approved_by_Finance",
    "分支按 feature/payment-callback-timeout-fix-for-gateway-retry-strategy-v2 的写法",
    "回退到提交 a94a8fe5ccb19ba61c4c0873d391e987982fbbd3",
  ]) {
    assert.deepEqual(identifierShapesIn(name), [], name);
    assert.equal(maskIdentifiers(name), name, `${name} is not blanked`);
  }
  // What a key looks like is still one: random and dense, or a provider's own format, or a digest of something private.
  for (const secret of [
    "dGhpcyBpcyBhIHNlY3JldCB0b2tlbiB2YWx1ZSBmb3IgdGVzdGluZw0123456789",
    "Xk9mP2vLq8wZr4NtYb7CdEfGhJkQs3UaVxWy5Z1o6",
    "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    ["sk", "live", "51HxAbCdEfGhIjKlMnOpQrStUv"].join("_"),
    "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "AKIAIOSFODNN7EXAMPLE",
    ["xoxb", "1234567890123", "1234567890123", "AbCdEfGhIjKlMnOpQrStUvWx"].join("-"),
    "d41d8cd98f00b204e9800998ecf8427e",
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  ]) {
    assert.deepEqual(identifierShapesIn(`备份用的是 ${secret} 这一串`), ["credential"], secret);
    assert.equal(maskIdentifiers(`备份用的是 ${secret} 这一串`), "备份用的是 [已省略] 这一串", secret);
  }
  // A commit is exactly forty hex characters: one more or fewer is a key's length again, and a labelled one is caught by its label.
  assert.deepEqual(identifierShapesIn("a94a8fe5ccb19ba61c4c0873d391e987982fbbd30"), ["credential"]);
  assert.deepEqual(identifierShapesIn("password: a94a8fe5ccb19ba61c4c0873d391e987982fbbd3"), ["credential"]);
});

test("the kernel's own reminder envelope is machine text like the platform's, so the door in front of the engine drops it", () => {
  const entry = PLATFORM_CONTEXT_TAGS.find((item) => item.tag === "system-reminder");
  assert.ok(entry && entry.role === "injected" && entry.upstream && entry.emitters.length === 0, "named, injected, upstream");
  assert.equal(carriesPlatformContext("<system-reminder>\nA skill is a reusable set of task-specific instructions.\n</system-reminder>"), true);
  assert.equal(stripPlatformTags("<system-reminder>目录</system-reminder>你好"), "目录你好", "the envelope goes, as for any other tag");
});
