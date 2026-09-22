import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { FrontierGlossary, FrontierGlossaryStore, GLOSSARY_MAX_HITS } from "../src/frontierGlossary.mjs";
import {
  applyRows, columnIndex, drugRowsFromNmpaList, handRows, mergeRows, parseArguments, parseRow, parseSharedStrings, xlsxRows,
} from "../../../scripts/ops/seed-frontier-glossary.mjs";

const entries = [
  { kind: "drug", termEn: "semaglutide", termZh: "司美格鲁肽", keepOriginal: false },
  { kind: "drug", termEn: "metformin", termZh: "二甲双胍", keepOriginal: false },
  { kind: "trial", termEn: "SELECT", termZh: "SELECT", keepOriginal: true },
  { kind: "org", termEn: "FDA", termZh: "美国食品药品监督管理局", keepOriginal: false },
  { kind: "org", termEn: "WHO", termZh: "世界卫生组织", keepOriginal: false },
  { kind: "disease", termEn: "heart failure with preserved ejection fraction", termZh: "射血分数保留的心力衰竭", keepOriginal: false },
  { kind: "disease", termEn: "Alzheimer's disease", termZh: "阿尔茨海默病", keepOriginal: false },
  { kind: "method", termEn: "meta-analysis", termZh: "Meta分析", keepOriginal: false },
];
const glossary = new FrontierGlossary(entries);
/** @param {string} text */
const matched = (text) => glossary.match(text).map((entry) => entry.termEn);

test("only the entries a text names come back, in the order it names them", () => {
  assert.deepEqual(matched("In the SELECT trial, Semaglutide reduced events; the FDA reviewed a meta-analysis of metformin."),
    ["SELECT", "semaglutide", "FDA", "meta-analysis", "metformin"]);
  assert.deepEqual(matched("No drug is named here."), []);
});

test("Latin terms match whole words case-insensitively; acronyms only as written", () => {
  assert.deepEqual(matched("SEMAGLUTIDE and semaglutide"), ["semaglutide"], "one hit per entry");
  assert.deepEqual(matched("semaglutides are not one drug"), [], "a longer word is not the term");
  assert.deepEqual(matched("patients who received care; Who knows"), [], "the English word who is not the WHO");
  assert.deepEqual(matched("a select group"), [], "select in lower case is not the trial");
  assert.deepEqual(matched("The WHO said"), ["WHO"]);
  assert.deepEqual(matched("patients with heart failure with preserved ejection fraction"), ["heart failure with preserved ejection fraction"]);
  assert.deepEqual(matched("Alzheimer's disease progression"), ["Alzheimer's disease"]);
  assert.deepEqual(matched("heart failure with reduced ejection fraction"), [], "a multi-word term matches only whole");
});

test("Chinese terms match as substrings", () => {
  assert.deepEqual(matched("司美格鲁肽降低心血管事件，二甲双胍另说"), ["semaglutide", "metformin"]);
  assert.deepEqual(matched("世界卫生组织发布"), ["WHO"]);
});

test("a prompt carries at most thirty entries", () => {
  const many = new FrontierGlossary(Array.from({ length: 50 }, (_, index) => ({ kind: "drug", termEn: `drugname${index}`, termZh: `药${index}名`, keepOriginal: false })));
  const text = Array.from({ length: 50 }, (_, index) => `drugname${index}`).join(" ");
  assert.equal(many.match(text).length, GLOSSARY_MAX_HITS);
});

test("an entity keys by its canonical English name in either language, else by itself", () => {
  assert.equal(glossary.entityKey("drug", "司美格鲁肽"), "drug:semaglutide");
  assert.equal(glossary.entityKey("drug", "Semaglutide"), "drug:semaglutide");
  assert.equal(glossary.entityKey("drug", " 二甲双胍 "), "drug:metformin");
  assert.equal(glossary.entityKey("drug", "Tirzepatide"), "drug:tirzepatide", "a name the glossary lacks keys as itself");
  assert.equal(glossary.entityKey("trial", "SELECT"), "trial:select");
  assert.equal(glossary.entityKey("org", "美国食品药品监督管理局"), "org:fda");
  assert.equal(glossary.entityKey("disease", "阿尔茨海默病"), "disease:alzheimer's disease");
  assert.equal(glossary.entityKey("drug", "  "), null);
  assert.equal(glossary.entityKey(/** @type {any} */ ("method"), "meta-analysis"), null, "only the four entity kinds key");
  assert.deepEqual(glossary.entityKeys({ drugs: ["司美格鲁肽", "semaglutide"], trials: ["SELECT"], orgs: [], diseases: ["肥胖"] }),
    ["drug:semaglutide", "trial:select", "disease:肥胖"]);
  assert.deepEqual(glossary.entityKeys(null), []);
});

