// The terminology file `term_normalize` reads: built by scripts/ops/build-terminology.mjs from synthetic inputs (no vocabulary text of any real source),
// read back through runtime/mcp/evimed-research/terminology.py, and held to the pins in deps-version.json.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { deflateRawSync, crc32 } from "node:zlib";

import { buildEntity, fetchPinned, groupConcepts, main, pinnedPath, readPins, searchWords } from "../../../scripts/ops/build-terminology.mjs";
import { fold, loadChineseMesh, loadHgnc, loadHpo, loadMesh, loadNcit, readXlsxRows } from "../../../scripts/ops/terminology-sources.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------------------
// Fixtures: a zip writer and an xlsx writer small enough to live in a test
// ---------------------------------------------------------------------------

/** @param {Record<string, string | Buffer>} files */
function zip(files, { deflate = true } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content);
    const body = deflate ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(deflate ? 8 : 0, 8);
    header.writeUInt32LE(crc32(raw), 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    locals.push(header, nameBytes, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(deflate ? 8 : 0, 10);
    entry.writeUInt32LE(crc32(raw), 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += header.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const escapeXml = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** @param {string[][]} rows */
function xlsx(rows) {
  const strings = [];
  const index = (value) => { const at = strings.indexOf(value); if (at >= 0) return at; strings.push(value); return strings.length - 1; };
  const letter = (column) => String.fromCharCode(65 + column);
  const sheet = rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => (value === "" ? "" : `<c r="${letter(c)}${r + 1}" t="s"><v>${index(value)}</v></c>`)).join("")}</row>`).join("");
  return zip({
    "xl/sharedStrings.xml": `<sst>${strings.map((value) => `<si><t>${escapeXml(value)}</t></si>`).join("")}</sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${sheet}</sheetData></worksheet>`,
  });
}

const NCIT = [
  "C0001\t<iri>\tC0000\tLung Carcinoma|Lung Cancer|LC\tA malignant tumor.\tLung Carcinoma\t\tNeoplastic Process\t",
  "C0002\t<iri>\tC0000\tFever|Pyrexia\tElevated temperature.\tFever\t\tSign or Symptom\t",
  "C0003\t<iri>\tC0000\tOld Thing\tx\tOld Thing\tRetired_Concept\tDisease or Syndrome\t",
  "C0004\t<iri>\tC0000\tA Questionnaire Item\tx\tA Questionnaire Item\t\tIntellectual Product\t",
  "C0005\t<iri>\tC0000\tPembrolizumab|Keytruda|MK-3475\tx\tPembrolizumab\t\tPharmacologic Substance\t",
].join("\n");
const HPO = JSON.stringify({ graphs: [{ nodes: [
  { id: "http://purl.obolibrary.org/obo/HP_0001945", type: "CLASS", lbl: "Fever", meta: { synonyms: [{ pred: "hasExactSynonym", val: "Pyrexia" }, { pred: "hasBroadSynonym", val: "Hot" }], xrefs: [{ val: "NCIT:C0002" }, { val: "ICD-10:R50" }] } },
  { id: "http://purl.obolibrary.org/obo/HP_0000001", type: "CLASS", lbl: "Gone", meta: { deprecated: true } },
] }] });
const HPO_ZH = ["source_language\ttranslation_language\tsubject_id\tpredicate_id\tsource_value\ttranslation_value\ttranslation_status", "en\tzh\tHP:0001945\trdfs:label\tFever\t发热\tOFFICIAL"].join("\n");
const HGNC = [
  "hgnc_id\tsymbol\tname\tlocus_group\tlocus_type\tstatus\tlocation\talias_symbol\talias_name\tprev_symbol\tprev_name\tentrez_id\tensembl_gene_id\tomim_id\tuniprot_ids",
  "HGNC:3236\tEGFR\tepidermal growth factor receptor\tprotein-coding gene\tgene with protein product\tApproved\t7p11.2\tERBB1|HER1\t\tERBB\t\t1956\tENSG00000146648\t131550\tP00533",
  "HGNC:1\tPSEUDO1\ta pseudogene\tpseudogene\tpseudogene\tApproved\t1p\t\t\t\t\t1\tENSG1\t\t",
].join("\n");
const CIVIC_GENES = ["feature_id\tfeature_type\tname\tfeature_aliases\tentrez_id\tncit_id", "19\tGene\tEGFR\tERBB,HER1\t1956\t"].join("\n");
const CIVIC_VARIANTS = ["variant_id\tfeature_type\tfeature_name\tvariant\tvariant_aliases\tclinvar_ids\tncit_id\tallele_registry_id", "33\tGene\tEGFR\tL858R\tLEU858ARG,RS121434568\t16609,376282\t\tCA126713"].join("\n");

const MESH = [
  ["_id", "bianma", "name", "entry_terms", "Tree_Number", "MeSH_Unique"],
  ["1", "1", "Lung Neoplasms", JSON.stringify(["Lung Cancer", "Cancer of Lung"]), "C04.588.894.797.520", "D008175"],
  ["2", "2", "Anatomy Category", "", "A", ""],
  ["3", "3", "Fever", JSON.stringify(["Pyrexia"]), "C23.888.119.344", "D005334"],
];
const CMESH = [
  ["_id", "name", "action", "chuli", "jgh", "src", "款目词", "树状结构号", "英文名称"],
  ["1", "肺肿瘤", "", "1", "D008175", "", "肺癌;  Lung Cancer", "C04.588.894.797.520", "Lung Neoplasms"],
  ["2", "发热", "", "1", "D005334", "", "发烧", "C23.888.119.344", "Fever"],
];
const DISEASE_NAMES = [["疾病中文名称", "疾病英文全称", "疾病英文简称"], ["肺癌", "Lung Carcinoma", "LC"], ["糖尿病", "Diabetes mellitus", "DM"]];
const LEXICON_BRIDGE = "# comment\n# comment\n肺癌\tlung cancer|lung carcinoma\n帕博利珠单抗\tpembrolizumab|Keytruda\n";
const LEXICON_KINDS = "# comment\n肺癌\tDISEASE\n帕博利珠单抗\tDRUG\n";
const LEXICON_ICD = "# comment\nC34\t支气管和肺恶性肿瘤\t90\n感冒\t80\n";
const ICD_INDEX = JSON.stringify({ entries: [{ code: "C34.900", name: "肺恶性肿瘤", level: "diagnosis", aliases: ["肺恶性肿瘤", "肺癌"] }] });

/** Writes every input of a build and the pins that describe the public ones. */
function inputs(directory) {
  const files = {
    ncit: ["Thesaurus_9.FLAT.zip", zip({ "Thesaurus.txt": NCIT })], hpo: ["hp.json", Buffer.from(HPO)], "hpo-zh": ["hp-zh.babelon.tsv", Buffer.from(HPO_ZH)],
    hgnc: ["hgnc.tsv", Buffer.from(HGNC)], "civic-genes": ["genes.tsv", Buffer.from(CIVIC_GENES)], "civic-variants": ["variants.tsv", Buffer.from(CIVIC_VARIANTS)],
  };
  const sources = {};
  for (const [id, [file, bytes]] of Object.entries(files)) {
    const target = path.join(directory, "public", id, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    sources[id] = { version: `v-${id}`, url: `https://example.invalid/${file}`, file, bytes: bytes.length, sha256: sha(bytes), license: "test", attribution: "test" };
  }
  const pins = path.join(directory, "pins.json");
  writeFileSync(pins, JSON.stringify({ terminology: { sources } }));
  mkdirSync(path.join(directory, "lexicon"));
  writeFileSync(path.join(directory, "lexicon", "medical-zh-en.txt"), LEXICON_BRIDGE);
  writeFileSync(path.join(directory, "lexicon", "medical-term-kinds.txt"), LEXICON_KINDS);
  writeFileSync(path.join(directory, "lexicon", "medical-lexicon.txt"), LEXICON_ICD);
  writeFileSync(path.join(directory, "icd.json"), ICD_INDEX);
  writeFileSync(path.join(directory, "mesh.xlsx"), xlsx(MESH));
  writeFileSync(path.join(directory, "cmesh.xlsx"), xlsx(CMESH));
  writeFileSync(path.join(directory, "diseases.xlsx"), xlsx(DISEASE_NAMES));
  return { pins, sources };
}

