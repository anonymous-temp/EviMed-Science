/**
 * Reading a delivered file's structure: the headings of a document, the titles of a deck, the sheets and header row of a workbook,
 * the top-level definitions of a script, the header of a table — a bounded list of labels, and nothing of the prose.
 *
 * Hidden knowledge: this is the one reader of file contents the learning loop has, and it exists so that "the same kind of work
 * three times" (`routine`, learningTriggers.mjs) can be decided from what the work left rather than from the capability id alone,
 * which the ordinary conversation does not have. The domain keeps the vocabulary (`artifactShape.mjs`: how a label is cleaned and
 * when two shapes match); this reads the bytes. It is not a second `file-deliverable` check: those say whether a file opens, and
 * this says what is inside it, and the two never share a verdict.
 *
 * Bounded everywhere, because the file is the model's: a file over `SHAPE_READ_BYTES` is not read (its shape is its format), an
 * Office entry that inflates past `SHAPE_ENTRY_BYTES` is not read, and a zip with a directory this reader does not follow
 * (Zip64, an entry out of bounds) has no labels. A reader that cannot read is not a failure: the shape then carries the format and
 * no labels, which matches on the format alone, and an unreadable path has no shape at all.
 *
 * Deletable when the kernel states what a turn produced as typed output.
 *
 * @module artifactShapes
 */

import path from "node:path";
import { inflateRawSync } from "node:zlib";

import { ARTIFACT_SHAPE_LIMITS, cleanArtifactShape, fileFormatOf } from "@evimed/domain";
import { openScopedFileNoFollow } from "./security.mjs";

/** The largest file whose contents are read, and the largest an Office part may inflate to. */
export const SHAPE_READ_BYTES = 16 * 1024 * 1024;
export const SHAPE_ENTRY_BYTES = 8 * 1024 * 1024;
/** How many of a run's files are read. */
export const SHAPE_FILES = 12;

/** @param {string} text @returns {string} */
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match, entity) => {
    const key = String(entity).toLowerCase();
    if (key === "amp") return "&";
    if (key === "lt") return "<";
    if (key === "gt") return ">";
    if (key === "quot") return '"';
    if (key === "apos") return "'";
    const code = key.startsWith("#x") ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
  });
}

/** The text of every `<tag ...>text</tag>` run in an XML fragment, joined. @param {string} xml @param {string} tag */
function runsOf(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "g"))].map((match) => decodeEntities(match[1])).join("");
}

/**
 * The entries of a zip package, by name, each read on demand. Null when the bytes are not a zip whose central directory this reads.
 * @param {Uint8Array} bytes
 * @returns {{ names: string[], read: (name: string) => string | null } | null}
 */
export function zipPackage(bytes) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 22) return null;
  let end = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 65_535); at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) return null;
  const count = buffer.readUInt16LE(end + 10);
  const directory = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || directory === 0xffffffff || directory >= buffer.length) return null;
  /** @type {Map<string, { method: number, size: number, uncompressed: number, local: number }>} */
  const entries = new Map();
  let at = directory;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) return null;
    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20);
    const uncompressed = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    if (at + 46 + nameLength > buffer.length) return null;
    entries.set(buffer.toString("utf8", at + 46, at + 46 + nameLength), { method, size, uncompressed, local });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const entry = entries.get(name);
      if (!entry || entry.uncompressed > SHAPE_ENTRY_BYTES || entry.local + 30 > buffer.length || buffer.readUInt32LE(entry.local) !== 0x04034b50) return null;
      const start = entry.local + 30 + buffer.readUInt16LE(entry.local + 26) + buffer.readUInt16LE(entry.local + 28);
      if (start + entry.size > buffer.length) return null;
      const data = buffer.subarray(start, start + entry.size);
      try {
        if (entry.method === 0) return data.toString("utf8");
        if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: SHAPE_ENTRY_BYTES }).toString("utf8");
      } catch { /* an entry that does not inflate has no labels */ }
      return null;
    },
  };
}

/** @param {string[]} labels @param {unknown} label */
function push(labels, label) {
  const text = String(label ?? "").replace(/\s+/g, " ").trim();
  if (text && labels.length < ARTIFACT_SHAPE_LIMITS.labels * 2) labels.push(text);
}

/** Headings of a Word document: the paragraphs styled as a title or a heading. @param {{ read: (name: string) => string | null }} zip */
function docxLabels(zip) {
  const xml = zip.read("word/document.xml") ?? "";
  /** @type {string[]} */
  const labels = [];
  for (const paragraph of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const style = /<w:pStyle\s+w:val="([^"]*)"/.exec(paragraph[0])?.[1] ?? "";
    if (!/^(?:heading\s*\d|title|subtitle|标题\s*\d*)/i.test(style)) continue;
    push(labels, runsOf(paragraph[0], "w:t"));
  }
  return labels;
}

/** The title of each slide, in order. @param {{ names: string[], read: (name: string) => string | null }} zip */
function pptxLabels(zip) {
  const slides = zip.names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => Number(/(\d+)\.xml$/.exec(left)?.[1]) - Number(/(\d+)\.xml$/.exec(right)?.[1]));
  /** @type {string[]} */
  const labels = [];
  for (const name of slides) {
    const xml = zip.read(name) ?? "";
    const title = [...xml.matchAll(/<p:sp[ >][\s\S]*?<\/p:sp>/g)].find((shape) => /<p:ph[^>]*type="(?:title|ctrTitle)"/.test(shape[0]));
    push(labels, title ? runsOf(title[0], "a:t") : "");
  }
  return labels;
}

