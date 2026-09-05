import assert from "node:assert/strict";
import test from "node:test";
import { validateCapsuleManifest } from "../src/capsule.mjs";

function fixture(overrides = {}) {
  return { formatVersion: "1.0", capsuleId: "test-only", version: 1, createdAt: "2026-09-05T00:00:00Z",
    issuer: { userId: "test-only-user", signingKeyId: "a".repeat(32) }, scope: ["workstyle"], layers: ["methods"],
    entries: [{ path: "methods/example/SKILL.md", sha256: "a".repeat(64), bytes: 1, mime: "text/markdown", layer: "methods" }],
    merkleRoot: "a".repeat(64), prevManifestSha256: null, ...overrides };
}

test("capsule paths are canonical and sizes/layers bound before cryptographic work", () => {
  assert.ok(validateCapsuleManifest(fixture()).ok);
  const entry = fixture().entries[0];
  for (const path of ["methods/../SKILL.md", "methods/\\SKILL.md", "methods//SKILL.md", "methods/./SKILL.md", "C:/SKILL.md", "methods/\0/SKILL.md"]) {
    assert.equal(validateCapsuleManifest(fixture({ entries: [{ ...entry, path }] })).ok, false, "Noncanonical path must be rejected");
  }
  for (const override of [{ bytes: -1 }, { bytes: "1" }, { bytes: 8 * 1024 * 1024 + 1 }, { layer: "unknown" }, { layer: "profile" }]) {
    assert.equal(validateCapsuleManifest(fixture({ entries: [{ ...entry, ...override }] })).ok, false);
  }
  assert.equal(validateCapsuleManifest(fixture({ entries: Array.from({ length: 257 }, (_, n) => ({ ...entry, path: `methods/${n}/SKILL.md` })) })).ok, false);
});

test("password mode is versioned and requires authenticated wrapping metadata", () => {
  const encryption = { scheme: "scrypt+aes-256-gcm", recipients: [], passwordWrapSha256: "b".repeat(64) };
  assert.ok(validateCapsuleManifest(fixture({ formatVersion: "1.1", encryption })).ok);
  assert.equal(validateCapsuleManifest(fixture({ encryption })).ok, false);
  assert.equal(validateCapsuleManifest(fixture({ formatVersion: "1.1", encryption: { ...encryption, passwordWrapSha256: undefined } })).ok, false);
  assert.equal(validateCapsuleManifest(fixture({ formatVersion: "1.1", encryption: { scheme: "x25519-hkdf-sha256+aes-256-gcm", recipients: [] } })).ok, false);
});

test("additional share scopes permit exactly their listed paths", () => {
  const entry = { ...fixture().entries[0], path: "profile.md", layer: "profile" };
  assert.equal(validateCapsuleManifest(fixture({ layers: ["profile"], entries: [entry] })).ok, false);
  assert.ok(validateCapsuleManifest(fixture({ scope: ["workstyle", "+profile"], layers: ["profile"], entries: [entry] })).ok);
  assert.equal(validateCapsuleManifest(fixture({ scope: ["workstyle", "+profile"], layers: ["knowledge"], entries: [{ ...entry, path: "documents/private.txt", layer: "knowledge" }] })).ok, false);
});