const argumentsFor = (directory, out) => [
  "--out", out, "--pins", path.join(directory, "pins.json"), "--public-dir", path.join(directory, "public"), "--lexicon-dir", path.join(directory, "lexicon"),
  "--icd-index", path.join(directory, "icd.json"), "--mesh", path.join(directory, "mesh.xlsx"), "--cmesh", path.join(directory, "cmesh.xlsx"),
  "--disease-names", path.join(directory, "diseases.xlsx"),
];

function withDirectory(run) {
  const directory = mkdtempSync(path.join(tmpdir(), "evimed-terminology-"));
  return Promise.resolve(run(directory)).finally(() => rmSync(directory, { recursive: true, force: true }));
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

test("the xlsx reader reads shared strings, empty cells and escaped text from the first sheet", () => withDirectory((directory) => {
  const file = path.join(directory, "t.xlsx");
  writeFileSync(file, xlsx([["a", "b & c", ""], ["", "x", "z<1>"]]));
  assert.deepEqual(readXlsxRows(file), [["a", "b & c"], ["", "x", "z<1>"]].map((row, i) => (i === 0 ? ["a", "b & c"] : row)));
}));

test("MeSH rows without a unique id are not concepts, and the Chinese heading joins the English one by that id", () => {
  const mesh = loadMesh(MESH);
  assert.deepEqual(mesh.map((entry) => entry.sourceId), ["D008175", "D005334"]);
  assert.equal(mesh[0].type, "disease");
  const chinese = loadChineseMesh(CMESH);
  assert.deepEqual(chinese[0].terms.map((term) => [term.lang, term.text]), [["zh", "肺肿瘤"], ["en", "Lung Neoplasms"], ["zh", "肺癌"], ["en", "Lung Cancer"]]);
  const entities = groupConcepts([...mesh, ...chinese]).map(buildEntity);
  assert.equal(entities.length, 2);
  assert.deepEqual(entities.find((entity) => entity.en === "Lung Neoplasms")?.zh, "肺肿瘤");
});

test("the NCIt reader keeps live concepts of the listed semantic types and nothing else", () => {
  const concepts = loadNcit(NCIT);
  assert.deepEqual(concepts.map((entry) => entry.sourceId), ["C0001", "C0002", "C0005"], "a retired concept and a questionnaire item are not kept");
  assert.deepEqual(concepts[0].terms.filter((term) => term.kind === 2).map((term) => term.text), ["LC"]);
  assert.deepEqual(concepts[0].codes, [{ system: "NCIt", code: "C0001" }]);
  assert.deepEqual(loadNcit(Buffer.from(NCIT)).map((entry) => entry.sourceId), ["C0001", "C0002", "C0005"]);
});

test("the HPO reader takes the Chinese label, the exact and related synonyms, and the ICD-10 reference, and leaves out a deprecated class", () => {
  const [fever] = loadHpo({ json: HPO, zh: HPO_ZH });
  assert.equal(fever.sourceId, "HP:0001945");
  assert.deepEqual(fever.terms.map((term) => term.text), ["Fever", "Pyrexia", "发热"]);
  assert.deepEqual(fever.codes, [{ system: "HPO", code: "HP:0001945" }, { system: "ICD-10", code: "R50" }]);
});

test("the HGNC reader leaves out pseudogenes and carries the identifiers", () => {
  const genes = loadHgnc(HGNC);
  assert.deepEqual(genes.map((entry) => entry.sourceId), ["HGNC:3236"]);
  assert.deepEqual(genes[0].codes.map((code) => code.system), ["HGNC", "Entrez Gene", "Ensembl", "OMIM", "UniProt"]);
});

test("folding reads width, case, dashes and spacing as one", () => {
  assert.equal(fold("  Non-Small  Cell LUNG "), "non small cell lung");
  assert.equal(fold("ＥＧＦＲ"), "egfr");
  assert.equal(searchWords("非小细胞肺癌 EGFR-2"), "非小 小细 细胞 胞肺 肺癌 egfr 2");
});

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

test("two concepts of one source are never merged, whatever a third record says", () => {
  const make = (source, sourceId, ...keys) => ({ source, sourceId, type: "disease", terms: [{ lang: "en", text: sourceId, kind: 0 }], codes: [], keys });
  const groups = groupConcepts([make("mesh", "A", "en:x"), make("mesh", "B", "en:y"), make("evimed-zh-en", "bridge", "en:x", "en:y"), make("ncit", "C", "en:x")]);
  const sizes = groups.map((group) => group.length).sort();
  assert.deepEqual(sizes, [1, 3], "the bridge joins the first MeSH heading and the NCIt concept; the second MeSH heading stays alone");
  assert.ok(groups.every((group) => new Set(group.map((entry) => entry.source)).size === group.length));
});

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

test("a build folds the sources into entities, and the same inputs give the same bytes", () => withDirectory(async (directory) => {
  inputs(directory);
  const out = path.join(directory, "out", "terminology.sqlite");
  const lines = [];
  const first = await main(argumentsFor(directory, out), { log: (line) => lines.push(line) });
  const bytes = readFileSync(out);
  await main(argumentsFor(directory, out), { log: () => {} });
  assert.equal(sha(readFileSync(out)), sha(bytes), "rebuilding gives identical bytes");
  assert.match(lines[0], /entities written: \d+/);
  const db = new DatabaseSync(out, { readOnly: true });
  const meta = Object.fromEntries(db.prepare("SELECT key, value FROM metadata").all().map((row) => [row.key, row.value]));
  assert.equal(meta.release, "evimed-terminology-v1");
  assert.equal(meta.built_at, undefined, "no clock is read unless one is given");
  assert.equal(Number(meta.entities), first.entities);
  const entity = (name) => db.prepare("SELECT e.* FROM lookup l JOIN entities e ON e.id = l.entity_id WHERE l.folded = ? ORDER BY length(e.sources) DESC").get(fold(name));
  const lung = entity("lung neoplasms");
  assert.equal(lung.zh, "肺肿瘤");
  assert.deepEqual(lung.sources.split(","), ["cmesh", "mesh"]);
  const fever = entity("发热");
  assert.deepEqual(fever.sources.split(","), ["cmesh", "hpo", "mesh", "ncit"], "MeSH id, English name and the NCIt cross-reference meet in one entity");
  assert.ok(fever.types.includes("phenotype"));
  const gene = entity("her1");
  assert.equal(gene.en, "EGFR");
  assert.deepEqual(gene.sources.split(","), ["civic", "hgnc"]);
  assert.ok(db.prepare("SELECT 1 FROM lookup WHERE folded = 'egfr l858r'").get(), "a CIViC variant is a name of its own");
  assert.ok(db.prepare("SELECT 1 FROM code_lookup WHERE code = 'C34'").get(), "an ICD-10 code finds its entity");
  assert.ok(db.prepare("SELECT 1 FROM lookup WHERE folded = '感冒'").get() === undefined, "a lexicon row without a code is not loaded");
  const sources = db.prepare("SELECT id, version FROM sources ORDER BY id").all();
  assert.deepEqual(sources.find((row) => row.id === "ncit")?.version, "v-ncit", "a public source carries the pinned version");
  assert.match(sources.find((row) => row.id === "mesh")?.version ?? "", /^file [0-9a-f]{12}$/, "a private one carries the digest of its file");
  db.close();
  const withDate = path.join(directory, "dated.sqlite");
  await main([...argumentsFor(directory, withDate), "--built-at", "2026-11-04"], { log: () => {} });
  const dated = new DatabaseSync(withDate, { readOnly: true });
  assert.equal(dated.prepare("SELECT value FROM metadata WHERE key = 'built_at'").get().value, "2026-11-04");
  dated.close();
}));

test("the Python reader answers from the file the builder wrote", { skip: spawnSync("python3", ["--version"]).status !== 0 }, () => withDirectory(async (directory) => {
  inputs(directory);
  const out = path.join(directory, "terminology.sqlite");
  await main(argumentsFor(directory, out), { log: () => {} });
  const script = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(path.join(repo, "runtime/mcp/evimed-research"))})`,
    "import terminology",
    "found = {term: terminology.lookup(term, limit=2) for term in ['发热', 'non small cell', 'pyrexia', 'C34', 'her1', '肺癌', 'Lung Cancer']}",
    "print(json.dumps({'status': terminology.status(), 'found': {k: [(m['concept'], m['chinese'], m['matchedOn']['how'], [c['code'] for c in m['codes']]) for m in v['matches']] for k, v in found.items()}}, ensure_ascii=False))",
  ].join("\n");
  const output = JSON.parse(execFileSync("python3", ["-I", "-c", script], { env: { ...process.env, EVIMED_TERMINOLOGY_DB: out }, encoding: "utf8" }));
  assert.equal(output.status.available, true);
  assert.equal(output.found["发热"][0][0], "Fever");
  assert.equal(output.found["发热"][0][2], "exact");
  assert.ok(output.found["发热"][0][3].includes("D005334") && output.found["发热"][0][3].includes("HP:0001945") && output.found["发热"][0][3].includes("C0002"));
  assert.equal(output.found["pyrexia"][0][0], "Fever");
  assert.equal(output.found["C34"][0][2], "code");
  assert.equal(output.found["her1"][0][0], "EGFR");
  assert.ok(output.found["肺癌"].length >= 1);
  assert.ok(output.found["Lung Cancer"].length >= 1);
}));

test("a public input that does not match its pinned digest is refused before it is read", () => withDirectory(async (directory) => {
  inputs(directory);
  writeFileSync(path.join(directory, "public", "hgnc", "hgnc.tsv"), `${HGNC}\nHGNC:2\tTAMPER\tx\tprotein-coding gene\tx\tApproved\t1\t\t\t\t\t2\tE\t\t`);
  await assert.rejects(() => main(argumentsFor(directory, path.join(directory, "t.sqlite")), { log: () => {} }), /hgnc: .* does not match the pinned digest/);
}));

test("a missing public input is fetched against its pin, and a changed upstream file is refused", () => withDirectory(async (directory) => {
  const body = Buffer.from("pinned bytes");
  const pin = { url: "https://example.invalid/f.txt", file: "f.txt", bytes: body.length, sha256: sha(body) };
  const respond = (content) => async () => ({ ok: true, status: 200, arrayBuffer: async () => content.buffer.slice(content.byteOffset, content.byteOffset + content.length) });
  const target = await fetchPinned("x", pin, directory, { fetchImpl: respond(body) });
  assert.equal(target, pinnedPath(directory, "x", pin));
  assert.equal(readFileSync(target, "utf8"), "pinned bytes");
  rmSync(target);
  await assert.rejects(() => fetchPinned("x", pin, directory, { fetchImpl: respond(Buffer.from("changed bytes")) }), /digest does not match the pin/);
  await assert.rejects(() => fetchPinned("x", pin, directory, { fetchImpl: respond(Buffer.alloc(body.length + 5000)) }), /larger than the pinned/);
  await assert.rejects(() => fetchPinned("x", pin, directory, { fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
}));

// ---------------------------------------------------------------------------
// The pins
// ---------------------------------------------------------------------------

test("every public input the builder needs is pinned once in deps-version.json, and nowhere else", () => {
  const pins = readPins();
  for (const id of ["ncit", "hpo", "hpo-zh", "hgnc", "civic-genes", "civic-variants"]) {
    const pin = pins.sources[id];
    assert.ok(pin, `no pin for ${id}`);
    assert.match(pin.sha256, /^[0-9a-f]{64}$/);
    assert.match(pin.url, /^https:\/\//);
    assert.ok(pin.bytes > 0 && pin.version && pin.file && pin.license && pin.attribution);
  }
  assert.match(pins.references["cdisc-sdtm"].sha256, /^[0-9a-f]{64}$/);
  const listed = execFileSync("git", ["-c", "core.quotePath=false", "ls-files", "--cached", "--others", "--exclude-standard", "--", "apps", "packages", "scripts", "runtime", "deploy", "evals", "capabilities"], { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n").filter((file) => file && !/\.(png|jpg|gif|ico|woff2?|pdf|xlsx|zip|gz|sqlite|parquet)$/i.test(file) && !/(^|\/)node_modules\//.test(file));
  const needles = Object.values(pins.sources).flatMap((pin) => [pin.sha256, pin.url]);
  const strays = [];
  for (const file of listed) {
    if (file === "apps/server/test/terminologyBuild.test.mjs") continue;
    let text;
    try { text = readFileSync(path.join(repo, file), "utf8"); } catch { continue; }
    for (const needle of needles) if (text.includes(needle)) strays.push(`${file}: ${needle}`);
  }
  assert.deepEqual(strays, [], "a digest or a download address written outside deps-version.json is a second pin");
});

test("the builder carries no private path and the repository carries no private vocabulary file", () => {
  const source = `${readFileSync(path.join(repo, "scripts/ops/build-terminology.mjs"), "utf8")}\n${readFileSync(path.join(repo, "scripts/ops/terminology-sources.mjs"), "utf8")}`;
  assert.doesNotMatch(source, /\/home\/|sentum|\.evimed-local|药学基础数据/);
});
