#!/usr/bin/env node
/**
 * Builds the terminology file `term_normalize` reads (`EVIMED_TERMINOLOGY_DB`): one read-only SQLite file in which the
 * names a medical term goes by — Chinese and English, with the codes of the vocabularies that name it — are folded into
 * entities, so a Chinese diagnosis in a record and an English one in a trial's criteria meet at the same row.
 *
 * Inputs are local paths given on the command line. Nothing private is in the repository and nothing private is
 * downloaded: the private workbooks and lexicon are read from where the operator keeps them, and the public sources are
 * fetched from the URLs and checked against the sha256 digests pinned in `deps-version.json` (`terminology.sources`),
 * which is the only place those are written. The built file lives outside the tree; the deployment names it by env.
 *
 *   node scripts/ops/build-terminology.mjs --out /var/lib/evimed/terminology.sqlite --public-dir DIR --fetch \
 *     --lexicon-dir DIR --icd-index FILE --icd-xlsx FILE --disease-names FILE --mesh FILE --cmesh FILE
 *
 * Any input may be left out; the file is built from the rest. The same inputs build the same bytes: rows are inserted in a
 * fixed order and no clock is read, so a build date exists only if `--built-at` is given (it is metadata, nothing else).
 *
 * How concepts become entities (`groupConcepts`): a source's record carries join keys — its preferred names, a code another
 * source states for it — and two records that share a key are one entity, unless they come from the same source: a
 * vocabulary does not describe one thing twice, so two MeSH headings that happen to share a word are never merged by a
 * third record. That is the only rule; it reads no language.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  fold, hasCjk, loadChineseMesh, loadCivic, loadDiseaseNames, loadHgnc, loadHpo, loadIcdBilingual, loadIcdIndex, loadLexicon, loadMesh, loadNcit, readXlsxRows, readZipMember,
} from "./terminology-sources.mjs";

export const TERMINOLOGY_RELEASE = "evimed-terminology-v1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Which source names a record's English and Chinese preferred name first. A lower index wins. */
const ENGLISH_PRIORITY = Object.freeze(["mesh", "ncit", "hpo", "hgnc", "civic", "icd10-cn-bilingual", "disease-names", "evimed-zh-en", "cmesh", "evimed-icd10-names", "icd10-cn-index"]);
const CHINESE_PRIORITY = Object.freeze(["cmesh", "hpo", "icd10-cn-bilingual", "disease-names", "evimed-zh-en", "evimed-icd10-names", "icd10-cn-index", "mesh", "ncit", "hgnc", "civic"]);

/** Every source id the file can hold, in a fixed order (its index is the source's letter). */
const SOURCE_IDS = Object.freeze(["mesh", "cmesh", "ncit", "hpo", "hgnc", "civic", "icd10-cn-index", "icd10-cn-bilingual", "evimed-icd10-names", "disease-names", "evimed-zh-en"]);

/** What the file says about each source, and where the licence requires a notice. Private sources carry no licence text of ours. */
const SOURCE_FACTS = Object.freeze(/** @type {Record<string, { name: string, license: string, attribution: string }>} */ ({
  "mesh": { name: "MeSH (English)", license: "NLM, public", attribution: "Medical Subject Headings, U.S. National Library of Medicine" },
  "cmesh": { name: "Chinese MeSH", license: "private", attribution: "Chinese Medical Subject Headings" },
  "ncit": { name: "NCI Thesaurus", license: "CC BY 4.0", attribution: "NCI Thesaurus, National Cancer Institute (CC BY 4.0)" },
  "hpo": { name: "Human Phenotype Ontology", license: "HPO licence (acknowledge the HPO Consortium; show the version)", attribution: "This product is using the Human Phenotype Ontology (HPO Consortium), and its Chinese translation by the CHPO consortium" },
  "hgnc": { name: "HGNC gene nomenclature", license: "CC0", attribution: "HGNC, HUGO Gene Nomenclature Committee (CC0)" },
  "civic": { name: "CIViC", license: "CC0", attribution: "CIViC, Clinical Interpretation of Variants in Cancer (CC0)" },
  "icd10-cn-index": { name: "ICD-10 national insurance edition, diagnosis index (Chinese)", license: "private", attribution: "ICD-10 national insurance edition 2.0" },
  "icd10-cn-bilingual": { name: "ICD-10 Chinese and English categories", license: "private", attribution: "ICD-10 Chinese and English edition" },
  "evimed-icd10-names": { name: "ICD-10 names (curated lexicon)", license: "private", attribution: "EviMed curated lexicon" },
  "disease-names": { name: "Disease names, Chinese with English full names and abbreviations", license: "private", attribution: "EviMed disease-name table" },
  "evimed-zh-en": { name: "Chinese-English medical term bridge", license: "private", attribution: "EviMed curated bridge" },
}));