test("synonyms share one key: every English name of one Chinese name keys as the shortest", () => {
  const synonyms = new FrontierGlossary([
    { kind: "drug", termEn: "acetylsalicylic acid", termZh: "阿司匹林", keepOriginal: false },
    { kind: "drug", termEn: "aspirin", termZh: "阿司匹林", keepOriginal: false },
    { kind: "org", termEn: "Food and Drug Administration", termZh: "美国食品药品监督管理局", keepOriginal: false },
    { kind: "org", termEn: "FDA", termZh: "美国食品药品监督管理局", keepOriginal: false },
  ]);
  for (const name of ["阿司匹林", "Aspirin", "acetylsalicylic acid"]) assert.equal(synonyms.entityKey("drug", name), "drug:aspirin", name);
  for (const name of ["FDA", "Food and Drug Administration", "美国食品药品监督管理局"]) assert.equal(synonyms.entityKey("org", name), "org:fda", name);
});

test("an invalid row is not loaded", () => {
  const partial = new FrontierGlossary([
    { kind: "drug", termEn: "x", termZh: "某", keepOriginal: false },
    { kind: /** @type {any} */ ("gene"), termEn: "BRCA1", termZh: "BRCA1", keepOriginal: true },
    { kind: "drug", termEn: "aspirin", termZh: "", keepOriginal: false },
    { kind: "drug", termEn: "aspirin", termZh: "阿司匹林", keepOriginal: false },
  ]);
  assert.equal(partial.size, 1);
});

test("the store loads once, reloads after its time to live, and keeps the last glossary when a reload fails", async () => {
  let clock = 0;
  let calls = 0;
  let fail = false;
  const database = {
    async query() {
      calls += 1;
      if (fail) throw Object.assign(new Error("down"), { code: "57P01" });
      return { rows: [{ kind: "drug", term_en: "semaglutide", term_zh: "司美格鲁肽", keep_original: false, origin: "hand" }] };
    },
  };
  const store = new FrontierGlossaryStore({ database, ttlMs: 1_000, now: () => clock });
  const [first, second] = await Promise.all([store.current(), store.current()]);
  assert.equal(first, second, "concurrent readers share one load");
  assert.equal(calls, 1);
  assert.equal(first.size, 1);
  clock = 500;
  await store.current();
  assert.equal(calls, 1, "fresh enough");
  clock = 2_000;
  fail = true;
  const kept = await store.current();
  assert.equal(kept, first, "a failed reload keeps what was loaded");
  assert.equal(store.lastError, "57P01");
  const empty = new FrontierGlossaryStore({ database, ttlMs: 1_000, now: () => clock });
  assert.equal((await empty.current()).size, 0, "a first load that fails yields an empty glossary, not an exception");
});

test("the committed hand-kept rows are valid and unique, and a hand-kept row wins over a generated one", async () => {
  const hand = await handRows();
  assert.ok(hand.length >= 40, `only ${hand.length} hand-kept rows`);
  const ids = hand.map((row) => `${row.kind}:${row.en.toLowerCase()}`);
  assert.equal(new Set(ids).size, ids.length, "no duplicate row");
  for (const row of hand) {
    assert.equal(row.origin, "hand");
    if (row.keep) assert.equal(row.zh, row.en, `${row.en} is kept as written`);
    else assert.match(row.zh, /[\u4e00-\u9fff]/, `${row.en} has a Chinese name`);
  }
  const merged = mergeRows(hand, [{ kind: "org", en: "fda", zh: "别的译名", origin: "nmpa-drug-list" }, { kind: "drug", en: "semaglutide", zh: "司美格鲁肽", origin: "nmpa-drug-list" }]);
  assert.equal(merged.find((row) => row.kind === "org" && row.en.toLowerCase() === "fda")?.zh, "美国食品药品监督管理局");
  assert.ok(merged.some((row) => row.en === "semaglutide"));
  // What the hand-kept rows look like as a glossary: the acronyms stay exact.
  const loaded = new FrontierGlossary(hand.map((row) => ({ kind: /** @type {any} */ (row.kind), termEn: row.en, termZh: row.zh, keepOriginal: row.keep === true })));
  assert.deepEqual(loaded.match("patients who were nice to the step counter").map((entry) => entry.termEn), []);
  assert.deepEqual(loaded.match("The NICE and WHO guidance; the STEP trial").map((entry) => entry.termEn), ["NICE", "WHO", "STEP"]);
});

test("generated drug rows: substances of chemical and biological products, the most common Chinese name, combinations skipped", async () => {
  const rows = [
    ["药品类型", "五级英文", "五级中文"],
    ["西药", "semaglutide", "司美格鲁肽"],
    ["西药", "Semaglutide", "司美格鲁肽"],
    ["西药", "metformin", "二甲双胍"],
    ["西药", "metformin", "二甲双胍"],
    ["西药", "metformin", "二甲基脒基胍"],
    ["中成药", "ginseng", "人参"],
    ["西药", "glucose and sodium chloride", "葡萄糖氯化钠"],
    ["西药", "compound sulfamethoxazole", "复方磺胺甲噁唑"],
    ["西药", "x", "某"],
    ["西药", "", ""],
  ];
  assert.deepEqual(await drugRowsFromNmpaList(rows), [
    { kind: "drug", en: "metformin", zh: "二甲双胍", origin: "nmpa-drug-list" },
    { kind: "drug", en: "semaglutide", zh: "司美格鲁肽", origin: "nmpa-drug-list" },
  ]);
  await assert.rejects(drugRowsFromNmpaList([["名称"]]), /no 五级英文/);
});

