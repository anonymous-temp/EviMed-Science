#!/usr/bin/env node
// Run the platform's own document-parser client (apps/server/src/documentParserClient.mjs) on each PDF and keep the text it returns.
//
//   OPEN_SCIENCE_DOCUMENT_PARSER_URL=<base url> node run_inhouse_parser.mjs <pdf-dir> <out-dir> [pmcid ...]
//
// The client is configured the way the server configures it (config.mjs): a base URL and, when the deployment has one, a token file
// (OPEN_SCIENCE_DOCUMENT_PARSER_TOKEN_FILE). Nothing here reads, prints or stores a token. A failure is written down as it is (the
// HTTP status and the client's error code), never retried beyond the client's own retry, and the run goes on to the next file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DocumentParserClient } from '../../apps/server/src/documentParserClient.mjs';

const [pdfDir, outDir, ...only] = process.argv.slice(2);
if (!pdfDir || !outDir) { console.error('usage: run_inhouse_parser.mjs <pdf-dir> <out-dir> [pmcid ...]'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const tokenFile = process.env.OPEN_SCIENCE_DOCUMENT_PARSER_TOKEN_FILE;
const token = tokenFile && fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
const client = new DocumentParserClient({ baseUrl: process.env.OPEN_SCIENCE_DOCUMENT_PARSER_URL ?? '', token, timeoutMs: Number(process.env.OPEN_SCIENCE_DOCUMENT_PARSER_TIMEOUT_MS ?? 300000) });
if (!client.configured) { console.error('OPEN_SCIENCE_DOCUMENT_PARSER_URL is not set'); process.exit(2); }

const files = fs.readdirSync(pdfDir).filter((name) => name.endsWith('.pdf') && (!only.length || only.includes(name.replace(/\.pdf$/, '')))).sort();
const report = [];
for (const name of files) {
  const id = name.replace(/\.pdf$/, '');
  const file = path.join(pdfDir, name);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const started = Date.now();
  try {
    const result = await client.parse({ path: file, mimeType: 'application/pdf', sha256 });
    fs.writeFileSync(path.join(outDir, `${id}.txt`), result.text ?? '');
    report.push({ id, ok: true, chars: (result.text ?? '').length, seconds: (Date.now() - started) / 1000, extractor: result.extractor ?? null });
    console.error(`${id} ok ${(result.text ?? '').length} chars ${(Date.now() - started) / 1000}s`);
  } catch (error) {
    report.push({ id, ok: false, status: error?.status ?? null, code: error?.code ?? null, message: String(error?.message ?? '').slice(0, 200), seconds: (Date.now() - started) / 1000 });
    console.error(`${id} FAILED ${error?.status ?? ''} ${error?.code ?? ''}`);
  }
}
fs.writeFileSync(path.join(outDir, '_report.json'), JSON.stringify(report, null, 1));
