// What a memory never holds is one text (`@evimed/domain`'s MEMORY_NEVER_KEPT_TEXT), read by both extractors: the native engine
// through its eight type templates and the legacy extraction through its instruction. A rule edited in one place only is how the
// two came to disagree about the assistant's own words (2026-10-14); this holds them to the same sentence.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MEMORY_NEVER_KEPT_TEXT } from "@evimed/domain";
import { renderMemoryTemplates } from "../../../deploy/web/openviking/memory-templates-src/build.mjs";
import { MemoryIntelligence } from "../src/memoryIntelligence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("the engine's eight templates carry the never-kept text, line for line, as the deployed files and as rendered", async () => {
  const indented = MEMORY_NEVER_KEPT_TEXT.trimEnd().split("\n").map((line, index) => (index === 0 ? line : `  ${line}`)).join("\n");
  const directory = path.join(root, "deploy/web/openviking/memory-templates");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".yaml"));
  assert.equal(files.length, 8);
  const rendered = renderMemoryTemplates();
  for (const name of files) {
    assert.ok((await readFile(path.join(directory, name), "utf8")).includes(indented), `${name} does not state the never-kept text`);
    assert.ok(rendered[name].includes(indented), `${name} is not rendered with the never-kept text`);
  }
});

test("the legacy extraction states the same text, and it names what an assistant or a dispatch said", async () => {
  let system = "";
  const intelligence = new MemoryIntelligence({ deepseekProviderEnabled: true, deepseekApiKey: "unit-test-key", deepseekBaseUrl: "https://api.deepseek.com",
    deepseekModel: "deepseek-v4-pro", memoryExtractionEnabled: true, memoryExtractionTimeoutMs: 1_000 }, {
    configured: false,
    async listRecords() { return []; },
    async upsertRecord(_user, input) { return { ...input, id: input.key, version: 1, revisions: [], evidence: [], evidenceCount: 0 }; },
    async getRecord() { throw Object.assign(new Error("not found"), { code: "memory_not_found" }); },
  }, {
    fetchImpl: async (_input, init) => {
      system = JSON.parse(String(init.body)).messages[0].content;
      return Response.json({ choices: [{ message: { content: JSON.stringify({ candidates: [] }) } }] });
    },
  });
  await intelligence.recordRun({ id: "p1", userId: "u1" }, { id: "run_1", sessionId: "s1", status: "succeeded", finishedAt: "2026-10-14T00:00:00.000Z" },
    [{ info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "我是后端工程师，主要写 Go。" }] }]);
  assert.ok(system.includes(MEMORY_NEVER_KEPT_TEXT), "the legacy instruction does not state the never-kept text");
  // The sentence the legacy extraction lacked until 2026-10-14, and the engine's templates always had.
  assert.match(MEMORY_NEVER_KEPT_TEXT, /Anything the assistant proposed, floated, summarised or inferred that the user did not themselves state or confirm in a user-role message/);
  assert.match(system, /Both must cite a message the person wrote themselves/);
});
