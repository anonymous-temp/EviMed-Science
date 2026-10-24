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
import crypto, { createCipheriv, createHash, createPrivateKey, randomBytes, scryptSync, sign } from "node:crypto";
import test, { after } from "node:test";
import { syncBuiltinESMExports } from "node:module";

import { CAPSULE_FORMAT_VERSION, merkleRoot, signablePayload, validateCapsuleManifest } from "@evimed/domain";

import {
  checkImportSafety,
  generateCapsuleIdentity,
  openCapsule,
  packCapsule,
  unwrapWithPassword,
  verifyCapsule,
} from "../src/capsuleContainer.mjs";

// The gate's wait timer is unref'd on purpose: a queued request must not hold a stopping process open, and in production the
// request's own socket keeps the event loop alive. A test has no socket, and Node 22's runner (CI pins 22.22.0) cancels a test whose
// only pending handle is an unref'd timer ("Promise resolution is still pending but the event loop has already resolved"), so the
// file holds one ref'd handle while it runs, as a listening server would.
const alive = setInterval(() => {}, 60_000);
after(() => clearInterval(alive));

const alice = generateCapsuleIdentity();
const bob = generateCapsuleIdentity();
const mallory = generateCapsuleIdentity();

const entries = [
  { path: "standards.jsonl", content: '{"rule":"报告效应量而非显著性措辞"}\n', mime: "application/x-ndjson", layer: "profile" },
  { path: "methods/systematic-review/SKILL.md", content: "---\nname: systematic-review\n---\n\n先 PROSPERO 登记。\n", mime: "text/markdown", layer: "methods" },
  { path: "provenance.json", content: '{"note":"结论要区分人群"}', mime: "application/json", layer: "methods" },
];

function packForBob(overrides = {}) {
  return packCapsule({
    capsuleId: "cap_alice",
    version: 7,
    createdAt: "2026-08-23T00:00:00Z",
    issuer: { userId: "alice", signingKeyId: alice.signing.keyId, signingPrivateKey: alice.signing.privateKey },
    scope: ["workstyle"],
    layers: ["profile", "methods"],
    entries,
    recipients: [{ encKeyId: bob.encryption.keyId, publicKey: bob.encryption.publicKey }],
    prevManifestSha256: null,
    license: "CC-BY-4.0",
    attribution: "Alice",
    ...overrides,
  });
}

test("a packed container has a well-formed, signed manifest", async () => {
  const container = await packForBob();
  const shape = validateCapsuleManifest(container.manifest);
  assert.ok(shape.ok, JSON.stringify(shape.issues));
  assert.equal(container.manifest.formatVersion, CAPSULE_FORMAT_VERSION);
  assert.equal(container.manifest.signature.alg, "ed25519");
  assert.equal(container.manifest.signature.keyId, alice.signing.keyId);
  assert.equal(container.manifest.encryption.scheme, "x25519-hkdf-sha256+aes-256-gcm");
  assert.equal(container.manifest.prevManifestSha256, null);
  assert.match(container.readme, /methods\/ 目录本身就是一个合法的技能根/);
});

test("a manifest listing the same entry path twice is rejected", async () => {
  // Which of the two an unpacker keeps is an implementation detail; a
  // signature covering both says nothing about which content a recipient
  // actually receives. Built by hand rather than through `packCapsule`
  // (which only ever emits one manifest entry per path) — the manifest
  // shape a receiving `validateCapsuleManifest` call must still refuse.
  const container = await packForBob();
  const duplicated = {
    ...container.manifest,
    entries: [...container.manifest.entries, container.manifest.entries[0]],
  };
  const shape = validateCapsuleManifest(duplicated);
  assert.equal(shape.ok, false);
  assert.ok(shape.issues.some((issue) => /listed more than once/.test(issue.message)), JSON.stringify(shape.issues));
});

test("the payload is ciphertext, and the plaintext is not recoverable from the container alone", async () => {
  const container = await packForBob();
  for (const entry of entries) {
    const sealed = container.payload[entry.path];
    assert.ok(Buffer.isBuffer(sealed));
    assert.ok(!sealed.toString("utf8").includes(entry.content.slice(0, 8)), `${entry.path} leaked plaintext`);
    // nonce + tag + at least one byte of body
    assert.ok(sealed.length >= 12 + 16 + 1);
  }
});

test("the addressed recipient opens it and gets exactly what was packed", async () => {
  const container = await packForBob();
  const opened = await openCapsule(container, {
    issuer: { signingPublicKey: alice.signing.publicKey },
    recipient: { encKeyId: bob.encryption.keyId, privateKey: bob.encryption.privateKey, publicKey: bob.encryption.publicKey },
  });
  assert.ok(opened.ok, JSON.stringify(opened.issues ?? []));
  for (const entry of entries) assert.equal(opened.entries[entry.path], entry.content);
  assert.equal(opened.manifest.issuer.userId, "alice");
});

