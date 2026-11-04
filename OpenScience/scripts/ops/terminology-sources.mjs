/**
 * Readers for the sources `build-terminology.mjs` folds into one terminology file.
 *
 * Every loader takes a local path and returns concept records in one shape; none reaches the network and none keeps
 * anything of the file it read except the records it returns. A record:
 *
 *   { source, sourceId, type, terms: [{ lang: "en" | "zh", text, kind }], codes: [{ system, code }], keys: [string] }
 *
 * `kind` is 0 for the source's own preferred name, 1 for a synonym, 2 for an abbreviation or a symbol. `keys` are the
 * exact strings by which a record of this source may be joined to a record of another (`en:<folded name>`,
 * `zh:<folded name>`, `sym:<folded symbol>`, `ncit:<code>`); two records that share a key are one entity unless they come
 * from the same source (see `groupConcepts` in the builder). Nothing here reads language: a key is a string equality.
 *
 * The files are untrusted bytes: the builder verifies the public ones against the digests pinned in `deps-version.json`
 * before any loader sees them, and the zip reader below bounds what it will expand.
 */

import { inflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";

/** The most one archive member may expand to. The NCIt flat file is about 93 MB; a sheet of the private workbooks about 60 MB. */
const MAX_MEMBER_BYTES = 400 * 1024 * 1024;

/**
 * The form names are compared in: width and compatibility folded, lower case, dashes and underscores read as spaces (so "Non-Small Cell" and
 * "non small cell" are one name), spaces collapsed. `terminology.py` folds the same way; a change here is a change there.
 * @param {string} value
 */
export const fold = (value) => String(value ?? "").normalize("NFKC").toLowerCase().replace(/[-\u2010-\u2015_]/g, " ").replace(/\s+/g, " ").trim();
const CJK = /[㐀-鿿豈-﫿]/u;
/** @param {string} value */
export const hasCjk = (value) => CJK.test(value);

// ---------------------------------------------------------------------------
// A minimal zip reader (stored and deflate members, no zip64): enough for an xlsx and the NCIt archive
// ---------------------------------------------------------------------------

/**
 * @param {Buffer} buffer
 * @returns {Map<string, { method: number, compressed: number, size: number, offset: number }>}
 */
function zipDirectory(buffer) {
  let end = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 65535); at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new Error("not a zip archive");
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  /** @type {Map<string, any>} */
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error("zip directory is damaged");
    const method = buffer.readUInt16LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const offset = buffer.readUInt32LE(at + 42);
    entries.set(buffer.toString("utf8", at + 46, at + 46 + nameLength), { method, compressed, size, offset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** @param {Buffer} buffer @param {{ method: number, compressed: number, size: number, offset: number }} entry */
function zipMember(buffer, entry) {
  if (entry.size > MAX_MEMBER_BYTES) throw new Error("zip member is larger than this reader will expand");
  if (buffer.readUInt32LE(entry.offset) !== 0x04034b50) throw new Error("zip member is damaged");
  const start = entry.offset + 30 + buffer.readUInt16LE(entry.offset + 26) + buffer.readUInt16LE(entry.offset + 28);
  const body = buffer.subarray(start, start + entry.compressed);
  if (entry.method === 0) return Buffer.from(body);
  if (entry.method !== 8) throw new Error(`zip member uses compression method ${entry.method}`);
  return inflateRawSync(body, { maxOutputLength: MAX_MEMBER_BYTES });
}

/** @param {string} file @param {(name: string) => boolean} pick the member to read, by name */
export function readZipMember(file, pick) {
  const buffer = readFileSync(file);
  const directory = zipDirectory(buffer);
  const name = [...directory.keys()].find(pick);
  if (!name) throw new Error("the archive has no such member");
  return zipMember(buffer, /** @type {any} */ (directory.get(name)));
}

// ---------------------------------------------------------------------------
// xlsx: the first worksheet as rows of strings
// ---------------------------------------------------------------------------

/** @param {string} text */
function unescapeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_whole, entity) => {
    const lower = String(entity).toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return "\"";
    if (lower === "apos") return "'";
    const code = lower[1] === "x" ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
  });
}

