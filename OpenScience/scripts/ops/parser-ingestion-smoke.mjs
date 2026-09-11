#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../../apps/server/src/config.mjs";
import { DocumentParserClient } from "../../apps/server/src/documentParserClient.mjs";
import { removeSourceCopies, sourceAttemptId, stageParserInput } from "../../apps/server/src/sourceFiles.mjs";

export const PARSER_SMOKE_TEXT = "Evidence parser ingestion fixture. Group-only handoff verified.";

/** Keep the smoke's total deadline active through HTTP response-body reads. */
export function parserSmokeFetch(signal) {
  return (url, options = {}) => fetch(url, { ...options,
    signal: AbortSignal.any([signal, ...(options.signal ? [options.signal] : [])]) });
}

/** A real one-page PDF with standard embedded PDF text operators; no fixture download. */
export function parserSmokePdf() {
  const stream = `BT /F1 14 Tf 72 720 Td (${PARSER_SMOKE_TEXT}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function main() {
  const config = loadConfig();
  assert.ok(config.documentParserUrl && config.documentParserToken && !config.documentParserTokenError,
    "Parser service and private credential must be configured.");
  assert.equal(process.getuid(), 0);
  const posture = await fs.readFile("/proc/self/status", "utf8");
  assert.match(posture, /CapEff:\s+0+\n/);
  assert.match(posture, /CapBnd:\s+0+\n/);
  assert.match(posture, /NoNewPrivs:\s+1/);
  const jobId = `parser-smoke-${randomUUID()}`;
  const attemptId = sourceAttemptId({ leaseToken: randomUUID() });
  const relative = `${jobId}-${attemptId}/fixture.pdf`;
  const bytes = parserSmokePdf();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const sourceId = `src_${sha256.slice(0, 32)}`;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 175000);
  const terminate = () => deadline.abort();
  process.once("SIGTERM", terminate);
  const boundedFetch = parserSmokeFetch(deadline.signal);
  let staged = false;
  try {
    console.log(JSON.stringify({ stage: "private_file_handoff", sourceSha256: sha256, bytes: bytes.length }));
    const file = await stageParserInput({ stagingRoot: config.documentParserStagingDir, relative, bytes, parserGid: config.documentParserGid });
    staged = true;
    assert.equal(createHash("sha256").update(await fs.readFile(file)).digest("hex"), sha256);
    const request = { path: `/data/${relative}`, mimeType: "application/pdf", sha256, sourceId };
    const endpoint = `${config.documentParserUrl}/v1/parse`;
    for (const [token, hash, expected] of [["", sha256, 401], [config.documentParserToken, "0".repeat(64), 400]]) {
      const response = await boundedFetch(endpoint, { method: "POST", signal: AbortSignal.timeout(5000),
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ ...request, sha256: hash }) });
      await response.body?.cancel();
      assert.equal(response.status, expected, "Parser authentication/source-hash refusal failed.");
    }
    console.log(JSON.stringify({ stage: "authenticated_mineru_pdf_parse", sourceSha256: sha256 }));
    // Unlike the client's header timer, this signal remains live while the
    // response body is read. SIGTERM also reaches finally and removes the input.
    const parser = new DocumentParserClient({ baseUrl: config.documentParserUrl, token: config.documentParserToken,
      timeoutMs: 170000, fetchImpl: boundedFetch });
    const result = await parser.parse(request);
    assert.deepEqual(result.extractor, { name: "mineru", version: "3.4.5", parser: "mineru" });
    assert.ok(result.text.replace(/\s+/g, " ").includes(PARSER_SMOKE_TEXT), "MinerU omitted the known PDF text.");
    assert.equal(result.units.length, 1);
    assert.equal(result.units[0].unitType, "page");
    assert.equal(result.units[0].status, "extracted");
    assert.ok(result.units[0].itemIds.length > 0);
    console.log(JSON.stringify({ stage: "parser_ingestion_verified", sourceSha256: sha256, pages: 1, parser: "mineru", version: "3.4.5" }));
  } finally {
    try {
      if (staged) await removeSourceCopies({ projectRoot: config.dataDir, sourceId, jobIds: [jobId], generation: 1,
        attemptId, stagingOnly: true, parserStagingRoot: config.documentParserStagingDir });
    } finally {
      clearTimeout(timer);
      process.removeListener("SIGTERM", terminate);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const code = typeof error?.code === "string" && /^[a-z_]{1,80}$/.test(error.code) ? error.code : "parser_ingestion_smoke_failed";
    console.error(JSON.stringify({ code }));
    process.exitCode = 1;
  });
}