test("the spreadsheet reader: shared strings, rows by column reference, inline strings and entities", () => {
  assert.equal(columnIndex("A"), 0);
  assert.equal(columnIndex("AM"), 38);
  assert.equal(columnIndex("AO"), 40);
  const shared = parseSharedStrings('<sst><si><t>药品类型</t></si><si><r><t>司美</t></r><r><t xml:space="preserve">格鲁肽</t></r><rPh><t>sī</t></rPh></si><si><t>A &amp; B</t></si></sst>');
  assert.deepEqual(shared, ["药品类型", "司美格鲁肽", "A & B"]);
  const row = parseRow('<row r="2"><c r="A2" t="s"><v>0</v></c><c r="C2" t="inlineStr"><is><t>inline</t></is></c><c r="D2"><v>42</v></c><c r="E2" s="3"/></row>', shared);
  assert.equal(row[0], "药品类型");
  assert.equal(row[1], undefined);
  assert.equal(row[2], "inline");
  assert.equal(row[3], "42");
  assert.equal(row[4], "");
});

/** A minimal zip (stored and deflated entries), enough for an .xlsx. @param {Array<{ name: string, data: string, deflate?: boolean }>} files */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const raw = Buffer.from(file.data, "utf8");
    const body = file.deflate ? zlib.deflateRawSync(raw) : raw;
    const name = Buffer.from(file.name, "utf8");
    const crc = zlib.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(file.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(file.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test("an .xlsx workbook streams its first sheet's rows through the reader and into drug rows", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "frontier-glossary-"));
  try {
    const file = path.join(folder, "list.xlsx");
    const shared = ["药品类型", "五级英文", "五级中文", "西药", "tirzepatide", "替尔泊肽"];
    const sheetRows = [
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="AM1" t="s"><v>1</v></c><c r="AO1" t="s"><v>2</v></c></row>',
      ...Array.from({ length: 3 }, (_, index) => `<row r="${index + 2}"><c r="A${index + 2}" t="s"><v>3</v></c><c r="AM${index + 2}" t="s"><v>4</v></c><c r="AO${index + 2}" t="s"><v>5</v></c></row>`),
    ];
    await writeFile(file, zip([
      { name: "xl/workbook.xml", data: '<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>' },
      { name: "xl/_rels/workbook.xml.rels", data: '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
      { name: "xl/sharedStrings.xml", data: `<sst>${shared.map((text) => `<si><t>${text}</t></si>`).join("")}</sst>`, deflate: true },
      { name: "xl/worksheets/sheet1.xml", data: `<worksheet><sheetData>${sheetRows.join("")}</sheetData></worksheet>`, deflate: true },
    ]));
    const rows = [];
    for await (const row of xlsxRows(file)) rows.push(row);
    assert.equal(rows.length, 4, "the header and three rows were read");
    assert.equal(rows[1][38], "tirzepatide");
    assert.deepEqual(await drugRowsFromNmpaList(xlsxRows(file)), [{ kind: "drug", en: "tirzepatide", zh: "替尔泊肽", origin: "nmpa-drug-list" }]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("the command line: build and load are separable, and applying never lets a generated row replace a hand-kept one", async () => {
  assert.deepEqual(parseArguments([]), { dataDir: null, from: null, out: null, apply: false });
  assert.deepEqual(parseArguments(["--data-dir", "/d", "--out", "/o.json", "--apply"]), { dataDir: "/d", from: null, out: "/o.json", apply: true });
  assert.throws(() => parseArguments(["--data-dir", "/d", "--from", "/f"]), /not both/);
  assert.throws(() => parseArguments(["--out"]), /needs a path/);
  assert.throws(() => parseArguments(["--frobnicate"]), /unknown argument/);
  /** @type {Array<{ text: string, values: any[] }>} */
  const queries = [];
  const database = { async query(/** @type {string} */ text, /** @type {any[]} */ values) { queries.push({ text, values }); return { rowCount: values[0].length }; } };
  const rows = Array.from({ length: 1_203 }, (_, index) => ({ kind: "drug", en: `drug${index}`, zh: `药${index}`, origin: "nmpa-drug-list" }));
  assert.deepEqual(await applyRows(database, rows), { written: 1_203 });
  assert.equal(queries.length, 3, "written in batches of 500");
  assert.match(queries[0].text, /origin <> 'hand' OR excluded\.origin = 'hand'/);
});