/** The text of every `<t>` inside a fragment, joined (rich-text runs are several). @param {string} fragment */
function textOf(fragment) {
  let out = "";
  for (const match of fragment.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>|<t(?:\s[^>]*)?\/>/g)) out += unescapeXml(match[1] ?? "");
  return out;
}

/** "AB12" -> zero-based column 27. @param {string} reference */
function columnOf(reference) {
  let column = 0;
  for (const char of reference) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) break;
    column = column * 26 + (code - 64);
  }
  return column - 1;
}

/**
 * The first worksheet of an xlsx file as arrays of strings (an empty cell is `""`). A formula cell yields its cached value.
 * @param {string} file @returns {string[][]}
 */
export function readXlsxRows(file) {
  const buffer = readFileSync(file);
  const directory = zipDirectory(buffer);
  const member = (/** @type {string} */ name) => {
    const entry = directory.get(name);
    return entry ? zipMember(buffer, entry).toString("utf8") : null;
  };
  const shared = [];
  const strings = member("xl/sharedStrings.xml");
  if (strings) for (const match of strings.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si\s*\/>/g)) shared.push(textOf(match[1] ?? ""));
  const sheetName = [...directory.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))[0];
  const sheet = sheetName ? member(sheetName) : null;
  if (!sheet) throw new Error("the workbook has no worksheet");
  /** @type {string[][]} */
  const rows = [];
  for (const row of sheet.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
    /** @type {string[]} */
    const cells = [];
    for (const cell of row[1].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cell[1];
      const reference = /\br="([A-Z]+)\d+"/.exec(attributes)?.[1];
      if (!reference) continue;
      const type = /\bt="([^"]*)"/.exec(attributes)?.[1] ?? "n";
      const body = cell[2] ?? "";
      let value = "";
      if (type === "s") value = shared[Number(/<v>(\d+)<\/v>/.exec(body)?.[1])] ?? "";
      else if (type === "inlineStr") value = textOf(body);
      else value = unescapeXml(/<v>([^<]*)<\/v>/.exec(body)?.[1] ?? "");
      cells[columnOf(reference)] = value;
    }
    for (let index = 0; index < cells.length; index += 1) if (cells[index] === undefined) cells[index] = "";
    rows.push(cells);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Type vocabularies: closed tables, the source's own classes mapped to the few kinds the tool reports
// ---------------------------------------------------------------------------

export const CONCEPT_TYPES = Object.freeze(["disease", "finding", "drug", "chemical", "gene", "variant", "procedure", "lab", "anatomy", "organism", "phenotype", "other"]);

/** NCI Thesaurus semantic types the file keeps, and the kind each is reported as. A type not listed is left out of the file (the 205,010 live concepts include 29,201 questionnaire items). */
const NCIT_TYPES = Object.freeze(/** @type {Record<string, string>} */ ({
  "Neoplastic Process": "disease", "Disease or Syndrome": "disease", "Cell or Molecular Dysfunction": "disease", "Pathologic Function": "disease",
  "Mental or Behavioral Dysfunction": "disease", "Injury or Poisoning": "disease", "Congenital Abnormality": "disease", "Acquired Abnormality": "disease",
  "Anatomical Abnormality": "disease", "Experimental Model of Disease": "disease",
  "Finding": "finding", "Sign or Symptom": "finding", "Clinical Attribute": "finding", "Laboratory or Test Result": "lab",
  "Pharmacologic Substance": "drug", "Clinical Drug": "drug", "Antibiotic": "drug", "Vitamin": "drug", "Hormone": "drug", "Immunologic Factor": "drug",
  "Biologically Active Substance": "chemical", "Organic Chemical": "chemical", "Inorganic Chemical": "chemical", "Element, Ion, or Isotope": "chemical",
  "Amino Acid, Peptide, or Protein": "chemical", "Enzyme": "chemical", "Receptor": "chemical", "Nucleic Acid, Nucleoside, or Nucleotide": "chemical",
  "Therapeutic or Preventive Procedure": "procedure", "Diagnostic Procedure": "procedure", "Laboratory Procedure": "lab",
  "Body Part, Organ, or Organ Component": "anatomy", "Anatomical Structure": "anatomy", "Body Location or Region": "anatomy", "Body Substance": "anatomy",
  "Tissue": "anatomy", "Cell": "anatomy", "Cell Component": "anatomy", "Body System": "anatomy",
  "Bacterium": "organism", "Virus": "organism", "Fungus": "organism", "Eukaryote": "organism", "Archaeon": "organism",
}));

