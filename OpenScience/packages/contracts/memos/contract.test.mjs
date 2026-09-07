import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { MemOsClient, memOsNamespace } from "../../../apps/server/src/memOsEngineClient.mjs";
import { addResponse, createCubeResponse, deleteResponse, exampleRecord, feedbackResponse, healthResponse, searchResponse } from "./fixtures/wire.mjs";

const readJson = async path => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const versions = await readJson("../../../deps-version.json");
const openapi = await readJson("./fixtures/openapi.json");
const provenance = await readJson("./fixtures/provenance.json");

// Validate emitted bodies against the observed request schemas, not guessed routes.
// Only the OpenAPI subset used by these requests is interpreted here.
function schemaMatches(value, schema) {
  if (schema.$ref) return schemaMatches(value, openapi.components.schemas[schema.$ref.split("/").at(-1)]);
  if (schema.anyOf) return schema.anyOf.some(branch => schemaMatches(value, branch));
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === "null") return value === null;
  if (schema.type === "array") return Array.isArray(value) && value.every(item => schemaMatches(item, schema.items));
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    if (schema.required?.some(key => !(key in value))) return false;
    return Object.entries(value).every(([key, item]) => schema.properties?.[key]
      ? schemaMatches(item, schema.properties[key]) : schema.additionalProperties === true);
  }
  if (schema.type === "integer") return Number.isInteger(value) && (schema.minimum === undefined || value >= schema.minimum);
  if (schema.type) return typeof value === schema.type;
  return true;
}

test("MemTensor pin and captured source identity agree", () => {
  assert.equal(versions.memos.version, provenance.dependencyVersion);
  assert.equal(versions.memos.githubRepo, "MemTensor/MemOS");
  assert.equal(versions.memos.contractDir, "packages/contracts/memos");
  assert.equal(versions.memos.tokenizer, "gpt2");
  assert.match(versions.memos.tokenizerRevision, /^[a-f0-9]{40}$/);
  assert.match(provenance.sourceCommit, /^[0-9a-f]{40}$/);
  assert.equal(openapi.info.title, "MemOS Server REST APIs");
  assert.equal(openapi.info.version, "1.0.1");
  assert.equal(openapi.components.securitySchemes, undefined);
  // Every path is either captured from the running server or declared as
  // derived from the pinned source, and there is no third way to be in here.
  // Without this, a path added by hand reads exactly like a captured one.
  for (const path of Object.keys(openapi.paths)) {
    if (provenance.derivedEndpoints.paths.includes(path)) continue;
    assert.ok(provenance.openapiEvidence.startsWith("Read-only /openapi.json"), path);
  }
  assert.match(provenance.derivedEndpoints.method, /pinned revision's own Pydantic models/);
  assert.match(provenance.derivedEndpoints.equivalenceCheck, /byte-identical/);
  for (const file of Object.keys(provenance.runtimeSourceHashes)) {
    assert.ok(provenance.sourceFiles.includes(file), `${file} is hashed but not listed as read`);
  }
});

test("real adapter serialization and normalization satisfy the observed MemOS contract", async t => {
  const accountCreatedAt = "2026-09-06 00:00:00+00";
  const options = { accountCreatedAt, projectId: "contract-project" };
  const scope = memOsNamespace("contract-account", accountCreatedAt, "contract-project");
  const calls = [];
  let taskId;
  let deleted = false;
  let requestFailure;
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      calls.push(path);
      const operation = openapi.paths[path]?.[req.method.toLowerCase()];
      assert.ok(operation, `Unverified endpoint: ${req.method} ${path}`);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (chunks.length) {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        assert.ok(schemaMatches(body, operation.requestBody.content["application/json"].schema), "Body differs from observed OpenAPI");
        if (path === "/product/add") taskId = body.task_id;
      }
      if (path === "/product/delete_memory") deleted = true;
      // A table rather than a ternary chain: with eight endpoints the chain was
      // already unreadable, and the assertion at the end of this test is that
      // every path in the captured spec appears here exactly once.
      const responses = {
        "/health": () => healthResponse,
        "/product/create_cube": () => createCubeResponse(scope.userId, scope.cubeId),
        "/product/add": () => addResponse(scope.cubeId),
        "/product/search": () => searchResponse(scope.userId, scope.cubeId),
        "/product/get_memory": () => {
          const response = searchResponse(scope.userId, scope.cubeId, { total: deleted ? 0 : 1 });
          if (deleted) response.data.text_mem[0].memories = [];
          return response;
        },
        "/product/feedback": () => feedbackResponse,
        "/product/scheduler/status": () => ({ code: 200, message: "Memory get status successfully", data: [{ task_id: taskId, status: "waiting" }] }),
        "/product/delete_memory": () => deleteResponse,
      };
      const result = responses[path]();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      requestFailure = error;
      res.writeHead(500); res.end();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new MemOsClient({ memOsBaseUrl: `http://127.0.0.1:${server.address().port}` });
  await client.health();
  // Before the first write, because that is the order the substrate migration
  // will have to use: `add` materializes a cube it has never seen today, and
  // nothing upstream promises it will keep doing so.
  assert.equal((await client.createCube("contract-account", options)).cubeId, scope.cubeId);
  const added = await client.add("contract-account", [exampleRecord], options);
  assert.equal(added.records[0].entryId, exampleRecord.entryId);
  assert.equal((await client.search("contract-account", "methods", options))[0].entryId, exampleRecord.entryId);
  assert.equal((await client.export("contract-account", options)).complete, true);
  assert.equal((await client.getTaskStatus("contract-account", added.records[0].taskId, options)).status, "waiting");
  // The return path of the recall loop: what a person decided about what was
  // recalled. Async upstream, so the receipt is a task id and nothing more.
  assert.equal((await client.feedback("contract-account", {
    history: [{ role: "user", content: "只看随机对照试验" }, { role: "assistant", content: "已按此检索。" }],
    feedbackContent: "这条记忆已经过时，请不要再召回。",
    retrievedMemoryIds: ["memory-one"],
  }, options)).status, "accepted");
  await client.deleteRecord("contract-account", "memory-one", options);
  assert.equal(requestFailure, undefined);
  assert.deepEqual(new Set(calls), new Set(Object.keys(openapi.paths)));
});
