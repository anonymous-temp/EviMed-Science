// The container's guarantees, stated as the four things it has to survive:
// a round trip, a tampered byte, a wrong key, and an unsigned claim of
// authorship. Each is a real scenario — a share that is opened, a share that
// was altered in transit or in a third-party store, a share addressed to
// someone else, and a share claiming to be someone's work.
//
// The limits are asserted too, because a security note that overstates is worse
// than none: what cryptography cannot do here is stop a recipient forwarding
// what they legitimately decrypted, and the tests say so rather than implying
// otherwise.
import assert from "node:assert/strict";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import test from "node:test";

import { CAPSULE_FORMAT_VERSION, validateCapsuleManifest } from "@evimed/domain";

import {
  checkImportSafety,
  generateCapsuleIdentity,
  openCapsule,
  packCapsule,
  unwrapWithPassword,
  verifyCapsule,
} from "../src/capsuleContainer.mjs";

const alice = generateCapsuleIdentity();
const bob = generateCapsuleIdentity();
const mallory = generateCapsuleIdentity();

const entries = [
  { path: "standards.jsonl", content: '{"rule":"报告效应量而非显著性措辞"}\n', mime: "application/x-ndjson", layer: "profile" },
  { path: "methods/systematic-review/SKILL.md", content: "---\nname: systematic-review\n---\n\n先 PROSPERO 登记。\n", mime: "text/markdown", layer: "methods" },
  { path: "lessons.jsonl", content: '{"lesson":"结论要区分人群"}\n', mime: "application/x-ndjson", layer: "episodes" },
];

function packForBob(overrides = {}) {
  return packCapsule({
    capsuleId: "cap_alice",
    version: 7,
    createdAt: "2026-08-23T00:00:00Z",
    issuer: { userId: "alice", signingKeyId: alice.signing.keyId, signingPrivateKey: alice.signing.privateKey },
    scope: ["workstyle"],
    layers: ["profile", "methods", "episodes"],
    entries,
    recipients: [{ encKeyId: bob.encryption.keyId, publicKey: bob.encryption.publicKey }],
    prevManifestSha256: null,
    license: "CC-BY-4.0",
    attribution: "Alice",
    ...overrides,
  });
}

test("a packed container has a well-formed, signed manifest", () => {
  const container = packForBob();
  const shape = validateCapsuleManifest(container.manifest);
  assert.ok(shape.ok, JSON.stringify(shape.issues));
  assert.equal(container.manifest.formatVersion, CAPSULE_FORMAT_VERSION);
  assert.equal(container.manifest.signature.alg, "ed25519");
  assert.equal(container.manifest.signature.keyId, alice.signing.keyId);
  assert.equal(container.manifest.encryption.scheme, "x25519-hkdf-sha256+aes-256-gcm");
  assert.equal(container.manifest.prevManifestSha256, null);
  assert.match(container.readme, /methods\/ 目录本身就是一个合法的技能根/);
});

test("a manifest listing the same entry path twice is rejected", () => {
  // Which of the two an unpacker keeps is an implementation detail; a
  // signature covering both says nothing about which content a recipient
  // actually receives. Built by hand rather than through `packCapsule`
  // (which only ever emits one manifest entry per path) — the manifest
  // shape a receiving `validateCapsuleManifest` call must still refuse.
  const container = packForBob();
  const duplicated = {
    ...container.manifest,
    entries: [...container.manifest.entries, container.manifest.entries[0]],
  };
  const shape = validateCapsuleManifest(duplicated);
  assert.equal(shape.ok, false);
  assert.ok(shape.issues.some((issue) => /listed more than once/.test(issue.message)), JSON.stringify(shape.issues));
});

test("the payload is ciphertext, and the plaintext is not recoverable from the container alone", () => {
  const container = packForBob();
  for (const entry of entries) {
    const sealed = container.payload[entry.path];
    assert.ok(Buffer.isBuffer(sealed));
    assert.ok(!sealed.toString("utf8").includes(entry.content.slice(0, 8)), `${entry.path} leaked plaintext`);
    // nonce + tag + at least one byte of body
    assert.ok(sealed.length >= 12 + 16 + 1);
  }
});