/** The root letters of a MeSH tree number and the kind each is reported as. @type {Record<string, string>} */
const MESH_ROOTS = Object.freeze({ A: "anatomy", B: "organism", C: "disease", D: "chemical", E: "procedure", F: "disease", G: "other", H: "other", I: "other", J: "other", K: "other", L: "other", M: "other", N: "other", V: "other", Z: "other" });

/** The kinds `medical-term-kinds.txt` labels a term with. @type {Record<string, string>} */
const LEXICON_KINDS = Object.freeze({ DISEASE: "disease", DRUG: "drug", ANATOMY: "anatomy", INTERVENTION: "procedure", LAB_MARKER: "lab", ORGANIZATION: "other" });

/** @param {string} source @param {string} sourceId @param {string} type */
const concept = (source, sourceId, type) => ({ source, sourceId, type, terms: /** @type {Array<{ lang: "en" | "zh", text: string, kind: number }>} */ ([]), codes: /** @type {Array<{ system: string, code: string }>} */ ([]), keys: /** @type {string[]} */ ([]) });

/** @param {ReturnType<typeof concept>} record @param {"en" | "zh"} lang @param {unknown} text @param {number} kind */
function addTerm(record, lang, text, kind) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!value || value.length > 300) return;
  if (record.terms.some((term) => term.lang === lang && fold(term.text) === fold(value))) return;
  record.terms.push({ lang, text: value, kind });
}

/** @param {ReturnType<typeof concept>} record @param {string} system @param {unknown} code */
function addCode(record, system, code) {
  const value = String(code ?? "").trim();
  if (value && value.length <= 80 && !record.codes.some((entry) => entry.system === system && entry.code === value)) record.codes.push({ system, code: value });
}

/** @param {ReturnType<typeof concept>} record @param {string} key */
const addKey = (record, key) => { if (key && !record.keys.includes(key)) record.keys.push(key); };

/** The English name of a record is a join key; the Chinese one too. @param {ReturnType<typeof concept>} record */
function nameKeys(record) {
  for (const term of record.terms) if (term.kind === 0) addKey(record, `${term.lang}:${fold(term.text)}`);
  return record;
}

/** Tab-separated lines, comments and blanks skipped. @param {string} text */
function tabLines(text) {
  return text.split(/\r?\n/).filter((line) => line && !line.startsWith("#")).map((line) => line.split("\t"));
}

// ---------------------------------------------------------------------------
// Loaders: each returns concept records
// ---------------------------------------------------------------------------

/**
 * The curated zh<->en bridge (`medical-zh-en.txt`: Chinese, a tab, English renderings separated by `|`) with the kind each Chinese term was labelled
 * (`medical-term-kinds.txt`). Rows of the lexicon that carry an ICD-10 code (`medical-lexicon.txt`: code, tab, name, tab, weight) are loaded as ICD-10
 * names; its other rows are not (they have no English, and the file does not say which of its sources a word came from).
 * @param {{ bridge: string, kinds?: string | null, lexicon?: string | null }} files text of each file
 */