/** The sheet names of a workbook and the header row of its first sheet. @param {{ read: (name: string) => string | null }} zip */
function xlsxLabels(zip) {
  /** @type {string[]} */
  const labels = [];
  for (const sheet of (zip.read("xl/workbook.xml") ?? "").matchAll(/<sheet\s[^>]*name="([^"]*)"/g)) push(labels, `sheet ${decodeEntities(sheet[1])}`);
  const strings = [...(zip.read("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((entry) => runsOf(entry[1], "t"));
  const sheetXml = zip.read("xl/worksheets/sheet1.xml") ?? "";
  const row = /<row\s[^>]*>([\s\S]*?)<\/row>/.exec(sheetXml)?.[1] ?? "";
  for (const cell of row.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const kind = /\bt="([^"]*)"/.exec(cell[1])?.[1];
    const inner = cell[2] ?? "";
    if (kind === "s") push(labels, strings[Number(/<v>(\d+)<\/v>/.exec(inner)?.[1])]);
    else if (kind === "inlineStr") push(labels, runsOf(inner, "t"));
  }
  return labels;
}

/** @param {string} text @param {string} extension @returns {string[]} */
function textLabels(text, extension) {
  /** @type {string[]} */
  const labels = [];
  const lines = text.split(/\r?\n/);
  if (extension === "md" || extension === "markdown") {
    for (const line of lines) {
      const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) push(labels, heading[1]);
    }
  } else if (extension === "tex") {
    for (const match of text.matchAll(/\\(?:chapter|section|subsection)\*?\{([^}]*)\}/g)) push(labels, match[1]);
  } else if (extension === "rst") {
    for (let index = 1; index < lines.length; index += 1) if (/^([=\-~^"#*+])\1{2,}\s*$/.test(lines[index]) && lines[index - 1].trim()) push(labels, lines[index - 1]);
  } else if (extension === "csv" || extension === "tsv") {
    const header = (lines.find((line) => line.trim()) ?? "").split(extension === "tsv" ? "\t" : ",");
    for (const cell of header) push(labels, cell.replace(/^"|"$/g, ""));
  } else if (extension === "json") {
    try {
      const parsed = JSON.parse(text);
      const sample = Array.isArray(parsed) ? parsed.find((item) => item && typeof item === "object" && !Array.isArray(item)) : parsed;
      if (sample && typeof sample === "object" && !Array.isArray(sample)) for (const key of Object.keys(sample)) push(labels, key);
    } catch { /* not a document of one value: no labels */ }
  } else if (extension === "py") {
    for (const line of lines) {
      const found = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/.exec(line);
      if (found) push(labels, found[1]);
    }
  } else if (["js", "mjs", "cjs", "ts", "tsx", "jsx"].includes(extension)) {
    for (const line of lines) {
      const found = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (found) push(labels, found[1]);
    }
  } else if (extension === "r") {
    for (const line of lines) {
      const found = /^([A-Za-z_.][\w.]*)\s*(?:<-|=)\s*function\b/.exec(line);
      if (found) push(labels, found[1]);
    }
  } else if (extension === "sh" || extension === "bash") {
    for (const line of lines) {
      const found = /^(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{?/.exec(line);
      if (found) push(labels, found[1]);
    }
  } else if (extension === "sql") {
    for (const match of text.matchAll(/\bcreate\s+(?:or\s+replace\s+)?(?:table|view|function)\s+(?:if\s+not\s+exists\s+)?([\w."]+)/gi)) push(labels, match[1]);
  }
  return labels;
}

/**
 * The shape of one file from its bytes, or null for a name with no extension this reads as anything. Pure.
 * @param {string} relativePath @param {Uint8Array} bytes
 * @returns {import("@evimed/domain").ArtifactShape | null}
 */
export function shapeOfBytes(relativePath, bytes) {
  const format = fileFormatOf(relativePath);
  const extension = format.extension || "other";
  /** @type {string[]} */
  let labels = [];
  try {
    if (bytes.byteLength <= SHAPE_READ_BYTES) {
      if (format.kind === "office") {
        const zip = zipPackage(bytes);
        if (zip) labels = extension === "docx" ? docxLabels(zip) : extension === "pptx" ? pptxLabels(zip) : xlsxLabels(zip);
      } else if (format.kind === "text") {
        labels = textLabels(Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 2 * 1024 * 1024)).toString("utf8"), extension);
      }
    }
  } catch { /* a reader that throws on a strange file leaves the format */ }
  return cleanArtifactShape({ format: extension, labels });
}

/**
 * The shapes of a run's files, by workspace-relative path. A file that is not there, is a link, or cannot be opened has none.
 * @param {{ workspaceDir: string }} project @param {readonly string[]} files
 * @returns {Promise<Record<string, import("@evimed/domain").ArtifactShape>>}
 */
export async function readArtifactShapes(project, files) {
  /** @type {Record<string, import("@evimed/domain").ArtifactShape>} */
  const shapes = {};
  for (const relative of [...new Set(files)].slice(0, SHAPE_FILES)) {
    let opened;
    try {
      opened = await openScopedFileNoFollow(project.workspaceDir, path.join(project.workspaceDir, relative));
      if (!opened.stat.isFile()) continue;
      const bytes = opened.stat.size <= SHAPE_READ_BYTES ? new Uint8Array(await opened.handle.readFile()) : new Uint8Array(0);
      const shape = shapeOfBytes(relative, bytes);
      if (shape) shapes[relative] = shape;
    } catch { /* unreadable, escaped or linked: no shape */ }
    finally { await opened?.handle.close().catch(() => {}); }
  }
  return shapes;
}
