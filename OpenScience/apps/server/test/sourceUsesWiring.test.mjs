// Built, tested and actually wired (the same reading of the composition root `learningComposition.test.mjs` takes): the uses
// of a document are recorded by the hook a finished run passes through, the route is given the store, and the page search is
// given the index. A unit test of the extractor cannot see any of these three come loose.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverSource = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");

test("the run-finish hook records a run's uses beside its transcript, and not for background work", () => {
  assert.match(serverSource, /import \{ SourceUses, nameConversations, recordSourceUsesOfRun \} from "\.\/sourceUses\.mjs";/);
  const transcript = serverSource.indexOf("const receipt = await persistRunTranscript(");
  const hook = serverSource.indexOf("await recordSourceUsesOfRun(", transcript);
  assert.ok(transcript > 0 && hook > transcript, "recorded after the transcript is written, from the same sessions");
  const call = serverSource.slice(hook, hook + 600);
  assert.match(call, /sessions/);
  assert.match(call, /skip: Boolean\(evaluationRun\) \|\| internalFor\(project\.userId, project\.id\)/);
  assert.match(call, /run\.source_uses\.record/, "a failure to record is audited, not swallowed");
});

test("the source routes are given the uses store and the index, and the app exposes the store", () => {
  const routes = serverSource.slice(serverSource.indexOf("const sourceRoutes = createSourceRoutes("), serverSource.indexOf("const knowledgeBaseUploads"));
  assert.match(routes, /uses: sourceUsesReader/);
  assert.match(routes, /passages: \{ find: \(request\) => kbIndex \? kbIndex\.passages\(request\) : Promise\.resolve\(null\) \}/);
  assert.match(serverSource, /const sourceUses = productDatabase && sourceService \? new SourceUses\(\{ database: productDatabase \}\) : null;/);
  assert.match(serverSource, /^    sourceUses,$/m);
});