export function loadLexicon({ bridge, kinds = null, lexicon = null }) {
  /** @type {Map<string, string>} */
  const kindOf = new Map();
  if (kinds) for (const [term, kind] of tabLines(kinds)) if (term && LEXICON_KINDS[kind]) kindOf.set(term, LEXICON_KINDS[kind]);
  /** @type {ReturnType<typeof concept>[]} */
  const out = [];
  for (const [zh, english] of tabLines(bridge)) {
    if (!zh || !english) continue;
    const record = concept("evimed-zh-en", zh, kindOf.get(zh) ?? "other");
    addTerm(record, "zh", zh, 0);
    for (const variant of english.split("|")) addTerm(record, "en", variant, record.terms.some((term) => term.lang === "en") ? 1 : 0);
    nameKeys(record);
    for (const term of record.terms) if (term.lang === "en") addKey(record, `en:${fold(term.text)}`);
    out.push(record);
  }
  if (lexicon) {
    for (const [code, name] of tabLines(lexicon)) {
      if (!/^[A-Z]\d{2}(?:\.\d+)?$/.test(code ?? "") || !name) continue;
      const record = concept("evimed-icd10-names", code, "disease");
      addTerm(record, "zh", name, 0);
      addCode(record, "ICD-10", code);
      out.push(nameKeys(record));
    }
  }
  return out;
}

/**
 * The national-insurance ICD-10 index (diagnosis level, Chinese names with codes and aliases).
 * @param {string} json file text
 */
export function loadIcdIndex(json) {
  const data = JSON.parse(json);
  /** @type {ReturnType<typeof concept>[]} */
  const out = [];
  for (const entry of Array.isArray(data?.entries) ? data.entries : []) {
    if (!entry?.code || !entry?.name) continue;
    const record = concept("icd10-cn-index", String(entry.code), "disease");
    addTerm(record, "zh", entry.name, 0);
    for (const alias of Array.isArray(entry.aliases) ? entry.aliases : []) addTerm(record, "zh", alias, 1);
    addCode(record, "ICD-10-CN", entry.code);
    out.push(nameKeys(record));
  }
  return out;
}

/**
 * ICD-10 categories and subcategories in Chinese and English, from the bilingual workbook (columns: category code, Chinese, English, subcategory code,
 * Chinese, English). The diagnosis rows below them are the index's.
 * @param {string[][]} rows
 */
export function loadIcdBilingual(rows) {
  const header = rows[0] ?? [];
  const column = (/** @type {RegExp} */ pattern) => header.findIndex((cell) => pattern.test(String(cell).replace(/\s+/g, "")));
  const at = { cat: column(/^类目代码$/), catZh: column(/^类目名称-中文$/), catEn: column(/^类目名称-英文$/), sub: column(/^亚目代码$/), subZh: column(/^亚目名称-中文$/), subEn: column(/^亚目名称-英文$/) };
  if (Object.values(at).some((index) => index < 0)) throw new Error("the ICD-10 workbook does not have the expected columns");
  /** @type {Map<string, ReturnType<typeof concept>>} */
  const found = new Map();
  for (const row of rows.slice(1)) {
    for (const [code, zh, en] of [[row[at.cat], row[at.catZh], row[at.catEn]], [row[at.sub], row[at.subZh], row[at.subEn]]]) {
      const id = String(code ?? "").trim();
      if (!/^[A-Z]\d{2}(?:\.\d+)?$/.test(id) || !zh || !en || found.has(id)) continue;
      const record = concept("icd10-cn-bilingual", id, "disease");
      addTerm(record, "en", en, 0);
      addTerm(record, "zh", zh, 0);
      addCode(record, "ICD-10", id);
      found.set(id, nameKeys(record));
    }
  }
  return [...found.values()];
}

/**
 * The disease-name workbook: Chinese name, English full name, English abbreviation.
 * @param {string[][]} rows
 */
export function loadDiseaseNames(rows) {
  /** @type {ReturnType<typeof concept>[]} */
  const out = [];
  for (const [index, row] of rows.slice(1).entries()) {
    const [zh, en, abbreviation] = row;
    if (!zh || !en) continue;
    const record = concept("disease-names", `row${index + 2}`, "disease");
    addTerm(record, "zh", zh, 0);
    addTerm(record, "en", en, 0);
    addTerm(record, "en", abbreviation, 2);
    out.push(nameKeys(record));
  }
  return out;
}

