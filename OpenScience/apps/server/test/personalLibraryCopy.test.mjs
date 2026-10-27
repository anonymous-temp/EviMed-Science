// 「添加到项目」 (POST /api/library/:sourceId/projects), against doubles: where a copy may go, what a missing original is
// answered with, and which selections are still current when the platform's own reading has moved the record since. The
// real-database paths (freezing, A-B-A, repeat copies) are in personalLibrary.integration.test.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import { LIBRARY_PROJECT_ID } from "../src/internalProjects.mjs";
import { createPersonalLibraryRoutes } from "../src/personalLibraryIntake.mjs";

const BYTES = Buffer.from("preserved original");
const SHA = createHash("sha256").update(BYTES).digest("hex");
const SOURCE_ID = `src_${"a".repeat(32)}`;
const user = { id: "u1" };

const sourceRecord = (revision, payload = {}) => ({
  id: SOURCE_ID, projectId: LIBRARY_PROJECT_ID, revision, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z", deletedAt: null,
  payload: { paths: ["knowledge-base/uploads/a.txt"], logicalPath: "knowledge-base/uploads/a.txt", fingerprint: { sha256: SHA }, version: 1, generation: 1,
    publication: { current: true }, status: "complete", docType: "document", ...payload },
});

/** The route over doubles. `history` is the source's recorded revisions; `current` is the record as it is now. */
function fixture({ current = sourceRecord(7), history = [], readFile = async () => BYTES, moduleProject = async () => false } = {}) {
  const calls = { write: [], put: [] };
  const sources = {
    get: async () => current,
    lockSourceMutation: async () => {},
    withRegistrationLocks: async (_keys, work) => work(),
    documents: {
      history: async (_userId, _kind, _id, { beforeRevision, limit }) => history.filter((row) => row.revision < beforeRevision).sort((a, b) => b.revision - a.revision).slice(0, limit),
      put: async (_userId, _kind, id, payload, { projectId }) => { calls.put.push({ id, projectId }); return { id, projectId, revision: 2, payload, createdAt: current.createdAt, updatedAt: current.updatedAt, deletedAt: null }; },
    },
  };
  const route = createPersonalLibraryRoutes({
    store: { ensureSessionUser: async () => ({ user }), assertCsrf: async () => {}, requireProject: async (_user, id) => ({ id, name: id }) },
    sources, knowledge: {}, maxJsonBytes: 4096, maxFileBytes: 1 << 20, moduleProject, readFile,
    write: async (request) => {
      calls.write.push(request);
      return { source: { id: `src_${"b".repeat(32)}`, projectId: request.project.id, revision: 1, createdAt: current.createdAt, updatedAt: current.updatedAt, deletedAt: null,
        payload: { paths: [request.rel], status: "queued", fingerprint: { sha256: SHA }, version: 1 } }, duplicate: false, job: {} };
    },
  });
  const copy = async (body) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { url: `/api/library/${SOURCE_ID}/projects`, method: "POST", headers: {} });
    const res = { status: 0, body: "", writeHead(status) { this.status = status; }, end(text) { this.body = text; } };
    assert.equal(await route(req, res), true);
    return res;
  };
  return { copy, calls };
}

test("a copy goes to an ordinary project: an owned 循证 GEO project or 虚拟临床研究 study is refused, and nothing is written", async () => {
  const held = fixture({ moduleProject: async (_user, id) => id === "geo-1" || id === "study-1" });
  for (const projectId of ["geo-1", "study-1"]) {
    await assert.rejects(held.copy({ projectId, expectedRevision: 7 }), { status: 400, code: "library_payload_invalid" });
  }
  assert.equal(held.calls.write.length, 0);
  const done = await held.copy({ projectId: "p1", expectedRevision: 7 });
  assert.equal(done.status, 201);
  assert.equal(held.calls.write.length, 1);
  assert.equal(held.calls.write[0].project.id, "p1");
});

test("an original that is no longer on disk is a named 404, not a server error; any other read failure is still one", async () => {
  for (const code of ["ENOENT", "ENOTDIR"]) {
    const gone = fixture({ readFile: async () => { throw Object.assign(new Error(`${code}: no such file`), { code }); } });
    await assert.rejects(gone.copy({ projectId: "p1", expectedRevision: 7 }), { status: 404, code: "library_original_missing" });
    assert.equal(gone.calls.write.length, 0);
  }
  const broken = fixture({ readFile: async () => { throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" }); } });
  await assert.rejects(broken.copy({ projectId: "p1", expectedRevision: 7 }), { code: "EIO" });
});

test("the platform's own reading moves a record's revision, not the version a person chose: the click is still current, and the snapshot is named by the version", async () => {
  // Chosen at revision 3 (the row the list held); parsing and understanding have since taken the record to 7. Same bytes, same version.
  const moved = fixture({ history: [{ revision: 3, payload: { fingerprint: { sha256: SHA }, version: 1, publication: { current: true } } }] });
  const first = await moved.copy({ projectId: "p1", expectedRevision: 3 });
  assert.equal(first.status, 201);
  const again = fixture({ current: sourceRecord(9), history: [{ revision: 3, payload: { fingerprint: { sha256: SHA }, version: 1, publication: { current: true } } }] });
  await again.copy({ projectId: "p1", expectedRevision: 3 });
  assert.equal(moved.calls.write[0].rel, again.calls.write[0].rel, "the same version copied twice names one snapshot, whatever the record's revision was");
  assert.match(moved.calls.write[0].rel, new RegExp(`^knowledge-base/imports/${SOURCE_ID}/v1-${SHA}/a\\.txt$`));
});

test("a selection of a version that has gone is refused: a newer publication version of the same bytes (A-B-A), other bytes, a revision never recorded, or one from the future", async () => {
  const stale = [
    ["A-B-A: the same bytes, published again as version 3", sourceRecord(9, { version: 3, generation: 2 }), [{ revision: 3, payload: { fingerprint: { sha256: SHA }, version: 1, publication: { current: true } } }]],
    ["other bytes under the same id", sourceRecord(9), [{ revision: 3, payload: { fingerprint: { sha256: "f".repeat(64) }, version: 1, publication: { current: true } } }]],
    ["a chosen revision that was not current", sourceRecord(9), [{ revision: 3, payload: { fingerprint: { sha256: SHA }, version: 1, publication: { current: false } } }]],
    ["a revision the record never had", sourceRecord(9), []],
  ];
  for (const [label, current, history] of stale) {
    const held = fixture({ current, history });
    await assert.rejects(held.copy({ projectId: "p1", expectedRevision: 3 }), { status: 409, code: "source_revision_conflict" }, label);
    assert.equal(held.calls.write.length, 0, label);
  }
  for (const expectedRevision of [999, 0, -1, 1.5, "7", null]) {
    const held = fixture();
    await assert.rejects(held.copy({ projectId: "p1", expectedRevision }), { status: 409, code: "source_revision_conflict" }, String(expectedRevision));
  }
});