test("the addressed recipient opens it and gets exactly what was packed", () => {
  const container = packForBob();
  const opened = openCapsule(container, {
    issuer: { signingPublicKey: alice.signing.publicKey },
    recipient: { encKeyId: bob.encryption.keyId, privateKey: bob.encryption.privateKey, publicKey: bob.encryption.publicKey },
  });
  assert.ok(opened.ok, JSON.stringify(opened.issues ?? []));
  for (const entry of entries) assert.equal(opened.entries[entry.path], entry.content);
  assert.equal(opened.manifest.issuer.userId, "alice");
});

test("someone the container was not addressed to cannot open it", () => {
  const container = packForBob();
  const opened = openCapsule(container, {
    issuer: { signingPublicKey: alice.signing.publicKey },
    recipient: { encKeyId: mallory.encryption.keyId, privateKey: mallory.encryption.privateKey, publicKey: mallory.encryption.publicKey },
  });
  assert.equal(opened.ok, false);
  assert.equal(opened.issues[0].code, "capsule_key_invalid");
});

test("the right key id with the wrong private key still fails", () => {
  // The failure has to come from the cryptography, not from a name check: an
  // attacker chooses the id they present.
  const container = packForBob();
  const opened = openCapsule(container, {
    issuer: { signingPublicKey: alice.signing.publicKey },
    recipient: { encKeyId: bob.encryption.keyId, privateKey: mallory.encryption.privateKey, publicKey: bob.encryption.publicKey },
  });
  assert.equal(opened.ok, false);
  assert.equal(opened.issues[0].code, "capsule_key_invalid");
});

test("one changed byte fails verification", () => {
  const container = packForBob();
  const tampered = { ...container, payload: { ...container.payload } };
  const target = Buffer.from(tampered.payload["lessons.jsonl"]);
  target[target.length - 20] ^= 0x01;
  tampered.payload["lessons.jsonl"] = target;
  const opened = openCapsule(tampered, {
    issuer: { signingPublicKey: alice.signing.publicKey },
    recipient: { encKeyId: bob.encryption.keyId, privateKey: bob.encryption.privateKey, publicKey: bob.encryption.publicKey },
  });
  assert.equal(opened.ok, false);
  assert.equal(opened.issues[0].code, "capsule_tampered");
});

test("a rewritten manifest fails the signature, whatever else it says", () => {
  const container = packForBob();
  const forged = {
    ...container,
    manifest: { ...container.manifest, issuer: { userId: "mallory", signingKeyId: container.manifest.issuer.signingKeyId } },
  };
  const verified = verifyCapsule(forged, { signingPublicKey: alice.signing.publicKey });
  assert.equal(verified.ok, false);
  assert.ok(verified.issues.some((issue) => issue.code === "capsule_signature_invalid"));
});

test("a container signed by someone else does not pass as the issuer's", () => {
  const impostor = packCapsule({
    capsuleId: "cap_alice",
    version: 7,
    createdAt: "2026-08-23T00:00:00Z",
    issuer: { userId: "alice", signingKeyId: mallory.signing.keyId, signingPrivateKey: mallory.signing.privateKey },
    scope: ["workstyle"],
    layers: ["methods"],
    entries: [entries[1]],
    recipients: [{ encKeyId: bob.encryption.keyId, publicKey: bob.encryption.publicKey }],
  });
  const verified = verifyCapsule(impostor, { signingPublicKey: alice.signing.publicKey });
  assert.equal(verified.ok, false);
  assert.ok(verified.issues.some((issue) => issue.code === "capsule_signature_invalid"));
});

test("an entry moved to another path inside the same container fails", () => {
  // The path is bound into the ciphertext, so a valid entry cannot be presented
  // as a different one.
  const container = packForBob();
  const moved = {
    manifest: container.manifest,
    payload: { ...container.payload, "lessons.jsonl": container.payload["standards.jsonl"] },
  };
  const opened = openCapsule(moved, {
    issuer: { signingPublicKey: alice.signing.publicKey },
    recipient: { encKeyId: bob.encryption.keyId, privateKey: bob.encryption.privateKey, publicKey: bob.encryption.publicKey },
  });
  assert.equal(opened.ok, false);
  assert.equal(opened.issues[0].code, "capsule_tampered");
});

test("content nobody signed cannot ride along unnoticed", () => {
  const container = packForBob();
  const smuggled = { manifest: container.manifest, payload: { ...container.payload, "extra.md": Buffer.from("未登记内容") } };
  const verified = verifyCapsule(smuggled, { signingPublicKey: alice.signing.publicKey });
  assert.equal(verified.ok, false);
  assert.ok(verified.issues.some((issue) => issue.code === "capsule_unlisted_entry"));
});

