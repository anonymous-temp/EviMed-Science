import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EXTENSION_SAAS_CASE_IDS, extensionProofDigest } from "@evimed/domain";
import { ExtensionQualification } from "../src/extensionQualification.mjs";

const hash = text => createHash("sha256").update(text).digest("hex"), digest = text => `sha256:${hash(text)}`;
const entry = { id: "fixture-documents" };
const original = { packageIntegrity: digest("fixture-package"), sourceCommit: "a".repeat(40), adapterRevision: digest("fixture-adapter"),
  runtimeImageDigest: digest("fixture-runtime"), permissionProfileRevision: digest("fixture-policy"), suiteRevision: digest("fixture-suite"), dshVersion: "0.1.7-rc.2", executionClass: "isolated-tool" };
// Synthetic contract outcomes below test the reader only. They qualify no
// actual artifact/runtime and must never become a deployment receipt.
const outcomes = () => EXTENSION_SAAS_CASE_IDS.map(caseId => ({ caseId, status: "pass", observationDigests: [digest(caseId)], artifactDigests: [digest("fixture-" + caseId)] }));

test("protected qualification needs signed complete observations and current exact deployment identity", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "evimed-qualification-reader-")));
  let identity = original;
  const surfaces = { client: false, browser: false, externalActions: false, descriptorDigest: digest("fixture-surfaces") };
  const reader = new ExtensionQualification({ root, secret: "test-only-qualification-secret-with-enough-bytes", currentIdentity: async () => identity, surfaces: async () => surfaces });
  const file = path.join(root, hash(entry.id) + ".json");
  const write = async cases => {
    const receipt = { schemaVersion: 1, identity: original, cases }; receipt.receiptDigest = extensionProofDigest(receipt, hash);
    const body = { schemaVersion: 1, catalogueId: entry.id, receipt, surfaces };
    await fs.unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; });
    await fs.writeFile(file, JSON.stringify({ body, signature: reader.signature(body) }), { mode: 0o400 });
    return body;
  };
  try {
    assert.equal(await reader.authority(entry), null, "missing qualification stays unknown, never a fabricated ready state");
    await write(outcomes()); assert.equal((await reader.authority(entry)).currentIdentity.runtimeImageDigest, original.runtimeImageDigest);
    identity = { ...original, runtimeImageDigest: digest("new-runtime") };
    await assert.rejects(reader.authority(entry), { code: "extension_proof_stale" }); identity = original;
    await write(outcomes().slice(1)); await assert.rejects(reader.authority(entry), { code: "extension_proof_incomplete" });
    const body = await write(outcomes()); await fs.chmod(file, 0o600);
    await fs.writeFile(file, JSON.stringify({ body, signature: "0".repeat(64) }));
    await assert.rejects(reader.authority(entry), { code: "extension_proof_untrusted" });
    await write(outcomes()); await fs.chmod(file, 0o666); await assert.rejects(reader.authority(entry), { code: "extension_proof_untrusted" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
