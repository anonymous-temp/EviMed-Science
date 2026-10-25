// The write-quality runner's replay of a repeated choice (c22, e3b, e3c) against a stub engine that behaves as the observations template asks:
// the notes are the engine's, the counting is the control plane's (`nativeMemoryObservations.mjs`), and no check of the corpus sees a note.
// The real runner runs as a child process, as the controller runs it on a lab engine; the stub stands in for the engine and its model.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startOpenVikingStub } from "./helpers/openVikingStub.mjs";

const runner = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../evals/memory-write-quality/run_native_eval.mjs");

/** What the template asks of an engine: a note per choice, a line for every conversation that shows it; a preference for an explicit request. */
function templateEngine({ user, session, messages, files }) {
  const root = `viking://user/${user}/memories`;
  const said = messages.filter((message) => message.role === "user").map((message) => message.parts.map((part) => part.text).join("")).join("\n");
  if (session.startsWith("evimed-promote-")) return { adds: [{ uri: `${root}/preferences/self/预算表.md`, memory_type: "preferences", after: "- 预算类表格一律带透视表。" }] };
  const note = (name, line) => {
    const uri = `${root}/observations/${name}.md`;
    const held = files.get(uri);
    return held === undefined ? { adds: [{ uri, memory_type: "observations", after: `- ${line}` }] } : { updates: [{ uri, memory_type: "observations", before: held, after: `${held}\n- ${line}` }] };
  };
  if (/折线图/.test(said)) return note("月度汇总-折线图", "月度汇总：折线图，不要表格");
  if (/透视表/.test(said)) return note("预算类表格-透视表", "预算类表格：带透视表");
  return {};
}

async function replay(t, only) {
  const stub = await startOpenVikingStub(t, { extract: templateEngine });
  const dir = await mkdtemp("/tmp/evimed-wq-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, "root.key");
  await writeFile(keyFile, stub.apiKey, { mode: 0o600 });
  const child = spawn(process.execPath, [runner, "--url", stub.url, "--key-file", keyFile, "--only", only, "--wait-ms", "20000"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });
  const code = await new Promise((resolve) => child.on("close", resolve));
  const rows = out.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  return { code, rows, out };
}

test("a choice two conversations made is a preference, a choice one conversation made twice is nothing, two different choices are nothing; no note is scored", { timeout: 120_000 }, async (t) => {
  const { code, rows, out } = await replay(t, "c22,e3b,e3c");
  assert.equal(code, 0, out);
  const verdicts = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(verdicts["c22-repeated-demonstration"].verdict, "pass", JSON.stringify(verdicts["c22-repeated-demonstration"]));
  assert.deepEqual(verdicts["c22-repeated-demonstration"].observations, { files: 0, lines: 0, promoted: 1 }, "the note was spent in the promotion");
  assert.ok(verdicts["c22-repeated-demonstration"].counts.preference >= 1);
  // One conversation, two requests: a note and no preference; the note is not a memory, so the corpus sees nothing.
  assert.equal(verdicts["e3b-one-conversation-alone"].verdict, "pass", JSON.stringify(verdicts["e3b-one-conversation-alone"]));
  assert.deepEqual([verdicts["e3b-one-conversation-alone"].observations.files, verdicts["e3b-one-conversation-alone"].observations.promoted], [1, 0]);
  assert.equal(verdicts["e3b-one-conversation-alone"].operations, 0, "a note is no operation");
  // Two different choices in two conversations: two notes, nothing promoted.
  assert.equal(verdicts["e3c-different-choices-in-two-conversations"].verdict, "pass", JSON.stringify(verdicts["e3c-different-choices-in-two-conversations"]));
  assert.deepEqual([verdicts["e3c-different-choices-in-two-conversations"].observations.files, verdicts["e3c-different-choices-in-two-conversations"].observations.promoted], [2, 0]);
});