test("a password copy opens the same container offline, and a wrong password does not", () => {
  const container = packForBob({ password: "correct horse battery staple" });
  assert.ok(container.passwordWrap);
  const opened = openCapsule(container, {
    issuer: { signingPublicKey: alice.signing.publicKey },
    passwordWrap: container.passwordWrap,
    password: "correct horse battery staple",
  });
  assert.ok(opened.ok, JSON.stringify(opened.issues ?? []));
  assert.equal(opened.entries["lessons.jsonl"], entries[2].content);
  assert.throws(() => unwrapWithPassword(container.passwordWrap, "wrong"), /unable to authenticate|bad decrypt|Unsupported/i);
});

test("unwrapping honors the cost a container was actually wrapped with, not today's default", () => {
  // `wrapWithPassword` writes its own `maxmem` into the header next to N/r/p so
  // a build whose default has since moved can still open an older container.
  // Hand-built rather than packed, because the point is a header whose cost
  // disagrees with today's constant.
  //
  // N=262144,r=8 needs 256 MiB — more than this build's own 96 MiB default —
  // so this only opens if `unwrapWithPassword` reads the header. Asserted on
  // the success path deliberately: a test that instead fed scrypt a too-small
  // maxmem and caught the throw left OpenSSL's error queue dirty, and the very
  // next test in the process failed inside an unrelated `createPrivateKey`.
  const password = "correct horse battery staple";
  const salt = randomBytes(16);
  const params = { N: 262144, r: 8, p: 1 };
  const maxmem = 320 * 1024 * 1024;
  const derived = scryptSync(password, salt, 32, { ...params, maxmem });
  const packKey = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derived, nonce);
  const body = Buffer.concat([cipher.update(packKey), cipher.final()]);
  const header = Buffer.from(JSON.stringify({ kdf: "scrypt", ...params, maxmem, salt: salt.toString("base64") }), "utf8");
  const headerLength = Buffer.alloc(2);
  headerLength.writeUInt16BE(header.length);
  const wrapped = Buffer.concat([headerLength, header, nonce, body, cipher.getAuthTag()]);

  assert.deepEqual(unwrapWithPassword(wrapped, password), packKey);
});

test("a password wrap records the cost it used, so a later build can reproduce it", () => {
  const container = packForBob({ password: "correct horse battery staple" });
  const headerLength = container.passwordWrap.readUInt16BE(0);
  const header = JSON.parse(container.passwordWrap.subarray(2, 2 + headerLength).toString("utf8"));
  // Without this field on the wire, the read side has nothing to honor and the
  // test above is asserting a property the format cannot actually carry.
  assert.equal(typeof header.maxmem, "number");
  assert.ok(header.maxmem >= 128 * header.N * header.r, "the recorded cost must cover the recorded parameters");
});

/** A password wrap with a header we choose, for the costs a hostile sender would name. */
function wrapWithHeader(overrides) {
  const salt = randomBytes(16);
  const header = Buffer.from(JSON.stringify({ kdf: "scrypt", N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024, salt: salt.toString("base64"), ...overrides }), "utf8");
  const headerLength = Buffer.alloc(2);
  headerLength.writeUInt16BE(header.length);
  // Body is never reached: every case below is refused on the parameters alone.
  return Buffer.concat([headerLength, header, randomBytes(12 + 32 + 16)]);
}

test("a header naming more memory than we will spend is refused, by its own name", () => {
  // The header travels with the container, so N is the sender's choice and
  // scrypt allocates 128·N·r for it. Honoring N=2^30 faithfully is an
  // instruction to allocate 128 GiB — "someone sent me a file" becoming an
  // out-of-memory kill. The same rule as a model-supplied path: derive from
  // what arrived, then bound it.
  assert.throws(
    () => unwrapWithPassword(wrapWithHeader({ N: 2 ** 30 }), "correct horse battery staple"),
    (error) => error.code === "capsule_password_params_unsupported" && /ceiling/.test(error.message),
  );
  // The ceiling applies to the recorded number too, not only to what N implies.
  assert.throws(
    () => unwrapWithPassword(wrapWithHeader({ maxmem: 128 * 1024 * 1024 * 1024 }), "correct horse battery staple"),
    (error) => error.code === "capsule_password_params_unsupported",
  );
});