test("someone the container was not addressed to cannot open it", async () => {
  const container = await packForBob();
  const opened = await openCapsule(container, {
    issuer: { signingPublicKey: alice.signing.publicKey },
    recipient: { encKeyId: mallory.encryption.keyId, privateKey: mallory.encryption.privateKey, publicKey: mallory.encryption.publicKey },
  });
  assert.equal(opened.ok, false);
  assert.equal(opened.issues[0].code, "capsule_key_invalid");
});

test("the right key id with the wrong private key still fails", async () => {
  // The failure has to come from the cryptography, not from a name check: an
  // attacker chooses the id they present.
  const container = await packForBob();
  const opened = await openCapsule(container, {
    issuer: { signingPublicKey: alice.signing.publicKey },
    recipient: { encKeyId: bob.encryption.keyId, privateKey: mallory.encryption.privateKey, publicKey: bob.encryption.publicKey },
  });
  assert.equal(opened.ok, false);
  assert.equal(opened.issues[0].code, "capsule_key_invalid");
});

test("one changed byte fails verification", async () => {
  const container = await packForBob();
  const tampered = { ...container, payload: { ...container.payload } };
  const target = Buffer.from(tampered.payload["provenance.json"]);
  target[target.length - 20] ^= 0x01;
  tampered.payload["provenance.json"] = target;
  const opened = await openCapsule(tampered, {
    issuer: { signingPublicKey: alice.signing.publicKey },
    recipient: { encKeyId: bob.encryption.keyId, privateKey: bob.encryption.privateKey, publicKey: bob.encryption.publicKey },
  });
  assert.equal(opened.ok, false);
  assert.equal(opened.issues[0].code, "capsule_tampered");
});

test("a rewritten manifest fails the signature, whatever else it says", async () => {
  const container = await packForBob();
  const forged = {
    ...container,
    manifest: { ...container.manifest, issuer: { userId: "mallory", signingKeyId: container.manifest.issuer.signingKeyId } },
  };
  const verified = verifyCapsule(forged, { signingPublicKey: alice.signing.publicKey });
  assert.equal(verified.ok, false);
  assert.ok(verified.issues.some((issue) => issue.code === "capsule_signature_invalid"));
});

