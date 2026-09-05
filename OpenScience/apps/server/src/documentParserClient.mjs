import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./security.mjs";

const textExtensions = new Set([".txt", ".md", ".csv", ".tsv", ".json", ".yaml", ".yml", ".xml", ".html", ".r", ".py", ".sql"]);
const unitTypes = new Set(["page", "slide", "segment", "column", "chunk", "row_group"]);
const unitStatuses = new Set(["extracted", "indexed_only", "no_content", "failed"]);

function parserError(code, message, status = 502) {
  return new HttpError(status, code, message);
}

/** @param {Response} response @param {number} limit */
async function boundedBody(response, limit) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) throw parserError("source_parser_response_too_large", "Document parser response exceeded its limit.");
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  let complete = false;
  while (!complete) {
    const { done, value } = await reader.read();
    if (done) { complete = true; continue; }
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel().catch(() => {});
      throw parserError("source_parser_response_too_large", "Document parser response exceeded its limit.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** @param {unknown} value @param {string} field @param {number} max */
function stringField(value, field, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw parserError("source_parser_response_invalid", `Parser ${field} is invalid.`);
  return value;
}

/** @param {any} value */
function validateResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.protocolVersion !== 1) {
    throw parserError("source_parser_response_invalid", "Document parser returned an unsupported response.");
  }
  const extractor = value.extractor;
  if (!extractor || typeof extractor !== "object" || Array.isArray(extractor)) throw parserError("source_parser_response_invalid", "Document parser omitted extractor identity.");
  const units = value.units;
  if (!Array.isArray(units) || units.length < 1 || units.length > 100_000) throw parserError("source_parser_response_invalid", "Document parser omitted source coverage.");
  const seen = new Set();
  const normalizedUnits = units.map((unit) => {
    if (!unit || typeof unit !== "object" || Array.isArray(unit)) throw parserError("source_parser_response_invalid", "Document parser returned an invalid unit.");
    const id = stringField(unit.id, "unit id", 160);
    if (seen.has(id)) throw parserError("source_parser_response_invalid", "Document parser returned duplicate units.");
    seen.add(id);
    const unitType = stringField(unit.unitType, "unit type", 32);
    const status = stringField(unit.status, "unit status", 32);
    if (!unitTypes.has(unitType) || !unitStatuses.has(status)) throw parserError("source_parser_response_invalid", "Document parser returned an unknown coverage value.");
    if (!Array.isArray(unit.itemIds) || unit.itemIds.length > 500 || unit.itemIds.some((idValue) => typeof idValue !== "string" || !idValue || idValue.length > 160)) {
      throw parserError("source_parser_response_invalid", "Document parser returned invalid item ids.");
    }
    return { id, unitType, status, itemIds: [...new Set(unit.itemIds)] };
  });
  const facts = Array.isArray(value.facts) ? value.facts.slice(0, 10_000) : [];
  const methods = Array.isArray(value.methods) ? value.methods.slice(0, 2_000) : [];
  return {
    extractor: {
      name: stringField(extractor.name, "extractor name", 80),
      version: stringField(extractor.version, "extractor version", 80),
      parser: stringField(extractor.parser, "parser mode", 32),
    },
    units: normalizedUnits,
    summary: stringField(value.summary, "summary", 16_000),
    facts,
    methods,
    text: stringField(value.text, "text", 16 * 1024 * 1024),
  };
}

/** Internal MinerU boundary with a no-network text fallback. */
export class DocumentParserClient {
  /** @param {{baseUrl?:string,token?:string,fetchImpl?:typeof fetch,timeoutMs?:number,maxResponseBytes?:number,maxTextBytes?:number,chunkChars?:number}} config */
  constructor({ baseUrl = "", token = "", fetchImpl = globalThis.fetch, timeoutMs = 600_000,
    maxResponseBytes = 32 * 1024 * 1024, maxTextBytes = 16 * 1024 * 1024, chunkChars = 8_000 } = {}) {
    this.baseUrl = String(baseUrl).trim().replace(/\/+$/, "");
    if (this.baseUrl) {
      let parsed;
      try { parsed = new URL(this.baseUrl); } catch { throw new TypeError("Document parser URL is invalid."); }
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new TypeError("Document parser URL is invalid.");
    }
    if (![timeoutMs, maxResponseBytes, maxTextBytes, chunkChars].every(Number.isSafeInteger)
      || timeoutMs < 1000 || maxResponseBytes < 1024 || maxTextBytes < 1024 || chunkChars < 256) {
      throw new TypeError("Document parser limits are invalid.");
    }
    this.token = String(token);
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.maxTextBytes = maxTextBytes;
    this.chunkChars = chunkChars;
  }

  /** @param {{path:string,mimeType:string,sha256:string,sourceId:string}} input */
  async parse(input) {
    if (!this.baseUrl) return this.parseText(input);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/v1/parse`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
    } catch (error) {
      const code = error?.name === "AbortError" ? "source_parser_timeout" : "source_parser_unavailable";
      throw parserError(code, code === "source_parser_timeout" ? "Document parsing timed out." : "Document parser is unavailable.", 503);
    } finally { clearTimeout(timeout); }
    if (!response.ok) throw parserError("source_parser_failed", `Document parser returned HTTP ${response.status}.`);
    const bytes = await boundedBody(response, this.maxResponseBytes);
    let parsed;
    try { parsed = JSON.parse(bytes.toString("utf8")); }
    catch { throw parserError("source_parser_response_invalid", "Document parser returned invalid JSON."); }
    return validateResult(parsed);
  }

  /** @param {{path:string,mimeType:string,sha256:string,sourceId:string}} input */
  async parseText(input) {
    const extension = path.extname(input.path).toLowerCase();
    if (!String(input.mimeType).startsWith("text/") && !textExtensions.has(extension)) {
      throw parserError("source_parser_unavailable", "Structured document parsing is not configured.", 503);
    }
    const handle = await fsp.open(input.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > this.maxTextBytes) throw parserError("source_format_unsupported", "Text source is not a supported regular file.", 400);
      const value = await handle.readFile("utf8");
      const units = [];
      for (let offset = 0, index = 1; offset < value.length; offset += this.chunkChars, index += 1) {
        units.push({ id: `chunk-${index}`, unitType: "chunk", status: "extracted", itemIds: [] });
      }
      if (!units.length) units.push({ id: "chunk-1", unitType: "chunk", status: "no_content", itemIds: [] });
      const summary = value.replace(/\s+/g, " ").trim().slice(0, 500) || "The source contains no extractable text.";
      return validateResult({
        protocolVersion: 1,
        extractor: { name: "plain-text", version: "1.0.0", parser: "fallback" },
        units, summary, facts: [], methods: [], text: value || "No extractable text.",
      });
    } finally { await handle.close(); }
  }
}
