import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { appendStatus, formatStatusLine, oneLineFacts, openStatus, parseStatusLine, readDone, readStatus, validStepKey } from "../run/status.mjs";

async function scratch(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "run-status-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "STATUS");
}

test("a STATUS line is ISO time, state, one-token key and one line of facts, and parses back", () => {
  const at = new Date("2026-03-07T02:53:48.000Z");
  const line = formatStatusLine("DONE", "C01/ingest/s001", "ops=+1~0-0\nsecond line", at);
  assert.equal(line, "2026-03-07T02:53:48.000Z DONE C01/ingest/s001 ops=+1~0-0 second line\n");
  assert.deepEqual(parseStatusLine(line.trimEnd()), { at: "2026-03-07T02:53:48.000Z", state: "DONE", stepKey: "C01/ingest/s001", facts: "ops=+1~0-0 second line" });
  assert.deepEqual(parseStatusLine("2026-03-07T02:53:48.000Z FAIL C01/answer/q1"), { at: "2026-03-07T02:53:48.000Z", state: "FAIL", stepKey: "C01/answer/q1", facts: "" });
  assert.equal(parseStatusLine("not a status line"), null);
  assert.equal(parseStatusLine("2026-03-07T02:53:48.000Z SKIP key"), null);
  assert.throws(() => formatStatusLine("DONE", "two words"), /one token/);
  assert.throws(() => formatStatusLine(/** @type {any} */ ("OK"), "key"), /unknown STATUS state/);
  assert.equal(validStepKey("a/b/c"), true);
  assert.equal(validStepKey(""), false);
  assert.equal(oneLineFacts({ files: 2 }), '{"files":2}');
  assert.equal(oneLineFacts("x".repeat(500)).length, 400);
});

test("only DONE keys count as done; a DONE after a FAIL counts, a missing file is empty", async (t) => {
  const file = await scratch(t);
  assert.deepEqual(await readStatus(file), []);
  assert.equal((await readDone(file)).size, 0);
  await appendStatus(file, "FAIL", "C01/ingest/s002", "timeout");
  await appendStatus(file, "DONE", "C01/ingest/s001", "ok");
  await appendStatus(file, "DONE", "C01/ingest/s002", "ok on retry");
  await appendStatus(file, "FAIL", "C01/answer/q9", "http_500");
  assert.deepEqual([...await readDone(file)].sort(), ["C01/ingest/s001", "C01/ingest/s002"]);
  assert.equal((await readStatus(file)).length, 4);
});

test("concurrent appends from many cases never interleave partial lines", async (t) => {
  const file = await scratch(t);
  await Promise.all(Array.from({ length: 60 }, (_, index) => appendStatus(file, index % 3 ? "DONE" : "FAIL", `C${index % 4}/step/${index}`, `facts ${"z".repeat(index * 3)}`)));
  const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
  assert.equal(lines.length, 60);
  assert.ok(lines.every((line) => parseStatusLine(line) !== null));
  assert.equal((await readDone(file)).size, 40);
});

test("openStatus keeps its done set current with its own appends and ignores junk lines", async (t) => {
  const file = await scratch(t);
  await writeFile(file, "garbage\n2026-03-07T02:53:48.000Z DONE C02/snapshot/5 files=3\n");
  const status = await openStatus(file);
  assert.equal(status.isDone("C02/snapshot/5"), true);
  assert.equal(status.isDone("C02/ingest/s006"), false);
  await status.markDone("C02/ingest/s006", "ok");
  await status.markFailed("C02/answer/q1", "error");
  assert.equal(status.isDone("C02/ingest/s006"), true);
  assert.equal(status.isDone("C02/answer/q1"), false);
  assert.deepEqual([...await readDone(file)].sort(), ["C02/ingest/s006", "C02/snapshot/5"]);
});
