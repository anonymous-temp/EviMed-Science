#!/usr/bin/env node
/**
 * Derives the 十八反 / 十九畏 caution rules in
 * `packages/domain/src/clinical-safety-rules.json` from the curated matrix
 * `药学基础数据/重点整理数据表/中药饮片十八反十九畏规则矩阵.csv`, and from
 * nothing else.
 *
 * Hidden knowledge: why a generator for twelve rules. The incompatible pairs
 * are classical, but the names are not: the matrix carries each herb's
 * pharmacopoeia-standard name and the processed forms and aliases a hospital
 * catalogue uses (炙甘草, 法半夏, 硫磺 for 硫黄), checked against the【注意】
 * items of 《中国药典》2020 年版一部. Retyping them by hand is how a rule ends up
 * missing the name a report actually uses. The matrix lives in the git-ignored
 * data directory, so its output is committed and `--check` compares the two
 * wherever the data is present (a checkout without it says so and exits 0).
 *
 * Every other rule in the file is pharmacist-authored and untouched here: this
 * replaces only the rules whose `family` is `tcm-incompatibility`.
 *
 * Usage:
 *   node scripts/build/generate-tcm-caution-rules.mjs [--source <csv>] [--rules <json>] [--check]
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const defaultSource = path.resolve(repoRoot, "..", "药学基础数据", "重点整理数据表", "中药饮片十八反十九畏规则矩阵.csv");
const defaultRules = path.join(repoRoot, "packages", "domain", "src", "clinical-safety-rules.json");
const FAMILY = "tcm-incompatibility";
const SOURCE_NAME = "药学基础数据/重点整理数据表/中药饮片十八反十九畏规则矩阵.csv";

// The twelve classical groups, by the matrix's own `formula` text. A group the
// matrix adds is refused until it is named here: an id is what a finding is
// counted under, and it must not change when a row is reordered.
const RULE_IDS = new Map([
  ["甘草反甘遂大戟海藻芫花", "tcm-shibafan-gancao"],
  ["乌头反半蒌贝蔹及白及", "tcm-shibafan-wutou"],
  ["藜芦反诸参辛芍", "tcm-shibafan-lilu"],
  ["硫黄畏朴硝", "tcm-shijiuwei-liuhuang-poxiao"],
  ["水银畏砒霜", "tcm-shijiuwei-shuiyin-pishuang"],
  ["狼毒畏密陀僧", "tcm-shijiuwei-langdu-mituoseng"],
  ["巴豆畏牵牛", "tcm-shijiuwei-badou-qianniu"],
  ["丁香畏郁金", "tcm-shijiuwei-dingxiang-yujin"],
  ["川乌草乌畏犀角", "tcm-shijiuwei-wutou-xijiao"],
  ["牙硝畏三棱", "tcm-shijiuwei-yaxiao-sanleng"],
  ["官桂畏赤石脂", "tcm-shijiuwei-guangui-chishizhi"],
  ["人参畏五灵脂", "tcm-shijiuwei-renshen-wulingzhi"],
]);

/** RFC 4180, enough for this export: quoted fields, doubled quotes, CRLF. @param {string} text */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { row.push(field); field = ""; }
    else if (character === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += character;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.filter((values) => values.some((value) => value.trim())).map((values) => Object.fromEntries(header.map((name, i) => [name.replace(/^\ufeff/, ""), values[i] ?? ""])));
}

/** @param {string} value */
const aliases = (value) => value.split("、").map((name) => name.trim()).filter(Boolean);

/** @param {Record<string, string>[]} rows */
export function tcmCautionRules(rows) {
  /** @type {Map<string, { category: string, formula: string, left: string[], right: string[] }>} */
  const groups = new Map();
  for (const row of rows) {
    const key = row.formula;
    if (!RULE_IDS.has(key)) throw new Error(`the matrix names an unmapped group "${key}"; give it an id in RULE_IDS`);
    const group = groups.get(key) ?? { category: row.category, formula: key, left: [], right: [] };
    for (const name of aliases(row.left_aliases)) if (!group.left.includes(name)) group.left.push(name);
    for (const name of aliases(row.right_aliases)) if (!group.right.includes(name)) group.right.push(name);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    id: /** @type {string} */ (RULE_IDS.get(group.formula)),
    family: FAMILY,
    titleZh: `${group.category}：${group.formula}`,
    // A formula lists its herbs together; two herbs thirty paragraphs apart
    // are two different prescriptions.
    scope: "paragraph",
    when: [group.left, group.right],
    mention: ["@tcm-incompatibility-terms"],
    message: `The report names both ${group.left[0]} and one of ${group.right.join("/")} — a classical ${group.category} incompatible pair (${group.formula}) — and never says so. State the incompatibility, and whether the two are actually prescribed together and how that is handled.`,
    messageZh: `报告中同时出现「${group.left[0]}」类与「${group.right.slice(0, 3).join("、")}」等药，属${group.category}配伍禁忌（${group.formula}），但通篇没有提示。请写明这一配伍禁忌，并说明实际处方中是否同用、如何处理。`,
    evidence: [{
      authority: "《中国药典》2020 年版一部 药材和饮片【注意】项；十八反十九畏歌诀",
      year: 2020,
      url: "https://ydz.chp.org.cn/",
      note: `generated from ${SOURCE_NAME}`,
    }],
  }));
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? path.resolve(args[index + 1]) : fallback;
  };
  const source = option("--source", defaultSource);
  const rulesPath = option("--rules", defaultRules);
  let csv;
  try {
    csv = await fs.readFile(source, "utf8");
  } catch {
    console.log(`the curated matrix is not in this checkout (${source}); nothing to generate or check`);
    return;
  }
  const generated = tcmCautionRules(parseCsv(csv));
  const document = JSON.parse(await fs.readFile(rulesPath, "utf8"));
  const kept = (document.cautionRules ?? []).filter((rule) => rule.family !== FAMILY);
  const next = { ...document, cautionRules: [...kept, ...generated] };
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const current = await fs.readFile(rulesPath, "utf8");
  if (args.includes("--check")) {
    if (text !== current) {
      console.error(`${path.relative(repoRoot, rulesPath)} does not match ${SOURCE_NAME}; run this script without --check and commit the result`);
      process.exitCode = 1;
    } else {
      console.log(`${generated.length} TCM caution rules up to date`);
    }
    return;
  }
  await fs.writeFile(rulesPath, text);
  console.log(`wrote ${generated.length} TCM caution rules into ${path.relative(repoRoot, rulesPath)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
