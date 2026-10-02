import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExtensionOperationGrants } from "../src/extensionOperationGrants.mjs";

const scope = { userId: "alice", projectId: "p1", accountCreatedAt: "account-epoch", projectCreatedAt: "project-epoch",
  runtimeGeneration: "runtime-one", extensionGenerationHash: "a".repeat(64), descriptorId: "cowork-portable",
  artifactDigest: `sha256:${"b".repeat(64)}`, installationId: "extension:owned", installationRevision: 1 };
const request = { operation: "doc_read", resourceId: "resource_one", options: {} };
// These unit controls inject an explicit fixture fence. Hosted construction
// must supply its actual account/storage admission and existing job lifecycle.
const withAdmission = async (_scope, work) => work();

test("operation grants bind the exact actor, project, generation, artifact and request and recheck revocation", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "evimed-operation-grant-")));
  let allowed = true, now = 10000;
  const grants = new ExtensionOperationGrants({ dataDir: root, secret: "test-only-signing-secret-with-enough-bytes", authorize: async current => allowed && current.userId === "alice", withAdmission, now: () => now, ttlMs: 1000 });
  try {
    const issued = await grants.issue(scope, request, { resourceId: request.resourceId, format: "pdf", dataClass: "public", bytes: Buffer.from("permitted fixture bytes") });
    assert.deepEqual(Object.keys(issued), ["operationId"]);
    assert.equal((await grants.verify(issued.operationId, request, { userId: "alice", descriptorId: "cowork-portable" })).scope.projectId, "p1");
    await assert.rejects(grants.verify(issued.operationId, request, { userId: "bob" }), { code: "extension_access_denied" });
    await assert.rejects(grants.verify(issued.operationId, { ...request, resourceId: "other_resource" }), { code: "extension_access_denied" });
    const input = await grants.inputSnapshot(issued.operationId, request, request.resourceId);
    assert.equal(await fs.readFile(input.filePath, "utf8"), "permitted fixture bytes");
    allowed = false; await assert.rejects(grants.verify(issued.operationId, request), { code: "extension_access_denied" });
    allowed = true; now = 11000; await assert.rejects(grants.verify(issued.operationId, request), { code: "extension_access_denied" });
    await grants.remove(issued.operationId); await grants.remove(issued.operationId);
    await assert.rejects(fs.stat(path.dirname(input.filePath)), { code: "ENOENT" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("caller scope forgery, private snapshots and signed-state tampering cannot acquire operation authority", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "evimed-operation-forgery-")));
  const grants = new ExtensionOperationGrants({ dataDir: root, secret: "test-only-signing-secret-with-enough-bytes", authorize: async current => current.userId === "alice", withAdmission });
  try {
    await assert.rejects(grants.issue({ ...scope, role: "owner" }, request), { code: "extension_contract_invalid" });
    await assert.rejects(grants.issue({ ...scope, userId: "bob" }, request), { code: "extension_access_denied" });
    await assert.rejects(grants.issue(scope, request, { resourceId: request.resourceId, format: "pdf", dataClass: "private", bytes: Buffer.from("private bytes") }), { code: "extension_access_denied" });
    assert.deepEqual(await fs.readdir(root), []);
    const issued = await grants.issue(scope, request);
    const file = path.join(grants.reference(issued.operationId).directory, "grant.json");
    const record = JSON.parse(await fs.readFile(file, "utf8")); record.body.scope.projectId = "p2";
    await fs.chmod(file, 0o600); await fs.writeFile(file, JSON.stringify(record));
    await assert.rejects(grants.verify(issued.operationId, request), { code: "extension_access_denied" });
    await grants.remove(issued.operationId);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("an authorized snapshot captures its own bytes before asynchronous authorization can mutate a reused buffer", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "evimed-operation-snapshot-")));
  const bytes = Buffer.from("before"), captured = Buffer.from(bytes);
  const grants = new ExtensionOperationGrants({ dataDir: root, secret: "test-only-signing-secret-with-enough-bytes", authorize: async () => { bytes.fill(120); return true; }, withAdmission });
  try {
    const issued = await grants.issue(scope, request, { resourceId: request.resourceId, format: "pdf", dataClass: "public", bytes });
    const snapshot = await grants.inputSnapshot(issued.operationId, request, request.resourceId);
    const actual = await fs.readFile(snapshot.filePath);
    assert.deepEqual(actual, captured);
    assert.equal(snapshot.sha256, createHash("sha256").update(actual).digest("hex"));
    await grants.remove(issued.operationId);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