/** @param {string} value the entry_terms cell, a JSON array in a string */
function jsonList(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** @param {string} trees a comma-separated list of tree numbers */
function meshType(trees) {
  const first = String(trees).split(",").map((tree) => tree.trim()).filter(Boolean)[0];
  return MESH_ROOTS[first?.[0] ?? ""] ?? "other";
}

/**
 * English MeSH from the workbook (name, entry terms as a JSON list, tree numbers, unique id). A row without a unique id is a heading the workbook
 * invented for a tree root and is left out.
 * @param {string[][]} rows
 */
export function loadMesh(rows) {
  const header = rows[0] ?? [];
  const at = { name: header.indexOf("name"), entry: header.indexOf("entry_terms"), tree: header.indexOf("Tree_Number"), unique: header.indexOf("MeSH_Unique") };
  if (Object.values(at).some((index) => index < 0)) throw new Error("the MeSH workbook does not have the expected columns");
  /** @type {ReturnType<typeof concept>[]} */
  const out = [];
  for (const row of rows.slice(1)) {
    const unique = String(row[at.unique] ?? "").trim();
    const name = String(row[at.name] ?? "").trim();
    if (!/^D\d{6,9}$/.test(unique) || !name) continue;
    const record = concept("mesh", unique, meshType(row[at.tree] ?? ""));
    addTerm(record, "en", name, 0);
    for (const entry of jsonList(row[at.entry] ?? "")) addTerm(record, "en", entry, 1);
    addCode(record, "MeSH", unique);
    for (const tree of String(row[at.tree] ?? "").split(",")) addCode(record, "MeSH tree", tree);
    addKey(record, `mesh:${unique}`);
    out.push(nameKeys(record));
  }
  return out;
}

/**
 * Chinese MeSH (the Chinese Medical Subject Headings workbook): Chinese heading, entry terms (separated by `;`, some in English), tree numbers, English
 * heading, and the MeSH unique id where the workbook has it in the `jgh` column.
 * @param {string[][]} rows
 */
export function loadChineseMesh(rows) {
  const header = rows[0] ?? [];
  const at = { name: header.indexOf("name"), unique: header.indexOf("jgh"), entry: header.indexOf("款目词"), tree: header.indexOf("树状结构号"), english: header.indexOf("英文名称") };
  if (Object.values(at).some((index) => index < 0)) throw new Error("the Chinese MeSH workbook does not have the expected columns");
  /** @type {ReturnType<typeof concept>[]} */
  const out = [];
  for (const [index, row] of rows.slice(1).entries()) {
    const name = String(row[at.name] ?? "").trim();
    const english = String(row[at.english] ?? "").trim();
    if (!name || !english || !hasCjk(name)) continue;
    const unique = String(row[at.unique] ?? "").trim();
    const record = concept("cmesh", /^D\d{6,9}$/.test(unique) ? unique : `row${index + 2}`, meshType(row[at.tree] ?? ""));
    addTerm(record, "zh", name, 0);
    addTerm(record, "en", english, 0);
    for (const entry of String(row[at.entry] ?? "").split(/;/).map((value) => value.replace(/ /g, " ").trim()).filter(Boolean)) {
      addTerm(record, hasCjk(entry) ? "zh" : "en", entry, 1);
    }
    if (/^D\d{6,9}$/.test(unique)) addKey(record, `mesh:${unique}`);
    nameKeys(record);
    // The English heading is how it meets the English MeSH when the workbook gave no unique id.
    out.push(record);
  }
  return out;
}

/**
 * The NCI Thesaurus flat file (tab separated: code, IRI, parents, synonyms, definition, display name, status, semantic type, subsets). Retired concepts and
 * the semantic types the file does not keep are left out; definitions are not kept. The file is 90 MB, so it is read line by line from its bytes.
 * @param {Buffer | string} input
 */
export function loadNcit(input) {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  /** @type {ReturnType<typeof concept>[]} */
  const out = [];
  let start = 0;
  while (start < buffer.length) {
    let end = buffer.indexOf(10, start);
    if (end < 0) end = buffer.length;
    const line = buffer.toString("utf8", start, end);
    start = end + 1;
    const cells = line.split("\t");
    if (cells.length < 8 || !/^C\d+$/.test(cells[0])) continue;
    if (cells[6] === "Retired_Concept") continue;
    const type = cells[7].split("|").map((entry) => NCIT_TYPES[entry]).find(Boolean);
    if (!type) continue;
    const record = concept("ncit", cells[0], type);
    const display = cells[5].trim() || cells[3].split("|")[0];
    addTerm(record, "en", display, 0);
    for (const synonym of cells[3].split("|")) addTerm(record, "en", synonym, /^[A-Z0-9][A-Z0-9 .+\-/]{0,14}$/.test(synonym.trim()) && synonym.trim().length <= 8 ? 2 : 1);
    addCode(record, "NCIt", cells[0]);
    addKey(record, `ncit:${cells[0]}`);
    out.push(nameKeys(record));
  }
  return out;
}

/**
 * The Human Phenotype Ontology (its JSON release) with the Chinese labels of the consortium's translation file (`hp-zh.babelon.tsv`).
 * @param {{ json: string, zh?: string | null }} files
 */
export function loadHpo({ json, zh = null }) {
  const graph = JSON.parse(json)?.graphs?.[0];
  /** @type {Map<string, string>} */
  const chinese = new Map();
  if (zh) {
    for (const line of zh.split(/\r?\n/).slice(1)) {
      const cells = line.split("\t");
      if (cells[3] === "rdfs:label" && cells[2]?.startsWith("HP:") && cells[5]) chinese.set(cells[2], cells[5]);
    }
  }
  /** @type {ReturnType<typeof concept>[]} */
  const out = [];
  for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    const match = /^http:\/\/purl\.obolibrary\.org\/obo\/(HP_\d{7})$/.exec(String(node?.id ?? ""));
    if (!match || node.type !== "CLASS" || !node.lbl || node.meta?.deprecated) continue;
    const id = match[1].replace("_", ":");
    const record = concept("hpo", id, "phenotype");
    addTerm(record, "en", node.lbl, 0);
    for (const synonym of Array.isArray(node.meta?.synonyms) ? node.meta.synonyms : []) {
      if (synonym?.pred === "hasExactSynonym" || synonym?.pred === "hasRelatedSynonym") addTerm(record, "en", synonym.val, 1);
    }
    addTerm(record, "zh", chinese.get(id), 0);
    addCode(record, "HPO", id);
    for (const xref of Array.isArray(node.meta?.xrefs) ? node.meta.xrefs : []) {
      const [prefix, value] = String(xref?.val ?? "").split(":");
      if (prefix === "ICD-10" && value) addCode(record, "ICD-10", value);
      if (prefix === "NCIT" && value) addKey(record, `ncit:${value}`);
    }
    out.push(nameKeys(record));
  }
  return out;
}

