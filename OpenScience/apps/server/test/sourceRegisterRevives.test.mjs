import assert from "node:assert/strict";
import test from "node:test";
import { SourceService } from "../src/sourceService.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const SHA = "a".repeat(64);
const manifest = (path) => ({ projectId: "proj", connector: { type: "upload", id: "project-library" }, path, sha256: SHA, size: 12, mtime: "2026-10-24T00:00:00.000Z", mimeType: "text/markdown" });

function service() {
  const documents = productDocumentsDouble();
  const queued = [];
  const jobs = { enqueue: async (_userId, kind, payload) => { queued.push({ kind, payload }); return { id: `job-${queued.length}` }; } };
  return { documents, queued, sources: new SourceService(documents, jobs) };
}

test("bytes a retired source had are registered again: the retired row is brought back as this registration and read anew", async () => {
  const { documents, queued, sources } = service();
  const first = await sources.register("user", manifest("knowledge-base/wiki/page.md"));
  assert.equal(first.duplicate, false);
  await documents.remove("user", "source", first.source.id, first.source.revision);
  assert.equal(await documents.get("user", "source", first.source.id), null, "retired");

  // A knowledge page compiled back to an earlier text, or a file put back after it was removed: the same digest, the same id.
  const again = await sources.register("user", manifest("knowledge-base/wiki/page.md"));
  assert.equal(again.duplicate, false, "a registration of its own, not a duplicate of nothing");
  assert.equal(again.source.id, first.source.id);
  assert.equal(again.source.deletedAt, null);
  assert.ok(again.source.revision > first.source.revision, "a revision over the retired one, so history keeps both");
  assert.equal(again.source.payload.status, "queued");
  assert.equal(queued.filter((job) => job.kind === "ingest").length, 2, "it is read again");
});

test("the same bytes alive are still a duplicate, and another project's copy of retired bytes is a source of its own", async () => {
  const { documents, sources } = service();
  const first = await sources.register("user", manifest("knowledge-base/a.md"));
  const duplicate = await sources.register("user", manifest("knowledge-base/a.md"));
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.source.revision, first.source.revision);
  await documents.remove("user", "source", first.source.id, first.source.revision);
  const elsewhere = await sources.register("user", { ...manifest("knowledge-base/a.md"), projectId: "other" });
  assert.equal(elsewhere.duplicate, false);
  assert.notEqual(elsewhere.source.id, first.source.id, "the id is the project's and the bytes'");
  assert.equal(await documents.get("user", "source", first.source.id), null, "the retired row of the first project stays retired");
});
