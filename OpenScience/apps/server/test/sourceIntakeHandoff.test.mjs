import assert from "node:assert/strict";
import test from "node:test";
import { createSourceIntakeHandoff, INTAKE_FOLDER, MAX_INTAKE_FILES } from "../src/sourceIntakeHandoff.mjs";
import { HttpError } from "../src/security.mjs";

// A run preserves a paper's supplements under .evimed-sources/ and asks for them
// to become knowledge-base sources. The hand-off takes the project from the
// runtime's identity, re-reads each file through the capture check, writes it
// where an upload would, and answers per file.

const identity = { userId: "alice", projectId: "paper-1" };
const digest = "a".repeat(64);
const preserved = (name) => `.evimed-sources/PMC6454835/supplements/${digest}/${name}`;

function harness(overrides = {}) {
  const log = { read: [], write: [] };
  const handOff = createSourceIntakeHandoff({
    context: async (who) => ({ user: { id: who.userId }, project: { id: who.projectId } }),
    read: async (project, relativePath) => { log.read.push([project.id, relativePath]); return { bytes: Buffer.from(`bytes of ${relativePath}`) }; },
    write: async (ctx, rel, bytes) => {
      log.write.push([ctx.user.id, ctx.project.id, rel, bytes.toString()]);
      return { source: { id: `src_${log.write.length}`, payload: { status: "queued" } }, duplicate: false };
    },
    ...overrides,
  });
  return { handOff, log };
}

test("a preserved file becomes a knowledge-base source at a path the control plane chooses", async () => {
  const { handOff, log } = harness();
  const answer = await handOff({ identity, group: "PMC6454835", files: [preserved("Data_Sheet_1.PDF"), preserved("Table_S1.xlsx")] });
  assert.deepEqual(answer.results.map((entry) => [entry.registered, entry.knowledgePath, entry.sourceId, entry.duplicate, entry.status]), [
    [true, `${INTAKE_FOLDER}/PMC6454835/Data_Sheet_1.PDF`, "src_1", false, "queued"],
    [true, `${INTAKE_FOLDER}/PMC6454835/Table_S1.xlsx`, "src_2", false, "queued"],
  ]);
  assert.deepEqual(log.read.map(([project]) => project), ["paper-1", "paper-1"], "the project is the token's");
  assert.deepEqual(log.write.map(([user, project]) => [user, project]), [["alice", "paper-1"], ["alice", "paper-1"]]);
  assert.equal(log.write[0][3], `bytes of ${preserved("Data_Sheet_1.PDF")}`, "the bytes written are the ones the capture check returned");
});

test("only a preserved source path can be handed over, and each refusal is that file's own answer", async () => {
  const { handOff, log } = harness();
  const answer = await handOff({
    identity, group: "PMC1",
    files: ["knowledge-base/other.pdf", ".evimed-sources/../secrets.txt", "/etc/passwd", ".evimed-sources//x", preserved("ok.csv")],
  });
  assert.deepEqual(answer.results.map((entry) => [entry.registered, entry.reason ?? null]), [
    [false, "source_intake_path_invalid"],
    [false, "source_intake_path_invalid"],
    [false, "source_intake_path_invalid"],
    [false, "source_intake_path_invalid"],
    [true, null],
  ]);
  assert.equal(log.read.length, 1, "a path outside .evimed-sources is never read");
});

test("a format the knowledge base cannot read is refused by name and the rest go on", async () => {
  const { handOff } = harness({
    write: async (_ctx, rel) => {
      if (rel.endsWith(".zip")) throw new HttpError(415, "source_format_unsupported", "This file format cannot be added to the knowledge base.");
      return { source: { id: "src_ok", payload: { status: "queued" } }, duplicate: true };
    },
  });
  const answer = await handOff({ identity, group: "PMC1", files: [preserved("all.zip"), preserved("table.xlsx")] });
  assert.deepEqual(answer.results.map((entry) => [entry.registered, entry.reason ?? null, entry.duplicate ?? null]), [
    [false, "source_format_unsupported", null],
    [true, null, true],
  ]);
});

test("a changed or missing capture is refused for that file with the capture check's own code", async () => {
  const { handOff } = harness({
    read: async (_project, relativePath) => {
      if (relativePath.endsWith("edited.csv")) throw new HttpError(409, "result_source_capture_changed", "Source bytes changed after preservation.");
      if (relativePath.endsWith("gone.csv")) throw new HttpError(404, "file_not_found", "File not found.");
      return { bytes: Buffer.from("fine") };
    },
  });
  const answer = await handOff({ identity, group: "PMC1", files: [preserved("edited.csv"), preserved("gone.csv"), preserved("fine.csv")] });
  assert.deepEqual(answer.results.map((entry) => [entry.registered, entry.reason ?? null]), [
    [false, "result_source_capture_changed"], [false, "file_not_found"], [true, null],
  ]);
});

test("a malformed hand-off is refused whole", async () => {
  const { handOff, log } = harness();
  for (const request of [
    { identity, group: "../up", files: [preserved("a.csv")] },
    { identity, group: "", files: [preserved("a.csv")] },
    { identity, group: "ok", files: [] },
    { identity, group: "ok", files: "not-a-list" },
    { identity, group: "ok", files: Array.from({ length: MAX_INTAKE_FILES + 1 }, (_, index) => preserved(`f${index}.csv`)) },
    { identity, group: "ok", files: [42] },
  ]) {
    await assert.rejects(() => handOff(request), (error) => error instanceof HttpError && error.status === 400);
  }
  assert.deepEqual(log, { read: [], write: [] });
});

test("the platform's own background projects have no library to hand files to", async () => {
  const { handOff, log } = harness();
  await assert.rejects(
    () => handOff({ identity: { userId: "alice", projectId: "evimed-sources" }, group: "g", files: [preserved("a.csv")] }),
    (error) => error instanceof HttpError && error.status === 404,
  );
  assert.deepEqual(log.write, []);
});

test("the same file named twice is handed over once", async () => {
  const { handOff, log } = harness();
  const answer = await handOff({ identity, group: "g", files: [preserved("a.csv"), preserved("a.csv")] });
  assert.equal(answer.results.length, 1);
  assert.equal(log.write.length, 1);
});