/** Splits a cell of the HGNC file; the file separates values by `|`. @param {string} value */
const pipeList = (value) => String(value ?? "").split("|").map((entry) => entry.trim()).filter(Boolean);

/**
 * Approved HGNC gene records other than pseudogenes: symbol, name, aliases and previous symbols, with the identifiers the trial registries and
 * pathology reports use.
 * @param {string} text the tab-separated file
 */
export function loadHgnc(text) {
  const lines = text.split(/\r?\n/);
  const header = (lines.shift() ?? "").split("\t");
  const at = Object.fromEntries(["hgnc_id", "symbol", "name", "locus_group", "status", "alias_symbol", "alias_name", "prev_symbol", "prev_name", "entrez_id", "ensembl_gene_id", "omim_id", "uniprot_ids"].map((name) => [name, header.indexOf(name)]));
  if (Object.values(at).some((index) => index < 0)) throw new Error("the HGNC file does not have the expected columns");
  /** @type {ReturnType<typeof concept>[]} */
  const out = [];
  for (const line of lines) {
    const cells = line.split("\t");
    if (cells.length < header.length - 4 || cells[at.status] !== "Approved" || cells[at.locus_group] === "pseudogene" || !cells[at.symbol]) continue;
    const record = concept("hgnc", cells[at.hgnc_id], "gene");
    addTerm(record, "en", cells[at.symbol], 0);
    addTerm(record, "en", cells[at.name], 1);
    for (const alias of pipeList(cells[at.alias_symbol])) addTerm(record, "en", alias, 2);
    for (const alias of pipeList(cells[at.prev_symbol])) addTerm(record, "en", alias, 2);
    for (const alias of pipeList(cells[at.alias_name]).slice(0, 4)) addTerm(record, "en", alias, 1);
    addCode(record, "HGNC", cells[at.hgnc_id]);
    addCode(record, "Entrez Gene", cells[at.entrez_id]);
    addCode(record, "Ensembl", cells[at.ensembl_gene_id]);
    addCode(record, "OMIM", pipeList(cells[at.omim_id])[0]);
    addCode(record, "UniProt", pipeList(cells[at.uniprot_ids])[0]);
    addKey(record, `sym:${fold(cells[at.symbol])}`);
    out.push(record);
  }
  return out;
}

