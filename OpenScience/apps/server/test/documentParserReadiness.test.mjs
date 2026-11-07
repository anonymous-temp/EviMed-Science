// The document parser's state as an operator reads it (2026-11-05): a gauge for whether the service is usable and why not,
// and a counter for what each parse came to — the service, the local reading that stood in for it, or a failure by code.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";

const METRICS_TOKEN = "metrics-token-for-parser-readiness";

test("a refused key is the usable gauge's cause and does not fail readiness", async (t) => {
  const parser = createServer((request, response) => {
    request.resume();
    response.writeHead(request.url === "/health" ? 200 : 401, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: 200, message: "m", uuid: "u", timestamp: 1, elapsed_ms: 1, data: request.url === "/health" ? { status: "healthy" } : { error_code: "invalid_api_key" } }));
  });
  await new Promise((resolve) => parser.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => parser.close(resolve)));
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-parser-ready-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, operatorMetricsToken: METRICS_TOKEN,
    requireDocumentParser: true, documentParserUrl: `http://127.0.0.1:${parser.address().port}`, documentParserToken: "sk-test-only",
    // The intake container is not here; the controller answers the way a deployment without one does.
    vcrIntakeController: { runVcrIntake: async () => { throw Object.assign(new Error("no controller"), { code: "runtime_controller_unavailable" }); } } });
  const address = await app.listen(0, "127.0.0.1");
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const metrics = async () => (await fetch(`http://127.0.0.1:${address.port}/api/ops/metrics`, { headers: { Authorization: `Bearer ${METRICS_TOKEN}` } })).text();

  const text = await metrics();
  assert.match(text, /^open_science_document_parser_usable\{engine="engine-a",code="source_parser_auth_failed"\} 0$/m);
  assert.match(text, /^open_science_readiness_check\{check="documentParser",code="ok"\} 1$/m, "the platform stays ready");
  assert.equal(text.includes("sk-test-only"), false);
});
