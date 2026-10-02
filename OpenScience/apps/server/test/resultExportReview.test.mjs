import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { unzipSync } from "fflate";
import { ResultExportService } from "../src/resultExport.mjs";

const exec = promisify(execFile);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function fixture(mode = "stable") {
  const reportBytes = Buffer.from("An independently authorized report.");
  const sourceBytes = Buffer.from("RESTRICTED_SOURCE_BODY");
  const child = { versionId: `rv_${"c".repeat(64)}`, digest: sha(sourceBytes), path: "source.md", size: sourceBytes.length,
    inputs: [], code: null, environment: null, findings: [], review: { status: "unknown" }, coverage: { gaps: [] } };
  const ref = { kind: "source", id: "source", versionId: child.versionId, digest: child.digest, path: child.path, availability: "captured" };
  const parent = { versionId: `rv_${"a".repeat(64)}`, digest: sha(reportBytes), path: "report.md", size: reportBytes.length,
    inputs: [ref], code: null, environment: null, findings: [{ sourceRefs: [ref] }],
    review: { status: "available", matrixText: "RESTRICTED_MATRIX_QUOTE" }, coverage: { gaps: [] } };
  let narrowed = false;
  const calls = [];
  const projection = () => narrowed ? { ...parent, inputs: [{ ...ref, path: null, availability: "restricted" }],
    findings: [{ sourceRefs: [{ ...ref, path: null, availability: "restricted" }] }], review: { status: "unavailable", matrixText: null }, coverage: { gaps: ["inputs_restricted"] } } : structuredClone(parent);
  const results = {
    async get(_actor, _project, id) { calls.push(["get", id]); return id === parent.versionId ? projection() : structuredClone(child); },
    async raw(_actor, _project, id) {
      calls.push(["raw", id]);
      if (id === parent.versionId) {
        if (mode === "during_raw") narrowed = true;
        const version = projection();
        if (mode === "review_only") { narrowed = true; return { version, bytes: reportBytes }; }
        return { version, bytes: reportBytes };
      }
      const read = { version: structuredClone(child), bytes: sourceBytes };
      if (mode === "before_release") narrowed = true;
      return read;
    },
  };
  if (mode === "review_only") results.get = async (_actor, _project, id) => id === parent.versionId
    ? { ...parent, review: narrowed ? { status: "unavailable", matrixText: null } : parent.review } : child;
  return { exporter: new ResultExportService({ results }), parent, child, calls, reportBytes };
}
test("export follows the newly authorized raw projection and omits a reference revoked during materialization", async () => {
  const f = fixture("during_raw");
  const reply = await f.exporter.export("owner", "project", f.parent.versionId);
  const archive = unzipSync(reply.bytes);
  assert.equal(reply.manifest.versions.length, 1);
  assert.equal(reply.manifest.completeness, "partial");
  assert.equal(f.calls.some(call => call[0] === "raw" && call[1] === f.child.versionId), false);
  assert.equal(Object.values(archive).some(bytes => Buffer.from(bytes).includes("RESTRICTED_SOURCE_BODY")), false);
  assert.equal(Buffer.from(archive["manifest.json"]).includes("RESTRICTED_MATRIX_QUOTE"), false);
  assert.equal(Buffer.from(archive[`results/${f.parent.versionId}/report.md`]).equals(f.reportBytes), true);
});
test("final parent authorization narrowing refuses the ZIP even when child project access remains allowed", async () => {
  const f = fixture("before_release");
  await assert.rejects(f.exporter.export("owner", "project", f.parent.versionId), { code: "result_export_authorization_changed" });
  assert.equal(f.calls.some(call => call[0] === "raw" && call[1] === f.child.versionId), true);
});
test("review permission narrowing cannot release the earlier embedded quotation in a manifest", async () => {
  const f = fixture("review_only");
  await assert.rejects(f.exporter.export("owner", "project", f.parent.versionId), { code: "result_export_authorization_changed" });
});
test("the exported verifier executes independently and rejects declared size or byte tampering", async t => {
  const f = fixture();
  const reply = await f.exporter.export("owner", "project", f.parent.versionId);
  const root = await mkdtemp(path.join(os.tmpdir(), "evimed-export-verify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, bytes] of Object.entries(unzipSync(reply.bytes))) {
    const target = path.join(root, name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
  }
  const run = () => exec("python3", [path.join(root, "verify.py")]);
  assert.equal(JSON.parse((await run()).stdout).bytes, "identical");
  const manifestPath = path.join(root, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const selected = manifest.files.find(file => file.archivePath.endsWith("/report.md"));
  selected.bytes += 1; await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(run(), error => error.code === 1 && JSON.parse(error.stdout).failed.includes(selected.archivePath));
  selected.bytes -= 1; await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(path.join(root, selected.archivePath), Buffer.from("x".repeat(f.reportBytes.length)));
  await assert.rejects(run(), error => error.code === 1 && JSON.parse(error.stdout).failed.includes(selected.archivePath));
});