test("a container signed by someone else does not pass as the issuer's", async () => {
  const impostor = await packCapsule({
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

test("an entry moved to another path inside the same container fails", async () => {
  // The path is bound into the ciphertext, so a valid entry cannot be presented
  // as a different one.
  const container = await packForBob();
  const moved = {
    manifest: container.manifest,
    payload: { ...container.payload, "provenance.json": container.payload["standards.jsonl"] },
  };
  const opened = await openCapsule(moved, {
    issuer: { signingPublicKey: alice.signing.publicKey },
    recipient: { encKeyId: bob.encryption.keyId, privateKey: bob.encryption.privateKey, publicKey: bob.encryption.publicKey },
  });
  assert.equal(opened.ok, false);
  assert.equal(opened.issues[0].code, "capsule_tampered");
});

test("content nobody signed cannot ride along unnoticed", async () => {
  const container = await packForBob();
  const smuggled = { manifest: container.manifest, payload: { ...container.payload, "extra.md": Buffer.from("未登记内容") } };
  const verified = verifyCapsule(smuggled, { signingPublicKey: alice.signing.publicKey });
  assert.equal(verified.ok, false);
  assert.ok(verified.issues.some((issue) => issue.code === "capsule_unlisted_entry"));
});

test("a password copy opens the same container offline, and a wrong password does not", async () => {
  const container = await packForBob({ password: "correct horse battery staple" });
  assert.ok(container.passwordWrap);
  const opened = await openCapsule(container, {
    issuer: { signingPublicKey: alice.signing.publicKey },
    passwordWrap: container.passwordWrap,
    password: "correct horse battery staple",
  });
  assert.ok(opened.ok, JSON.stringify(opened.issues ?? []));
  assert.equal(opened.entries["provenance.json"], entries[2].content);
  await assert.rejects(async () => unwrapWithPassword(container.passwordWrap, "wrong"), /unable to authenticate|bad decrypt|Unsupported/i);
});

/** A password wrap built by hand from a header and the scrypt cost it names, for costs the packer never writes. */
function handWrap({ params, maxmem, password, packKey = randomBytes(32), salt = randomBytes(16) }) {
  const derived = scryptSync(password, salt, 32, { ...params, maxmem });
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derived, nonce);
  const body = Buffer.concat([cipher.update(packKey), cipher.final()]);
  const header = Buffer.from(JSON.stringify({ kdf: "scrypt", ...params, maxmem, salt: salt.toString("base64") }), "utf8");
  const headerLength = Buffer.alloc(2);
  headerLength.writeUInt16BE(header.length);
  return { packKey, wrapped: Buffer.concat([headerLength, header, nonce, body, cipher.getAuthTag()]) };
}

test("unwrapping honors the recorded memory limit of a cost this platform wrote, not today's default", async () => {
  // `wrapWithPassword` writes its own `maxmem` into the header next to N/r/p, so a build whose default has since moved
  // still opens an older container. Hand-built rather than packed, because the point is a header whose recorded limit
  // disagrees with today's constant. Asserted on the success path deliberately: a test that fed scrypt a too-small
  // maxmem and caught the throw left OpenSSL's error queue dirty, and the very next test in the process failed inside
  // an unrelated `createPrivateKey`.
  const password = "correct horse battery staple";
  const { packKey, wrapped } = handWrap({ params: { N: 32768, r: 8, p: 1 }, maxmem: 64 * 1024 * 1024, password });
  assert.deepEqual(await unwrapWithPassword(wrapped, password), packKey);
});

test("a key derivation this platform never wrote is refused by name before the primitive runs (review C-10)", async () => {
  // The header travels with the container, so a hostile sender signs a pack of their own whose password wrap asks for any
  // cost the old ceilings let through: N=2^18 at r=8 is 256 MiB and seconds of a pool thread, run on the one process-wide
  // slot, for every request of that sender. The platform has only ever written N=2^15, r=8, p=1, so that is all it opens.
  const originalSync = crypto.scryptSync;
  const originalAsync = crypto.scrypt;
  try {
    crypto.scryptSync = () => { throw new Error("A cost nobody wrote reached the primitive"); };
    crypto.scrypt = () => { throw new Error("A cost nobody wrote reached the primitive"); };
    syncBuiltinESMExports();
    for (const bad of [{ N: 262144, r: 8, p: 1 }, { N: 65536, r: 8, p: 1 }, { N: 16384, r: 8, p: 1 }, { N: 32768, r: 16, p: 1 }, { N: 32768, r: 8, p: 2 }, { N: 32768, r: 1, p: 1 }, { N: 131072, r: 16, p: 1 }, { N: 131072, r: 8, p: 4 }]) {
      await assert.rejects(
        async () => unwrapWithPassword(wrapWithHeader(bad), "correct horse battery staple"),
        (error) => error.code === "capsule_password_params_unsupported" && /not one this platform writes/.test(error.message),
        JSON.stringify(bad),
      );
    }
  } finally {
    crypto.scryptSync = originalSync; crypto.scrypt = originalAsync; syncBuiltinESMExports();
  }
});

test("a new password wrap is written at the cost OWASP asks of scrypt, and a pack written at the old cost still opens (review C-7)", async () => {
  const container = await packForBob({ password: "correct horse battery staple" });
  const headerLength = container.passwordWrap.readUInt16BE(0);
  const header = JSON.parse(container.passwordWrap.subarray(2, 2 + headerLength).toString("utf8"));
  // N=2^17 at r=8, p=1 is OWASP's first choice for scrypt: 128 MiB, about 0.3 s here, where 2^15 was 32 MiB.
  assert.deepEqual([header.N, header.r, header.p], [131072, 8, 1]);
  assert.ok(header.maxmem >= 128 * header.r * (header.N + header.p + 2), "the recorded limit covers the cost's whole working set");
  const keys = { issuer: { signingPublicKey: alice.signing.publicKey }, passwordWrap: container.passwordWrap, password: "correct horse battery staple" };
  assert.ok((await openCapsule(container, keys)).ok);

  // Every pack written before the change carries N=2^15. Re-wrap the same pack key at that cost and re-sign the manifest that
  // names the wrap, which is what such a pack is, and it opens to the same entries.
  const packKey = await unwrapWithPassword(container.passwordWrap, "correct horse battery staple");
  const { wrapped } = handWrap({ params: { N: 32768, r: 8, p: 1 }, maxmem: 96 * 1024 * 1024, password: "correct horse battery staple", packKey });
  const legacy = { manifest: structuredClone(container.manifest), payload: container.payload };
  legacy.manifest.encryption.passwordWrapSha256 = createHash("sha256").update(wrapped).digest("hex");
  legacy.manifest.signature.value = sign(null, Buffer.from(signablePayload(legacy.manifest)), createPrivateKey({ key: Buffer.from(alice.signing.privateKey, "base64"), type: "pkcs8", format: "der" })).toString("base64");
  const opened = await openCapsule(legacy, { ...keys, passwordWrap: wrapped });
  assert.ok(opened.ok, JSON.stringify(opened.issues ?? []));
  assert.equal(opened.entries["provenance.json"], entries[2].content);
});

test("a password wrap records the cost it used, so a later build can reproduce it", async () => {
  const container = await packForBob({ password: "correct horse battery staple" });
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

test("a header naming more memory than we will spend is refused, by its own name", async () => {
  // The header travels with the container, so N is the sender's choice and
  // scrypt allocates 128·N·r for it. Honoring N=2^30 faithfully is an
  // instruction to allocate 128 GiB — "someone sent me a file" becoming an
  // out-of-memory kill. The same rule as a model-supplied path: derive from
  // what arrived, then bound it.
  await assert.rejects(
    async () => unwrapWithPassword(wrapWithHeader({ N: 2 ** 30 }), "correct horse battery staple"),
    (error) => error.code === "capsule_password_params_unsupported" && /not one this platform writes/.test(error.message),
  );
  // The ceiling applies to the recorded number too, not only to what N implies.
  await assert.rejects(
    async () => unwrapWithPassword(wrapWithHeader({ maxmem: 128 * 1024 * 1024 * 1024 }), "correct horse battery staple"),
    (error) => error.code === "capsule_password_params_unsupported",
  );
});

test("a header whose scrypt parameters are not a usable set is refused before the primitive sees them", async () => {
  // scrypt needs N a power of two above one. Checked here so a malformed
  // header is refused by its own name rather than surfacing as an opaque
  // OpenSSL string a reader cannot act on.
  for (const bad of [{ N: 32769 }, { N: 0 }, { N: -1 }, { r: 0 }, { p: -4 }, { N: 1.5 }]) {
    await assert.rejects(
      async () => unwrapWithPassword(wrapWithHeader(bad), "correct horse battery staple"),
      (error) => error.code === "capsule_password_params_unsupported",
      JSON.stringify(bad),
    );
  }
});

test("a replaced password wrap is refused before its cost is processed", async () => {
  // The wrapping envelope is authenticated before its KDF parameters are used.
  const container = await packForBob({ password: "correct horse battery staple" });
  const opened = await openCapsule(container, {
    issuer: { signingPublicKey: alice.signing.publicKey },
    passwordWrap: wrapWithHeader({ N: 2 ** 30 }),
    password: "correct horse battery staple",
  });
  assert.equal(opened.ok, false);
  assert.equal(opened.issues[0].code, "capsule_password_wrap_invalid");
});

test("a plaintext export is still signed, because authorship is separate from secrecy", async () => {
  const container = await packCapsule({
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
  const opened = await openCapsule(container, { issuer: { signingPublicKey: alice.signing.publicKey } });
  assert.ok(opened.ok, JSON.stringify(opened.issues ?? []));
  assert.equal(opened.entries["methods/systematic-review/SKILL.md"], entries[1].content);
});

test("the version chain is carried, so a v8 can prove it came from a v7", async () => {
  const seven = await packForBob();
  const previous = seven.manifest;
  const eight = await packForBob({ version: 8, prevManifestSha256: "a".repeat(64) });
  assert.equal(eight.manifest.prevManifestSha256, "a".repeat(64));
  assert.notEqual(eight.manifest.merkleRoot, undefined);
  assert.equal(previous.version, 7);
});

test("executable content is refused at the boundary, not handled carefully later", async () => {
  const hostile = signedPlainContainer({
    capsuleId: "cap_mallory",
    version: 1,
    createdAt: "2026-08-23T00:00:00Z",
    issuer: { userId: "mallory", signingKeyId: mallory.signing.keyId, signingPrivateKey: mallory.signing.privateKey },
    scope: ["workstyle"],
    layers: ["methods", "knowledge"],
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

  const clean = checkImportSafety((await packForBob()).manifest);
  assert.equal(clean.ok, true, JSON.stringify(clean.issues));
});

test("a share that never includes the workstyle pack is not a share", async () => {
  const result = validateCapsuleManifest({ ...(await packForBob()).manifest, scope: ["+profile"] });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /workstyle/.test(issue.message)));
});

test("the source layer never leaves, whatever the scope says", async () => {
  const result = validateCapsuleManifest({
    ...(await packForBob()).manifest,
    entries: [{ path: "documents/patient-notes.pdf", sha256: "b".repeat(64), bytes: 10, mime: "application/pdf", layer: "sources" }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "capsule_restricted_content"));
});


// Deliberately bypass the packer to represent correctly signed hostile imports.
function signedPlainContainer({ entries: contentEntries, ...overrides }) {
  const hash = value => createHash("sha256").update(value).digest("hex");
  const manifestEntries = contentEntries.map(entry => ({ ...entry, content: undefined, bytes: Buffer.byteLength(entry.content), sha256: hash(entry.content) }));
  const manifest = {
    formatVersion: "1.0", capsuleId: "test-only-adversarial", version: 1, createdAt: "2026-09-05T00:00:00Z",
    issuer: { userId: "alice", signingKeyId: alice.signing.keyId }, scope: ["workstyle"],
    layers: ["profile", "methods", "episodes", "knowledge"], prevManifestSha256: null,
    ...overrides, entries: manifestEntries, merkleRoot: merkleRoot(manifestEntries, hash),
  };
  // An attacker can sign their own claims; the test key has no trusted identity.
  manifest.issuer = { userId: overrides.issuer?.userId ?? "alice", signingKeyId: alice.signing.keyId };
  manifest.signature = { alg: "ed25519", keyId: alice.signing.keyId, value: sign(null, Buffer.from(signablePayload(manifest)), createPrivateKey({ key: Buffer.from(alice.signing.privateKey, "base64"), type: "pkcs8", format: "der" })).toString("base64") };
  return { manifest, payload: Object.fromEntries(contentEntries.map(entry => [entry.path, Buffer.from(entry.content)])) };
}

test("password-only containers authenticate their wrapping metadata and roundtrip", async () => {
  const container = await packForBob({ recipients: [], password: "test-only-offline-placeholder" });
  assert.equal(container.manifest.encryption.scheme, "scrypt+aes-256-gcm");
  assert.match(container.manifest.encryption.passwordWrapSha256, /^[0-9a-f]{64}$/);
  assert.ok(validateCapsuleManifest(container.manifest).ok);
  const opened = await openCapsule(container, { issuer: { signingPublicKey: alice.signing.publicKey }, password: "test-only-offline-placeholder", passwordWrap: container.passwordWrap });
  assert.equal(opened.ok, true);
  assert.equal(opened.entries["provenance.json"], entries[2].content);
});

test("password KDF rejects unbounded work and malformed framing before derivation", async () => {
  // Intercept both primitives: a regression must fail without running hostile costs.
  const originalSync = crypto.scryptSync;
  const originalAsync = crypto.scrypt;
  try {
    crypto.scryptSync = () => { throw new Error("Hostile cost reached primitive"); };
    crypto.scrypt = () => { throw new Error("Hostile cost reached primitive"); };
    syncBuiltinESMExports();
    for (const bad of [{ p: 1024 }, { N: 262144, r: 8, p: 4 }, { kdf: "unknown" }, { salt: "" }]) {
      await assert.rejects(async () => unwrapWithPassword(wrapWithHeader(bad), "test-only-placeholder"), error => error.code === "capsule_password_params_unsupported");
    }
    await assert.rejects(async () => unwrapWithPassword(Buffer.alloc(1), "test-only-placeholder"), error => error.code === "capsule_password_wrap_invalid");
  } finally {
    crypto.scryptSync = originalSync; crypto.scrypt = originalAsync; syncBuiltinESMExports();
  }
});

test("password derivation is asynchronous and excess concurrent work is refused", async () => {
  let yielded = false;
  setImmediate(() => { yielded = true; });
  const first = packForBob({ password: "test-only-async-placeholder" });
  assert.ok(first instanceof Promise);
  await assert.rejects(packForBob({ password: "test-only-concurrent-placeholder" }), error => error.code === "capsule_password_busy");
  await first;
  assert.equal(yielded, true);
});

/**
 * Holds every `crypto.scrypt` result until the test lets it go, so who is running a derivation, and who is waiting for one,
 * is a state the test sets rather than a race it hopes to win. The real derivation still runs; only its callback waits.
 * @returns {{ started: string[], held: (() => void)[], release: (count?: number) => void, reached: (count: number) => Promise<void>, restore: () => void }}
 */
function holdScrypt() {
  const original = crypto.scrypt;
  /** @type {string[]} */ const started = [];
  /** @type {(() => void)[]} */ const held = [];
  crypto.scrypt = (...args) => {
    const callback = args.pop();
    started.push(String(args[0]));
    return original(...args, (error, key) => { held.push(() => callback(error, key)); });
  };
  syncBuiltinESMExports();
  return {
    started, held,
    release(count = 1) { for (const resume of held.splice(0, count)) resume(); },
    async reached(count) { for (let attempt = 0; attempt < 400 && held.length < count; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5)); assert.ok(held.length >= count, `${held.length} derivations are waiting, expected ${count}`); },
    // Whatever a failing test left held is let go, or its derivation would keep the process-wide slot from every later test.
    restore() { crypto.scrypt = original; syncBuiltinESMExports(); for (const resume of held.splice(0)) resume(); },
  };
}
/** Whether a promise has settled, without waiting for it. @param {Promise<unknown>} promise */
async function settledWithin(promise, ms = 40) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, ms));
  return settled;
}

test("a second account waits its turn for the derivation instead of being refused, and one account holds one place (review C-10)", async () => {
  const hold = holdScrypt();
  try {
    const first = packForBob({ password: "test-only-first-account", account: "acct-a" });
    await hold.reached(1);
    // The same account asking again is refused by name and takes nobody's place.
    await assert.rejects(packForBob({ password: "test-only-first-again", account: "acct-a" }),
      (error) => error.code === "capsule_password_busy" && error.reason === "account_busy");
    // Another account is not refused: it waits behind the first.
    const second = packForBob({ password: "test-only-second-account", account: "acct-b" });
    assert.equal(await settledWithin(second), false, "the second account is waiting, not refused");
    assert.deepEqual(hold.started, ["test-only-first-account"], "only one derivation runs at a time");
    hold.release();
    assert.ok((await first).passwordWrap);
    await hold.reached(1);
    assert.deepEqual(hold.started, ["test-only-first-account", "test-only-second-account"]);
    hold.release();
    assert.ok((await second).passwordWrap);
  } finally { hold.restore(); }
});

test("an account that keeps asking goes to the back of the line each time, so it cannot keep the others out (review C-10)", async () => {
  const hold = holdScrypt();
  try {
    const order = [];
    const request = (account) => packForBob({ password: `test-only-${account}`, account }).then((container) => { order.push(account); return container; });
    const a1 = request("acct-a");
    await hold.reached(1);
    const b = request("acct-b");
    const c = request("acct-c");
    // A is back at the door while its own derivation runs: refused, and B and C keep their places.
    await assert.rejects(request("acct-a"), (error) => error.code === "capsule_password_busy");
    hold.release();
    await a1;
    // A asks again the moment it is done: it queues behind B and C, not in front of them.
    const a2 = request("acct-a");
    await hold.reached(1);
    assert.deepEqual(hold.started, ["test-only-acct-a", "test-only-acct-b"], "B runs next, not A's second request");
    hold.release();
    await b;
    await hold.reached(1);
    assert.equal(hold.started.at(-1), "test-only-acct-c");
    hold.release();
    await c;
    await hold.reached(1);
    assert.equal(hold.started.at(-1), "test-only-acct-a");
    hold.release();
    await a2;
    assert.deepEqual(order, ["acct-a", "acct-b", "acct-c", "acct-a"]);
  } finally { hold.restore(); }
});

test("the gate's limits are the configuration's — derivations at once, the line and the wait — and the defaults are the ones it shipped with (review C4e)", async () => {
  const container = await import("../src/capsuleContainer.mjs");
  const { KDF_GATE_DEFAULTS } = await import("../src/capsuleKdfGate.mjs");
  assert.equal(typeof container.configurePasswordKdfGate, "function", "the limits are set from the deployment's configuration at start");
  assert.deepEqual(KDF_GATE_DEFAULTS, { concurrency: 1, maxWaiting: 6, maxWaitMs: 10_000 });
  assert.deepEqual(container.passwordKdfGateLimits(), KDF_GATE_DEFAULTS, "until it is, the limits the gate was built with");
  const hold = holdScrypt();
  try {
    // Two at once, and no line behind them: a third is told the line is full.
    container.configurePasswordKdfGate({ concurrency: 2, maxWaiting: 0, maxWaitMs: 10_000 });
    const a = packForBob({ password: "test-only-a", account: "acct-a" });
    const b = packForBob({ password: "test-only-b", account: "acct-b" });
    await hold.reached(2);
    assert.deepEqual(hold.started, ["test-only-a", "test-only-b"], "both run at once");
    await assert.rejects(packForBob({ password: "test-only-c", account: "acct-c" }), (error) => error.code === "capsule_password_busy" && error.reason === "queue_full");
    hold.release(2);
    await Promise.all([a, b]);
    // One at a time, a line of one, and a wait of 60 ms: the second account waits it out.
    container.configurePasswordKdfGate({ concurrency: 1, maxWaiting: 1, maxWaitMs: 60 });
    const first = packForBob({ password: "test-only-first", account: "acct-a" });
    await hold.reached(1);
    await assert.rejects(packForBob({ password: "test-only-second", account: "acct-b" }), (error) => error.code === "capsule_password_busy" && error.reason === "waited_out");
    hold.release();
    await first;
    // A value that is no limit leaves the limit as it was.
    container.configurePasswordKdfGate({ concurrency: 0, maxWaiting: -1, maxWaitMs: Number.NaN });
    assert.deepEqual(container.passwordKdfGateLimits(), { concurrency: 1, maxWaiting: 1, maxWaitMs: 60 });
  } finally { hold.restore(); container.configurePasswordKdfGate(KDF_GATE_DEFAULTS); }
  assert.deepEqual(container.passwordKdfGateLimits(), KDF_GATE_DEFAULTS);
});

test("workstyle scope cannot smuggle optional profile and knowledge entries", async () => {
  for (const [path, layer] of [["profile.md", "profile"], ["knowledge/chunks.jsonl", "knowledge"], ["documents/private.txt", "knowledge"]]) {
    const contentEntries = [{ path, layer, mime: "text/plain", content: "test-only-private-content" }];
    const hostile = signedPlainContainer({ entries: contentEntries });
    assert.equal(validateCapsuleManifest(hostile.manifest).ok, false);
    assert.equal((await openCapsule(hostile, { issuer: { signingPublicKey: alice.signing.publicKey } })).ok, false);
    await assert.rejects(packForBob({ entries: contentEntries, layers: [layer] }), error => error.code === "capsule_scope_violation");
  }
  const allowed = await packForBob({ scope: ["workstyle", "+profile"], entries: [{ path: "profile.md", layer: "profile", mime: "text/markdown", content: "Permitted profile." }] });
  assert.ok(validateCapsuleManifest(allowed.manifest).ok);
});

test("opening enforces content safety even for a correctly signed payload", async () => {
  const hostile = signedPlainContainer({ entries: [{ path: "methods/run.py", layer: "methods", mime: "text/x-python", content: "pass" }] });
  const opened = await openCapsule(hostile, { issuer: { signingPublicKey: alice.signing.publicKey } });
  assert.equal(opened.ok, false);
  assert.ok(opened.issues.some(issue => issue.code === "capsule_executable_content"));
});

test("manifest key claims must match the actual Ed25519 fingerprint", async () => {
  const hostile = signedPlainContainer({ entries });
  hostile.manifest.issuer.signingKeyId = mallory.signing.keyId;
  hostile.manifest.signature.value = sign(null, Buffer.from(signablePayload(hostile.manifest)), createPrivateKey({ key: Buffer.from(alice.signing.privateKey, "base64"), type: "pkcs8", format: "der" })).toString("base64");
  assert.equal(verifyCapsule(hostile, { signingPublicKey: alice.signing.publicKey }).ok, false);
  await assert.rejects(packForBob({ issuer: { userId: "alice", signingKeyId: mallory.signing.keyId, signingPrivateKey: alice.signing.privateKey } }), error => error.code === "capsule_signature_invalid");
  assert.doesNotThrow(() => verifyCapsule(signedPlainContainer({ entries }), { signingPublicKey: "invalid-test-only-key" }));
});

test("legacy recipient encryption remains readable without password metadata", async () => {
  const container = await packForBob();
  container.manifest.formatVersion = "1.0";
  container.manifest.signature.value = sign(null, Buffer.from(signablePayload(container.manifest)), createPrivateKey({ key: Buffer.from(alice.signing.privateKey, "base64"), type: "pkcs8", format: "der" })).toString("base64");
  const opened = await openCapsule(container, { issuer: { signingPublicKey: alice.signing.publicKey }, recipient: { encKeyId: bob.encryption.keyId, privateKey: bob.encryption.privateKey, publicKey: bob.encryption.publicKey } });
  assert.equal(opened.ok, true);
});


test("legacy recipient archives reject unsigned password wraps but still open with their recipient key", async () => {
  const container = await packForBob({ password: "test-only-legacy-placeholder" });
  delete container.manifest.encryption.passwordWrapSha256;
  container.manifest.formatVersion = "1.0";
  container.manifest.signature.value = sign(null, Buffer.from(signablePayload(container.manifest)), createPrivateKey({ key: Buffer.from(alice.signing.privateKey, "base64"), type: "pkcs8", format: "der" })).toString("base64");
  const untrustedPassword = await openCapsule(container, { issuer: { signingPublicKey: alice.signing.publicKey }, passwordWrap: container.passwordWrap, password: "test-only-legacy-placeholder" });
  assert.equal(untrustedPassword.ok, false);
  assert.equal(untrustedPassword.issues[0].code, "capsule_password_wrap_unauthenticated");
  const recipient = await openCapsule(container, { issuer: { signingPublicKey: alice.signing.publicKey }, recipient: { encKeyId: bob.encryption.keyId, privateKey: bob.encryption.privateKey, publicKey: bob.encryption.publicKey } });
  assert.equal(recipient.ok, true);
});

test("caller identity claims are not promoted to trusted authorship", async () => {
  const container = await packForBob({ issuer: { userId: "unverified-claim", signingKeyId: alice.signing.keyId, signingPrivateKey: alice.signing.privateKey } });
  // This only proves that this key signed the claim. A service must bind the
  // public key to a user through its own registry before labeling authorship.
  assert.equal(verifyCapsule(container, { signingPublicKey: alice.signing.publicKey }).ok, true);
  await assert.rejects(packForBob({ recipients: [{ encKeyId: "incorrect-test-only-id", publicKey: bob.encryption.publicKey }] }), error => error.code === "capsule_key_invalid");
  await assert.rejects(packForBob({ password: "" }), error => error.code === "capsule_password_wrap_invalid");
});

test("import supports only explicit UTF-8 text formats and matching MIME types", async () => {
  // Inside the paths a share is made of, a file in a format that does something by itself, or whose MIME type is not its format's, is refused.
  for (const [path, mime, scope] of [
    ["standards.jsonl", "application/javascript", ["workstyle"]], ["provenance.json", "text/x-python", ["workstyle"]],
    ["profile.md", "application/pdf", ["workstyle", "+profile"]], ["knowledge/chunks.jsonl", "application/x-sh", ["workstyle", "+knowledge"]],
    ["methods/tool/SKILL.md", "application/javascript", ["workstyle"]], ["methods/run.py", "text/x-python", ["workstyle"]],
  ]) {
    const hostile = signedPlainContainer({ scope, entries: [{ path, mime, layer: "methods", content: "Synthetic unsupported content." }] });
    assert.equal(checkImportSafety(hostile.manifest).ok, false, path);
    const opened = await openCapsule(hostile, { issuer: { signingPublicKey: alice.signing.publicKey } });
    assert.equal(opened.ok, false, path);
    assert.ok(opened.issues.some(issue => issue.code === "capsule_executable_content"), path);
  }
  for (const [path, mime, scope, layer] of [
    ["standards.jsonl", "application/x-ndjson", ["workstyle"], "profile"], ["provenance.json", "application/json", ["workstyle"], "methods"],
    ["methods/tool/SKILL.md", "text/markdown", ["workstyle"], "methods"], ["profile.md", "text/markdown", ["workstyle", "+profile"], "profile"],
    ["knowledge/chunks.jsonl", "application/x-ndjson", ["workstyle", "+knowledge"], "knowledge"],
  ]) {
    const allowed = signedPlainContainer({ scope, entries: [{ path, mime, layer, content: "Synthetic supported text." }] });
    assert.ok(checkImportSafety(allowed.manifest).ok, path);
    assert.ok((await openCapsule(allowed, { issuer: { signingPublicKey: alice.signing.publicKey } })).ok, path);
  }
});

// The paths the old format spoke of — a lessons file, exemplars, a timeline, claims, whole documents — were never written by a share, and
// the table that let a manifest declare them was looser than the transfer service that refuses them (2026-10-23): the validator now holds
// exactly the files a share is made of, and a scope the transfer service does not accept is not a scope.
test("a container declares only the paths and scopes a share is made of", async () => {
  for (const path of ["lessons.jsonl", "exemplars/note.md", "timeline.jsonl", "knowledge/claims.jsonl", "documents/table.csv"]) {
    const hostile = signedPlainContainer({ entries: [{ path, mime: "text/plain", layer: "methods", content: "Synthetic text." }] });
    assert.ok(validateCapsuleManifest(hostile.manifest).issues.some(issue => issue.code === "capsule_scope_violation"), path);
    assert.equal((await openCapsule(hostile, { issuer: { signingPublicKey: alice.signing.publicKey } })).ok, false, path);
    await assert.rejects(packForBob({ entries: [{ path, mime: "text/plain", layer: "methods", content: "Synthetic text." }] }), error => error.code === "capsule_scope_violation", path);
  }
  const documents = signedPlainContainer({ scope: ["workstyle", "+documents"], entries: [{ path: "documents/table.csv", mime: "text/csv", layer: "knowledge", content: "a,b" }] });
  assert.ok(validateCapsuleManifest(documents.manifest).issues.some(issue => /unknown share scope "\+documents"/.test(issue.message)));
});

test("an extension that is also a property of every object is a file name like any other, not a crash (review C-12)", async () => {
  // The format table was looked up with `formats[extension]`, which for `.constructor` answers Object itself.
  for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf", "prototype"]) {
    const path = `methods/note.${name}`;
    const manifest = signedPlainContainer({ scope: ["workstyle"], entries: [{ path, mime: "text/plain", layer: "methods", content: "Synthetic text." }] }).manifest;
    let safety;
    assert.doesNotThrow(() => { safety = checkImportSafety(manifest); }, path);
    assert.equal(safety.ok, false, path);
    assert.equal(safety.issues[0].code, "capsule_executable_content", path);
  }
  // Opening it is the same answer: a refusal that names the entry.
  const hostile = signedPlainContainer({ scope: ["workstyle"], entries: [{ path: "methods/note.constructor", mime: "text/plain", layer: "methods", content: "Synthetic text." }] });
  const opened = await openCapsule(hostile, { issuer: { signingPublicKey: alice.signing.publicKey } });
  assert.equal(opened.ok, false);
  assert.ok(opened.issues.some((issue) => issue.code === "capsule_executable_content"));
});

// 2026-09-26 audit (M-6): a pack had no card — the recipient named it and could
// not see who sent it. The card rides inside the signed manifest.
test("a pack's card is signed with it: what the recipient reads first is what the sender signed", async () => {
  const card = { title: "Alice 的工作方式", author: "Alice", summary: "1 条做法、1 条工作偏好", changelog: "新增 1 条" };
  const container = await packForBob({ card });
  assert.deepEqual(container.manifest.card, card);
  assert.ok(validateCapsuleManifest(container.manifest).ok);
  assert.ok(verifyCapsule(container, { signingPublicKey: alice.signing.publicKey }).ok);
  const forged = { ...container, manifest: { ...container.manifest, card: { ...card, author: "Mallory" } } };
  assert.deepEqual(verifyCapsule(forged, { signingPublicKey: alice.signing.publicKey }).issues.map((issue) => issue.code), ["capsule_signature_invalid"]);
  for (const bad of [{ title: 7 }, { owner: "x" }, { summary: "x".repeat(501) }, "a card"]) {
    assert.equal(validateCapsuleManifest({ ...container.manifest, card: bad }).ok, false, JSON.stringify(bad));
  }
});