// ---------------------------------------------------------------------------
// Pins and public downloads
// ---------------------------------------------------------------------------

/** @param {string} [file] */
export function readPins(file = path.join(ROOT, "deps-version.json")) {
  const pins = JSON.parse(readFileSync(file, "utf8"))?.terminology;
  if (!pins?.sources || typeof pins.sources !== "object") throw new Error("deps-version.json has no terminology.sources");
  return pins;
}

/** @param {Buffer | Uint8Array} bytes */
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Where a pinned public file lives under `directory`: `<directory>/<pin id>/<file name>`.
 * @param {string} directory @param {string} id @param {{ file: string }} pin
 */
export const pinnedPath = (directory, id, pin) => path.join(directory, id, pin.file);

/**
 * Downloads one pinned file unless it is already there and its digest matches. The size is bounded by the pin before the bytes are kept and
 * the digest decides, so a changed upstream file is refused rather than loaded.
 * @param {string} id @param {{ url: string, sha256: string, bytes: number, file: string }} pin @param {string} directory
 * @param {{ fetchImpl?: typeof fetch }} [options]
 */
export async function fetchPinned(id, pin, directory, { fetchImpl = globalThis.fetch } = {}) {
  const target = pinnedPath(directory, id, pin);
  if (existsSync(target) && sha256(readFileSync(target)) === pin.sha256) return target;
  const response = await fetchImpl(pin.url, { redirect: "follow", headers: { "user-agent": "evimed-terminology-build (mailto:noreply@example.org)" } });
  if (!response.ok) throw new Error(`${id}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > pin.bytes * 1.01 + 1024) throw new Error(`${id}: larger than the pinned ${pin.bytes} bytes`);
  if (sha256(bytes) !== pin.sha256) throw new Error(`${id}: digest does not match the pin`);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(`${target}.part`, bytes);
  renameSync(`${target}.part`, target);
  return target;
}

/** @param {string} file @param {{ sha256: string }} pin @param {string} id */
function verifiedBytes(file, pin, id) {
  const bytes = readFileSync(file);
  if (sha256(bytes) !== pin.sha256) throw new Error(`${id}: ${path.basename(file)} does not match the pinned digest`);
  return bytes;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/** @typedef {ReturnType<typeof loadMesh>[number]} Concept */

/**
 * @param {string} list @param {string} source
 */
const rank = (list, source) => { const at = /** @type {readonly string[]} */ (list === "en" ? ENGLISH_PRIORITY : CHINESE_PRIORITY).indexOf(source); return at < 0 ? 99 : at; };

/**
 * Concepts that share a join key become one entity, except two concepts of one source. Deterministic: concepts are taken in the order of
 * the English priority list, then by source id.
 * @param {Concept[]} concepts
 */
export function groupConcepts(concepts) {
  const ordered = [...concepts].sort((a, b) => rank("en", a.source) - rank("en", b.source) || (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
  const parent = ordered.map((_, index) => index);
  /** @type {Array<Set<string>>} */
  const sources = ordered.map((entry) => new Set([entry.source]));
  /** @param {number} index */
  const find = (index) => { let at = index; while (parent[at] !== at) { parent[at] = parent[parent[at]]; at = parent[at]; } return at; };
  /** @type {Map<string, number>} */
  const holder = new Map();
  for (const [index, entry] of ordered.entries()) {
    for (const key of entry.keys) {
      const other = holder.get(key);
      if (other === undefined) { holder.set(key, index); continue; }
      const a = find(index);
      const b = find(other);
      if (a === b) continue;
      if ([...sources[a]].some((source) => sources[b].has(source))) continue;
      const [low, high] = a < b ? [a, b] : [b, a];
      parent[high] = low;
      for (const source of sources[high]) sources[low].add(source);
    }
  }
  /** @type {Map<number, Concept[]>} */
  const groups = new Map();
  for (const [index, entry] of ordered.entries()) {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), entry]);
  }
  return [...groups.values()];
}

/** One group of concepts as the entity the file stores. @param {Concept[]} members */
export function buildEntity(members) {
  const byEnglish = [...members].sort((a, b) => rank("en", a.source) - rank("en", b.source));
  const byChinese = [...members].sort((a, b) => rank("zh", a.source) - rank("zh", b.source));
  const preferred = (/** @type {Concept[]} */ list, /** @type {"en" | "zh"} */ lang) => list.flatMap((member) => member.terms.filter((term) => term.lang === lang && term.kind === 0))[0]?.text ?? null;
  /** @type {Map<string, { lang: string, text: string, kind: number, source: string }>} */
  const terms = new Map();
  for (const member of byEnglish) {
    for (const term of member.terms) {
      const key = `${term.lang}\u0000${fold(term.text)}`;
      const held = terms.get(key);
      if (!held) terms.set(key, { lang: term.lang, text: term.text, kind: term.kind, source: member.source });
      else if (term.kind < held.kind) held.kind = term.kind;
    }
  }
  /** @type {Map<string, { system: string, code: string, source: string }>} */
  const codes = new Map();
  for (const member of byEnglish) for (const code of member.codes) if (!codes.has(`${code.system}\u0000${code.code}`)) codes.set(`${code.system}\u0000${code.code}`, { ...code, source: member.source });
  const types = [...new Set(byEnglish.map((member) => member.type))];
  return {
    en: preferred(byEnglish, "en"), zh: preferred(byChinese, "zh"), types,
    sources: [...new Set(byEnglish.map((member) => member.source))].sort(),
    members: byEnglish.map((member) => ({ source: member.source, sourceId: member.sourceId })),
    terms: [...terms.values()].sort((a, b) => a.kind - b.kind || (a.lang < b.lang ? -1 : a.lang > b.lang ? 1 : 0) || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0)),
    codes: [...codes.values()],
  };
}

/** The text full-text search indexes: Chinese runs as overlapping character pairs, everything else as its own words. @param {string} value */
export function searchWords(value) {
  const text = fold(value);
  /** @type {string[]} */
  const out = [];
  for (const piece of text.match(/[㐀-鿿豈-﫿]+|[^㐀-鿿豈-﫿]+/gu) ?? []) {
    if (hasCjk(piece)) {
      const chars = [...piece];
      if (chars.length === 1) out.push(chars[0]);
      else for (let index = 0; index < chars.length - 1; index += 1) out.push(chars[index] + chars[index + 1]);
    } else {
      out.push(...(piece.match(/[\p{L}\p{N}]+/gu) ?? []));
    }
  }
  return out.join(" ");
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

const SCHEMA = `
PRAGMA page_size = 4096;
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE sources (id TEXT PRIMARY KEY, letter TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL, license TEXT NOT NULL, attribution TEXT NOT NULL, concepts INTEGER NOT NULL) WITHOUT ROWID;
-- One row per entity. \`detail\` is text read only for the few entities an answer shows: one line per name, \`<lang e|z><kind 0-2><source letter><text>\`, then a line holding only \`#\`, then one line per code, \`<source letter><system>\\t<code>\`. The letters are the \`letter\` column of \`sources\`.
CREATE TABLE entities (id INTEGER PRIMARY KEY, en TEXT, zh TEXT, types TEXT NOT NULL, sources TEXT NOT NULL, detail TEXT NOT NULL);
-- Exact and prefix lookup: the folded form of every name, with the best kind it has in that entity (0 preferred, 1 synonym, 2 abbreviation or symbol).
CREATE TABLE lookup (folded TEXT NOT NULL, entity_id INTEGER NOT NULL, kind INTEGER NOT NULL, PRIMARY KEY (folded, entity_id)) WITHOUT ROWID;
-- A code as written (ICD-10, MeSH, NCIt, HPO, HGNC, ...) back to the entities that carry it.
CREATE TABLE code_lookup (code TEXT NOT NULL, entity_id INTEGER NOT NULL, PRIMARY KEY (code, entity_id)) WITHOUT ROWID;
-- Words of every name of an entity, Chinese as overlapping character pairs (\`searchWords\`); rowid is the entity id.
CREATE VIRTUAL TABLE entity_fts USING fts5(w, content='', tokenize='unicode61 remove_diacritics 2');
`;

/**
 * @param {string} file the file to write (replaced atomically)
 * @param {Concept[]} concepts
 * @param {{ sourceVersions: Record<string, string>, inputs: Record<string, string>, builtAt?: string | null }} meta
 */
export function writeTerminology(file, concepts, { sourceVersions, inputs, builtAt = null }) {
  const entities = groupConcepts(concepts).map(buildEntity)
    .sort((a, b) => {
      const left = `${a.members[0].source}\u0000${a.members[0].sourceId}`;
      const right = `${b.members[0].source}\u0000${b.members[0].sourceId}`;
      return rank("en", a.members[0].source) - rank("en", b.members[0].source) || (left < right ? -1 : left > right ? 1 : 0);
    });
  /** One character for each source, in the order of the source list, so a name carries one byte of provenance. @param {string} source */
  const letterOf = (source) => String.fromCharCode(97 + Math.max(0, SOURCE_IDS.indexOf(source)));
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.build`;
  rmSync(temporary, { force: true });
  const db = new DatabaseSync(temporary);
  let terms = 0;
  try {
    db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;");
    db.exec(SCHEMA);
    const insertEntity = db.prepare("INSERT INTO entities (id, en, zh, types, sources, detail) VALUES (?, ?, ?, ?, ?, ?)");
    const insertLookup = db.prepare("INSERT OR IGNORE INTO lookup (folded, entity_id, kind) VALUES (?, ?, ?)");
    const insertCode = db.prepare("INSERT OR IGNORE INTO code_lookup (code, entity_id) VALUES (?, ?)");
    const insertFts = db.prepare("INSERT INTO entity_fts (rowid, w) VALUES (?, ?)");
    db.exec("BEGIN");
    /** @type {Map<string, number>} */
    const perSource = new Map();
    for (const [index, entity] of entities.entries()) {
      const id = index + 1;
      const detail = [
        ...entity.terms.map((term) => `${term.lang === "zh" ? "z" : "e"}${term.kind}${letterOf(term.source)}${term.text.replace(/[\r\n]+/g, " ")}`),
        "#",
        ...entity.codes.map((code) => `${letterOf(code.source)}${code.system}\t${code.code}`),
      ].join("\n");
      insertEntity.run(id, entity.en, entity.zh, entity.types.join("|"), entity.sources.join(","), detail);
      for (const member of entity.members) perSource.set(member.source, (perSource.get(member.source) ?? 0) + 1);
      /** @type {Map<string, number>} */
      const folded = new Map();
      for (const term of entity.terms) {
        const key = fold(term.text);
        folded.set(key, Math.min(folded.get(key) ?? 9, term.kind));
      }
      for (const [key, kind] of folded) insertLookup.run(key, id, kind);
      terms += entity.terms.length;
      for (const code of new Set(entity.codes.map((entry) => entry.code))) insertCode.run(code, id);
      insertFts.run(id, [...new Set(entity.terms.flatMap((term) => searchWords(term.text).split(" ")))].join(" "));
    }
    const insertSource = db.prepare("INSERT INTO sources (id, letter, name, version, license, attribution, concepts) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const source of [...perSource.keys()].sort()) {
      const facts = SOURCE_FACTS[source] ?? { name: source, license: "unknown", attribution: source };
      insertSource.run(source, letterOf(source), facts.name, sourceVersions[source] ?? "", facts.license, facts.attribution, perSource.get(source) ?? 0);
    }
    const insertMeta = db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)");
    insertMeta.run("release", TERMINOLOGY_RELEASE);
    insertMeta.run("entities", String(entities.length));
    insertMeta.run("terms", String(terms));
    insertMeta.run("inputs", JSON.stringify(Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => (a < b ? -1 : 1)))));
    // The build date is the one value that is not a function of the inputs; it is written only when asked for.
    if (builtAt) insertMeta.run("built_at", builtAt);
    db.exec("COMMIT");
    db.exec("VACUUM");
  } finally {
    db.close();
  }
  rmSync(file, { force: true });
  renameSync(temporary, file);
  return { entities: entities.length, terms };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/** @param {string[]} argv */
function parseArguments(argv) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  const names = ["out", "public-dir", "lexicon-dir", "icd-index", "icd-xlsx", "disease-names", "mesh", "cmesh", "built-at", "pins"];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--fetch") { flags.fetch = true; continue; }
    const name = flag.replace(/^--/, "");
    if (!flag.startsWith("--") || !names.includes(name) || index + 1 >= argv.length) throw new Error(`unknown or incomplete option ${flag}`);
    flags[name] = argv[(index += 1)];
  }
  return flags;
}

/** @param {string} file */
const text = (file) => readFileSync(file, "utf8");

/**
 * @param {string[]} argv
 * @param {{ fetchImpl?: typeof fetch, log?: (line: string) => void }} [options]
 */
export async function main(argv, { fetchImpl = globalThis.fetch, log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const flags = parseArguments(argv);
  if (typeof flags.out !== "string") throw new Error("--out FILE is required");
  /** @type {Concept[]} */
  const concepts = [];
  /** @type {Record<string, string>} */
  const inputs = {};
  /** @type {Record<string, string>} */
  const sourceVersions = {};
  /** Spread would overflow the stack on the larger sources. @param {Concept[]} list */
  const addAll = (list) => { for (const entry of list) concepts.push(entry); };
  /** @param {string} id @param {string} file */
  const note = (id, file) => { inputs[id] = sha256(readFileSync(file)); sourceVersions[id] = `file ${inputs[id].slice(0, 12)}`; };

  if (typeof flags["public-dir"] === "string") {
    const pins = readPins(typeof flags.pins === "string" ? flags.pins : undefined);
    const directory = flags["public-dir"];
    /** @param {string} id */
    const need = async (id) => {
      const pin = pins.sources[id];
      if (!pin) throw new Error(`no pin for ${id}`);
      const file = flags.fetch ? await fetchPinned(id, pin, directory, { fetchImpl }) : pinnedPath(directory, id, pin);
      if (!existsSync(file)) throw new Error(`${id}: ${file} is missing (use --fetch to download it)`);
      verifiedBytes(file, pin, id);
      inputs[id] = pin.sha256;
      return file;
    };
    const ncit = await need("ncit");
    sourceVersions.ncit = pins.sources.ncit.version;
    addAll(loadNcit(readZipMember(ncit, (name) => name.endsWith(".txt"))));
    const hpo = await need("hpo");
    const hpoZh = await need("hpo-zh");
    sourceVersions.hpo = pins.sources.hpo.version;
    addAll(loadHpo({ json: text(hpo), zh: text(hpoZh) }));
    const hgnc = await need("hgnc");
    sourceVersions.hgnc = pins.sources.hgnc.version;
    addAll(loadHgnc(text(hgnc)));
    const genes = await need("civic-genes");
    const variants = await need("civic-variants");
    sourceVersions.civic = pins.sources["civic-genes"].version;
    addAll(loadCivic({ genes: text(genes), variants: text(variants) }));
  }
  if (typeof flags["lexicon-dir"] === "string") {
    const directory = flags["lexicon-dir"];
    const bridge = path.join(directory, "medical-zh-en.txt");
    const kinds = path.join(directory, "medical-term-kinds.txt");
    const lexicon = path.join(directory, "medical-lexicon.txt");
    note("evimed-zh-en", bridge);
    addAll(loadLexicon({ bridge: text(bridge), kinds: existsSync(kinds) ? text(kinds) : null, lexicon: existsSync(lexicon) ? text(lexicon) : null }));
    if (existsSync(kinds)) note("evimed-term-kinds", kinds);
    if (existsSync(lexicon)) note("evimed-icd10-names", lexicon);
  }
  if (typeof flags["icd-index"] === "string") { note("icd10-cn-index", flags["icd-index"]); addAll(loadIcdIndex(text(flags["icd-index"]))); }
  if (typeof flags["icd-xlsx"] === "string") { note("icd10-cn-bilingual", flags["icd-xlsx"]); addAll(loadIcdBilingual(readXlsxRows(flags["icd-xlsx"]))); }
  if (typeof flags["disease-names"] === "string") { note("disease-names", flags["disease-names"]); addAll(loadDiseaseNames(readXlsxRows(flags["disease-names"]))); }
  if (typeof flags.mesh === "string") { note("mesh", flags.mesh); addAll(loadMesh(readXlsxRows(flags.mesh))); }
  if (typeof flags.cmesh === "string") { note("cmesh", flags.cmesh); addAll(loadChineseMesh(readXlsxRows(flags.cmesh))); }
  if (!concepts.length) throw new Error("no input was given");

  const built = writeTerminology(flags.out, concepts, { sourceVersions, inputs, builtAt: typeof flags["built-at"] === "string" ? flags["built-at"] : null });
  log(`concepts read: ${concepts.length}; entities written: ${built.entities}; file: ${flags.out} (${statSync(flags.out).size} bytes)`);
  return built;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`build-terminology: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