/**
 * CIViC's gene (and fusion) summaries and its variant summaries. A gene meets HGNC by its symbol and NCIt by the code CIViC states; a variant is a
 * concept of its own named `<gene> <variant>`, with the aliases CIViC lists (protein-change spellings, dbSNP ids).
 * @param {{ genes: string, variants: string }} files
 */
export function loadCivic({ genes, variants }) {
  /** @param {string} text */
  const table = (text) => {
    const lines = text.split(/\r?\n/);
    const header = (lines.shift() ?? "").split("\t");
    return { header, rows: lines.filter(Boolean).map((line) => line.split("\t")) };
  };
  /** @type {ReturnType<typeof concept>[]} */
  const out = [];
  const gene = table(genes);
  const g = Object.fromEntries(["feature_id", "feature_type", "name", "feature_aliases", "entrez_id", "ncit_id"].map((name) => [name, gene.header.indexOf(name)]));
  for (const row of gene.rows) {
    if (row[g.feature_type] !== "Gene" || !row[g.name]) continue;
    const record = concept("civic", `gene${row[g.feature_id]}`, "gene");
    addTerm(record, "en", row[g.name], 0);
    for (const alias of String(row[g.feature_aliases] ?? "").split(",")) addTerm(record, "en", alias, 2);
    addCode(record, "CIViC gene", row[g.feature_id]);
    addCode(record, "Entrez Gene", row[g.entrez_id]);
    addKey(record, `sym:${fold(row[g.name])}`);
    if (/^C\d+$/.test(row[g.ncit_id] ?? "")) { addCode(record, "NCIt", row[g.ncit_id]); addKey(record, `ncit:${row[g.ncit_id]}`); }
    out.push(record);
  }
  const variant = table(variants);
  const v = Object.fromEntries(["variant_id", "feature_type", "feature_name", "variant", "variant_aliases", "clinvar_ids", "ncit_id", "allele_registry_id"].map((name) => [name, variant.header.indexOf(name)]));
  for (const row of variant.rows) {
    if (row[v.feature_type] !== "Gene" || !row[v.feature_name] || !row[v.variant]) continue;
    const record = concept("civic", `variant${row[v.variant_id]}`, "variant");
    addTerm(record, "en", `${row[v.feature_name]} ${row[v.variant]}`, 0);
    for (const alias of String(row[v.variant_aliases] ?? "").split(",")) {
      const text = alias.trim();
      if (text) addTerm(record, "en", `${row[v.feature_name]} ${text}`, 1);
    }
    addCode(record, "CIViC variant", row[v.variant_id]);
    addCode(record, "ClinVar", String(row[v.clinvar_ids] ?? "").split(",")[0]);
    addCode(record, "ClinGen Allele Registry", row[v.allele_registry_id]);
    if (/^C\d+$/.test(row[v.ncit_id] ?? "")) { addCode(record, "NCIt", row[v.ncit_id]); addKey(record, `ncit:${row[v.ncit_id]}`); }
    out.push(nameKeys(record));
  }
  return out;
}
