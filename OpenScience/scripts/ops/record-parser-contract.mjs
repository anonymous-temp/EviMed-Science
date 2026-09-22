#!/usr/bin/env node
/**
 * Record the in-house parsing API's contract fixtures off the live service.
 *
 * Hidden knowledge: why this is a script and not a hand-written fixture. A
 * fixture written from documentation inherits the documentation's errors and
 * then certifies them; the deployed test build already disagrees with its own
 * docs about error envelopes (`data: null`, no `error_code`). So every sample
 * the contract test replays is a verbatim answer from the server, recorded here.
 *
 * Without a key it records the two answers that need none (health and the
 * missing-file refusal). With a key it also records a success from both
 * endpoints and the 415, 422 and 401 refusals. The deployed service has
 * answered without any key since at least 2026-09-22, so a keyless success is
 * the normal case in production; the key path stays for a server that turns
 * authentication on.
 *
 * The key is read from the file `OPEN_SCIENCE_DOCUMENT_PARSER_TOKEN_FILE` names
 * and never printed, logged or written: a recording that contains it is refused
 * before anything reaches the fixtures directory.
 *
 *   OPEN_SCIENCE_DOCUMENT_PARSER_TOKEN_FILE=/path/to/key \
 *   node scripts/ops/record-parser-contract.mjs [--url http://host:port] [--out <dir>]
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const defaultOut = path.join(repoRoot, "packages/contracts/evimed-extract/fixtures");
/** The response headers the client reads, and nothing else a server says. */
const RECORDED_HEADERS = Object.freeze(["content-type", "retry-after", "www-authenticate", "x-quota-unit", "x-quota-cost", "x-quota-remaining"]);
export const SAMPLE_TEXT = "EviMed parser contract sample: rivaroxaban 15 mg once daily.";

/** A one-page PDF with a real text layer and a valid cross-reference table,
 *  the same every time, so two recordings differ only where the service did. */
export function contractSamplePdf() {
  const stream = `BT /F1 12 Tf 72 720 Td (${SAMPLE_TEXT}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

/** @param {Headers} headers */
export function selectedHeaders(headers) {
  return Object.fromEntries(RECORDED_HEADERS.filter((name) => headers.get(name) != null).map((name) => [name, headers.get(name)]));
}

/** Refuse a recording that carries the key anywhere. @param {string} secret @param {...(string|Buffer)} parts */
export function assertNoSecret(secret, ...parts) {
  if (!secret) return;
  for (const part of parts) {
    if (Buffer.from(part).includes(Buffer.from(secret))) throw new Error("a recorded answer contains the key; nothing was written");
  }
}

/**
 * Record against `baseUrl`, write verbatim bodies into `outDir`, and update
 * `provenance.json` there. Returns what was recorded, without the key.
 * @param {{ baseUrl: string, token?: string, outDir?: string, fetchImpl?: typeof fetch, now?: () => Date }} options
 */
export async function recordParserContract({ baseUrl, token = "", outDir = defaultOut, fetchImpl = fetch, now = () => new Date() }) {
  const base = String(baseUrl).replace(/\/+$/, "");
  const pdf = contractSamplePdf();
  const sha256 = createHash("sha256").update(pdf).digest("hex");
  /** @param {{ checksum?: string, format?: string, file?: boolean }} fields */
  const form = ({ checksum = sha256, format = "pdf", file = true } = {}) => {
    const body = new FormData();
    if (file) body.append("file", new Blob([pdf], { type: "application/pdf" }), "sample.pdf");
    body.append("checksum", checksum);
    body.append("filename", format === "pdf" ? "sample.pdf" : `sample.${format}`);
    body.append("format", format);
    return body;
  };
  const samples = [
    { name: "health.json", request: "GET /health (no credential; the one route that takes none)", method: "GET", route: "/health" },
    { name: "extract-missing-file.json", request: "POST /api/v1/extract/text/file, multipart with checksum only (no file part), no Authorization header",
      method: "POST", route: "/api/v1/extract/text/file", body: () => form({ file: false }) },
  ];
  if (token) {
    samples.push(
      { name: "extract-success.json", request: "POST /api/v1/extract/text/file, the one-page sample PDF, valid key", method: "POST",
        route: "/api/v1/extract/text/file", body: () => form(), key: token },
      { name: "parse-success.json", request: "POST /api/v1/parse/file, the one-page sample PDF, valid key", method: "POST",
        route: "/api/v1/parse/file", body: () => form(), key: token },
      { name: "extract-unsupported-format.json", request: "POST /api/v1/extract/text/file, format=exe, valid key", method: "POST",
        route: "/api/v1/extract/text/file", body: () => form({ format: "exe" }), key: token },
      { name: "extract-checksum-failed.json", request: "POST /api/v1/extract/text/file, a checksum that is not the file's, valid key", method: "POST",
        route: "/api/v1/extract/text/file", body: () => form({ checksum: "0".repeat(64) }), key: token },
      { name: "extract-unauthorized.json", request: "POST /api/v1/extract/text/file, the sample PDF, a key the service never issued", method: "POST",
        route: "/api/v1/extract/text/file", body: () => form(), key: "sk-fake-key-the-service-never-issued" },
    );
  }
  const recorded = [];
  for (const sample of samples) {
    const response = await fetchImpl(`${base}${sample.route}`, {
      method: sample.method,
      headers: sample.key ? { authorization: `Bearer ${sample.key}` } : {},
      ...(sample.body ? { body: sample.body() } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(300_000),
    });
    const body = Buffer.from(await response.arrayBuffer());
    const headers = selectedHeaders(response.headers);
    assertNoSecret(token, body, JSON.stringify(headers));
    recorded.push({ name: sample.name, request: sample.request, status: response.status, headers, body });
  }
  const provenancePath = path.join(outDir, "provenance.json");
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  for (const sample of recorded) {
    await writeFile(path.join(outDir, sample.name), sample.body);
    provenance.fixtures[sample.name] = { request: sample.request, status: sample.status, headers: sample.headers };
  }
  provenance.observedAt = now().toISOString();
  provenance.server = base;
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  return recorded.map(({ name, status }) => ({ name, status }));
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const deps = JSON.parse(await readFile(path.join(repoRoot, "deps-version.json"), "utf8"));
  const baseUrl = argument("url") ?? process.env.OPEN_SCIENCE_DOCUMENT_PARSER_URL ?? deps["evimed-extract"]?.testServer;
  const keyFile = process.env.OPEN_SCIENCE_DOCUMENT_PARSER_TOKEN_FILE ?? "";
  let token = "";
  if (keyFile) {
    // Owner-only, like every other secret file this platform reads.
    const stat = fs.statSync(keyFile);
    if ((stat.mode & 0o077) !== 0) throw new Error("the key file must be owner-only (0600 or 0400)");
    token = fs.readFileSync(keyFile, "utf8").replace(/\r?\n$/, "");
  }
  const recorded = await recordParserContract({ baseUrl, token, outDir: argument("out") ?? defaultOut });
  for (const row of recorded) process.stdout.write(`${JSON.stringify(row)}\n`);
  if (!token) process.stdout.write(`${JSON.stringify({ note: "no key file named: recorded only the answers that need none" })}\n`);
}