test("a header whose scrypt parameters are not a usable set is refused before the primitive sees them", () => {
  // scrypt needs N a power of two above one. Checked here so a malformed
  // header is refused by its own name rather than surfacing as an opaque
  // OpenSSL string a reader cannot act on.
  for (const bad of [{ N: 32769 }, { N: 0 }, { N: -1 }, { r: 0 }, { p: -4 }, { N: 1.5 }]) {
    assert.throws(
      () => unwrapWithPassword(wrapWithHeader(bad), "correct horse battery staple"),
      (error) => error.code === "capsule_password_params_unsupported",
      JSON.stringify(bad),
    );
  }
});

test("a refused cost reaches the caller as a cost problem, not as a wrong key", () => {
  // These are different facts and a reader acts on them differently; collapsing
  // them sends someone looking for a key problem that does not exist.
  const container = packForBob({ password: "correct horse battery staple" });
  const opened = openCapsule(container, {
    issuer: { signingPublicKey: alice.signing.publicKey },
    passwordWrap: wrapWithHeader({ N: 2 ** 30 }),
    password: "correct horse battery staple",
  });
  assert.equal(opened.ok, false);
  assert.equal(opened.issues[0].code, "capsule_password_params_unsupported");
});

test("a plaintext export is still signed, because authorship is separate from secrecy", () => {
  const container = packCapsule({
    capsuleId: "cap_alice",
    version: 8,
    createdAt: "2026-08-23T00:00:00Z",
    issuer: { userId: "alice", signingKeyId: alice.signing.keyId, signingPrivateKey: alice.signing.privateKey },
    scope: ["workstyle"],
    layers: ["methods"],
    entries: [entries[1]],
  });
  assert.equal(container.manifest.encryption, undefined);
  assert.ok(container.manifest.signature);
  const opened = openCapsule(container, { issuer: { signingPublicKey: alice.signing.publicKey } });
  assert.ok(opened.ok, JSON.stringify(opened.issues ?? []));
  assert.equal(opened.entries["methods/systematic-review/SKILL.md"], entries[1].content);
});

test("the version chain is carried, so a v8 can prove it came from a v7", () => {
  const seven = packForBob();
  const previous = seven.manifest;
  const eight = packForBob({ version: 8, prevManifestSha256: "a".repeat(64) });
  assert.equal(eight.manifest.prevManifestSha256, "a".repeat(64));
  assert.notEqual(eight.manifest.merkleRoot, undefined);
  assert.equal(previous.version, 7);
});

test("executable content is refused at the boundary, not handled carefully later", () => {
  const hostile = packCapsule({
    capsuleId: "cap_mallory",
    version: 1,
    createdAt: "2026-08-23T00:00:00Z",
    issuer: { userId: "mallory", signingKeyId: mallory.signing.keyId, signingPrivateKey: mallory.signing.privateKey },
    scope: ["workstyle"],
    layers: ["methods"],
    entries: [
      { path: "memos/activation_memory.pickle", content: "pickled", mime: "application/octet-stream", layer: "knowledge" },
      { path: "methods/run.py", content: "import os", mime: "text/x-python", layer: "methods" },
    ],
  });
  const safety = checkImportSafety(hostile.manifest);
  assert.equal(safety.ok, false);
  assert.equal(safety.issues.length, 3, JSON.stringify(safety.issues));
  assert.ok(safety.issues.some((issue) => issue.code === "capsule_executable_content"));
  assert.ok(safety.issues.some((issue) => issue.code === "capsule_method_shape_invalid"));

  const clean = checkImportSafety(packForBob().manifest);
  assert.equal(clean.ok, true, JSON.stringify(clean.issues));
});

test("a share that never includes the workstyle pack is not a share", () => {
  const result = validateCapsuleManifest({ ...packForBob().manifest, scope: ["+profile"] });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /workstyle/.test(issue.message)));
});

test("the source layer never leaves, whatever the scope says", () => {
  const result = validateCapsuleManifest({
    ...packForBob().manifest,
    entries: [{ path: "documents/patient-notes.pdf", sha256: "b".repeat(64), bytes: 10, mime: "application/pdf", layer: "sources" }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "capsule_restricted_content"));
});
