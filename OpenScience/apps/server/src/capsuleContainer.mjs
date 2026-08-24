/**
 * Packing, verifying and opening a `.evimedcap` container.
 *
 * Hidden knowledge: the cryptography, and — just as important — the honest
 * limits of it.
 *
 * What the scheme does. A fresh 256-bit pack key encrypts every payload entry
 * with AES-256-GCM, with the entry's path and the Merkle root bound in as
 * additional data so a valid entry cannot be moved to a different path or into
 * a different container. The pack key is wrapped once per recipient: an
 * ephemeral X25519 key agreement, HKDF-SHA256 to a wrapping key, AES-256-GCM to
 * wrap. The manifest is signed with Ed25519 over its RFC 8785 canonical bytes.
 *
 * What it therefore solves: a leaked backup or object store is useless without
 * the keys; an intercepted share is useless to anyone but its named recipients;
 * a container claiming to be someone's work can be checked against their
 * published signing key; and a single changed byte fails verification.
 *
 * What it does not solve, stated plainly because a security note that overstates
 * is worse than none: a recipient who decrypts can forward the plaintext, and no
 * cryptography prevents that — the reshare flag and the provenance stamps only
 * make it traceable afterwards. And the working copy inside our own boundary is
 * plaintext, because vector and full-text search cannot run on ciphertext; that
 * is managed by isolation, auditing and least privilege, not by pretending the
 * operator cannot read it.
 *
 * Every primitive is in Node's own `crypto`. No new dependency.
 *
 * @module capsuleContainer
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  scryptSync,
  sign as signBytes,
  timingSafeEqual,
  verify as verifyBytes,
} from "node:crypto";

import {
  CAPSULE_ENCRYPTION_SCHEME,
  CAPSULE_FORMAT_VERSION,
  CAPSULE_SIGNATURE_ALG,
  containerReadme,
  merkleRoot,
  signablePayload,
  validateCapsuleManifest,
} from "@evimed/domain";

/** Key sizes and the scheme's fixed parameters. */
const PACK_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HKDF_INFO = "evimedcap/v1/pack-key";
/** scrypt parameters for a password-wrapped copy. N=2^15 is ~100ms on a laptop. */
const SCRYPT_PARAMS = Object.freeze({ N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
/** The most a container's own header may ask us to allocate to open it.
 *  Generous next to the 32 MiB this build wraps with — an older or deliberately
 *  expensive container still opens — and far under what a hostile header would
 *  name. */
const MAX_PASSWORD_KDF_BYTES = 1024 * 1024 * 1024;

/** @param {string | Buffer | Uint8Array} input @returns {string} */
function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * A fresh identity: one signing pair and one encryption pair.
 *
 * They are separate keys on purpose. A single key used for both would mean
 * proving authorship and receiving a share are the same capability, so
 * revoking one revokes the other, and a compromise of either is a compromise of
 * both.
 *
 * @returns {{ signing: { keyId: string, publicKey: string, privateKey: string }, encryption: { keyId: string, publicKey: string, privateKey: string } }}
 */
export function generateCapsuleIdentity() {
  const signing = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("x25519");
  const exportPair = (pair) => {
    const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    return {
      // The key id is the fingerprint of the public key, so it is verifiable
      // rather than assigned: a directory cannot quietly point one id at a
      // different key.
      keyId: sha256Hex(Buffer.from(publicKey, "base64")).slice(0, 32),
      publicKey,
      privateKey: pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    };
  };
  return { signing: exportPair(signing), encryption: exportPair(encryption) };
}

/** @param {string} base64 @returns {import("node:crypto").KeyObject} */
function publicKeyFrom(base64) {
  return createPublicKey({ key: Buffer.from(base64, "base64"), type: "spki", format: "der" });
}

/** @param {string} base64 @returns {import("node:crypto").KeyObject} */
function privateKeyFrom(base64) {
  return createPrivateKey({ key: Buffer.from(base64, "base64"), type: "pkcs8", format: "der" });
}

/**
 * @typedef {object} PlainEntry
 * @property {string} path       relative path inside payload/
 * @property {string} content    the plaintext
 * @property {string} mime
 * @property {string} layer
 */

/**
 * @typedef {object} PackedContainer
 * @property {import("@evimed/domain").CapsuleManifest} manifest
 * @property {Record<string, Buffer>} payload   path -> ciphertext (nonce ‖ ct ‖ tag)
 * @property {string} readme
 * @property {Buffer | null} passwordWrap
 */

/**
 * Packs a container.
 *
 * @param {{
 *   capsuleId: string,
 *   version: number,
 *   createdAt: string,
 *   issuer: { userId: string, signingKeyId: string, signingPrivateKey: string },
 *   scope: readonly string[],
 *   layers: readonly string[],
 *   entries: readonly PlainEntry[],
 *   recipients?: readonly { encKeyId: string, publicKey: string }[],
 *   prevManifestSha256?: string | null,
 *   license?: string,
 *   attribution?: string,
 *   password?: string,
 * }} input
 * @returns {PackedContainer}
 */
export function packCapsule(input) {
  const manifestEntries = input.entries.map((entry) => ({
    path: entry.path,
    sha256: sha256Hex(entry.content),
    bytes: Buffer.byteLength(entry.content, "utf8"),
    mime: entry.mime,
    layer: entry.layer,
  }));
  const root = merkleRoot(manifestEntries, sha256Hex);

  const encrypt = Boolean(input.recipients?.length) || Boolean(input.password);
  const packKey = encrypt ? randomBytes(PACK_KEY_BYTES) : null;

  /** @type {Record<string, Buffer>} */
  const payload = {};
  for (const entry of input.entries) {
    payload[entry.path] = packKey
      ? sealEntry(packKey, entry.path, root, Buffer.from(entry.content, "utf8"))
      : Buffer.from(entry.content, "utf8");
  }

  /** @type {import("@evimed/domain").CapsuleManifest} */
  const manifest = {
    formatVersion: CAPSULE_FORMAT_VERSION,
    capsuleId: input.capsuleId,
    version: input.version,
    createdAt: input.createdAt,
    issuer: { userId: input.issuer.userId, signingKeyId: input.issuer.signingKeyId },
    scope: [...input.scope],
    layers: [...input.layers],
    ...(input.license ? { license: input.license } : {}),
    ...(input.attribution ? { attribution: input.attribution } : {}),
    entries: manifestEntries,
    merkleRoot: root,
    prevManifestSha256: input.prevManifestSha256 ?? null,
    ...(packKey && input.recipients?.length
      ? {
        encryption: {
          scheme: CAPSULE_ENCRYPTION_SCHEME,
          recipients: input.recipients.map((recipient) => wrapForRecipient(packKey, recipient)),
        },
      }
      : {}),
  };

  const signature = signBytes(null, Buffer.from(signablePayload(manifest), "utf8"), privateKeyFrom(input.issuer.signingPrivateKey));
  manifest.signature = { alg: CAPSULE_SIGNATURE_ALG, keyId: input.issuer.signingKeyId, value: signature.toString("base64") };

  return {
    manifest,
    payload,
    readme: containerReadme(manifest),
    passwordWrap: packKey && input.password ? wrapWithPassword(packKey, input.password) : null,
  };
}

/**
 * The AAD for one entry: `path` and `root` concatenated with no separator
 * that could ever appear ambiguously between them. A single-byte join (a
 * space, a null) relies on that byte never occurring inside either field —
 * true in practice for a hex Merkle root, not provably true for a path — so
 * two different (path, root) pairs could in principle produce the same AAD
 * bytes and defeat the one property this binding exists for. Length-prefixing
 * each field removes the assumption entirely: nothing about the fields'
 * content can make two distinct pairs collide.
 * @param {string} path @param {string} root
 * @returns {Buffer}
 */
function entryAad(path, root) {
  const pathBytes = Buffer.from(path, "utf8");
  const rootBytes = Buffer.from(root, "utf8");
  const header = Buffer.alloc(8);
  header.writeUInt32BE(pathBytes.length, 0);
  header.writeUInt32BE(rootBytes.length, 4);
  return Buffer.concat([header, pathBytes, rootBytes]);
}

/**
 * Encrypts one entry.
 *
 * The additional data binds the ciphertext to its path and to this container's
 * Merkle root, so a valid entry cannot be relocated within the container or
 * transplanted into another one — both of which a tag alone would permit.
 *
 * @param {Buffer} packKey @param {string} path @param {string} root @param {Buffer} plaintext
 * @returns {Buffer}
 */
function sealEntry(packKey, path, root, plaintext) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", packKey, nonce);
  cipher.setAAD(entryAad(path, root));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

/**
 * @param {Buffer} packKey @param {string} path @param {string} root @param {Buffer} sealed
 * @returns {Buffer}
 */
function openEntry(packKey, path, root, sealed) {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new Error("capsule entry is truncated");
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const body = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", packKey, nonce);
  decipher.setAAD(entryAad(path, root));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/**
 * Wraps the pack key for one recipient (HPKE-shaped: ephemeral X25519 to their
 * static key, HKDF to a wrapping key, AEAD to wrap).
 * @param {Buffer} packKey @param {{ encKeyId: string, publicKey: string }} recipient
 * @returns {{ encKeyId: string, ephemeralPub: string, wrappedPackKey: string }}
 */
function wrapForRecipient(packKey, recipient) {
  const ephemeral = generateKeyPairSync("x25519");
  const recipientKey = publicKeyFrom(recipient.publicKey);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientKey });
  const ephemeralPub = ephemeral.publicKey.export({ type: "spki", format: "der" });
  // Both public keys go into the salt so the derived key is bound to this exact
  // pair; a shared secret alone would be reusable across contexts.
  const salt = Buffer.concat([ephemeralPub, Buffer.from(recipient.publicKey, "base64")]);
  const wrappingKey = Buffer.from(hkdfSync("sha256", shared, salt, Buffer.from(HKDF_INFO, "utf8"), PACK_KEY_BYTES));
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey, nonce);
  const body = Buffer.concat([cipher.update(packKey), cipher.final()]);
  return {
    encKeyId: recipient.encKeyId,
    ephemeralPub: ephemeralPub.toString("base64"),
    wrappedPackKey: Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64"),
  };
}

/**
 * @param {import("@evimed/domain").CapsuleManifest} manifest
 * @param {{ encKeyId: string, privateKey: string, publicKey: string }} recipient
 * @returns {Buffer}
 */
function unwrapForRecipient(manifest, recipient) {
  const record = manifest.encryption?.recipients.find((entry) => entry.encKeyId === recipient.encKeyId);
  if (!record) throw new Error("this container is not addressed to that key");
  const ephemeralPub = Buffer.from(record.ephemeralPub, "base64");
  const shared = diffieHellman({
    privateKey: privateKeyFrom(recipient.privateKey),
    publicKey: createPublicKey({ key: ephemeralPub, type: "spki", format: "der" }),
  });
  const salt = Buffer.concat([ephemeralPub, Buffer.from(recipient.publicKey, "base64")]);
  const wrappingKey = Buffer.from(hkdfSync("sha256", shared, salt, Buffer.from(HKDF_INFO, "utf8"), PACK_KEY_BYTES));
  const sealed = Buffer.from(record.wrappedPackKey, "base64");
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const body = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", wrappingKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/**
 * A password-wrapped copy of the pack key, for opening a container offline.
 *
 * The salt and parameters travel with it so a future build can still open an
 * old container after the defaults move — hardcoding today's parameters is how
 * an archive becomes unopenable.
 *
 * @param {Buffer} packKey @param {string} password
 * @returns {Buffer}
 */
function wrapWithPassword(packKey, password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, PACK_KEY_BYTES, SCRYPT_PARAMS);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", derived, nonce);
  const body = Buffer.concat([cipher.update(packKey), cipher.final()]);
  const header = Buffer.from(JSON.stringify({ kdf: "scrypt", ...SCRYPT_PARAMS, salt: salt.toString("base64") }), "utf8");
  const headerLength = Buffer.alloc(2);
  headerLength.writeUInt16BE(header.length);
  return Buffer.concat([headerLength, header, nonce, body, cipher.getAuthTag()]);
}

/**
 * The cost parameters a container's own header asks us to run, checked before
 * we run them.
 *
 * `wrapWithPassword` writes N/r/p and `maxmem` into the header for a real
 * reason: scrypt's `maxmem` must cover whatever N/r/p it is asked to run, and a
 * build whose own default has since moved — larger or smaller — must still
 * honor the cost an *older* container was actually wrapped with rather than
 * substitute today's number for it.
 *
 * But the header travels with the container, so every one of those fields is
 * attacker-chosen. scrypt allocates 128·N·r bytes; a hostile header naming
 * N=2^30 is an instruction to allocate 128 GiB, and honoring it faithfully
 * would turn "someone sent me a file" into an out-of-memory kill. Deriving the
 * requirement and capping it is the whole point — the same rule as a
 * model-supplied path having to pass the write guard before it is written to.
 *
 * Refusal is a named code rather than a generic key failure: "this container
 * asks for more than we will spend" and "your password is wrong" are different
 * facts and a reader acts on them differently.
 *
 * @param {Record<string, any>} header
 * @returns {{ N: number, r: number, p: number, maxmem: number }}
 */
function passwordKdfCost(header) {
  const N = Number(header?.N);
  const r = Number(header?.r);
  const p = Number(header?.p);
  // scrypt requires N to be a power of two greater than one; r and p positive.
  // Checked here rather than left to the primitive so a malformed header is
  // refused by its own name instead of surfacing as an opaque OpenSSL string.
  const sane = [N, r, p].every((value) => Number.isSafeInteger(value) && value > 0)
    && N > 1 && (N & (N - 1)) === 0;
  if (!sane) throw capsuleParamsUnsupported(`scrypt parameters N=${header?.N} r=${header?.r} p=${header?.p} are not a usable set.`);
  const required = 128 * N * r;
  const maxmem = Number.isSafeInteger(header?.maxmem) && header.maxmem > 0 ? header.maxmem : SCRYPT_PARAMS.maxmem;
  if (required > MAX_PASSWORD_KDF_BYTES || maxmem > MAX_PASSWORD_KDF_BYTES) {
    throw capsuleParamsUnsupported(
      `this container asks for ${Math.round(Math.max(required, maxmem) / 1024 / 1024)} MiB to derive its key, above the ${MAX_PASSWORD_KDF_BYTES / 1024 / 1024} MiB ceiling.`,
    );
  }
  // The header's own number when it covers its own parameters; the derived
  // requirement when it does not, so an old container whose recorded ceiling
  // was too tight still opens rather than failing on a number it wrote itself.
  return { N, r, p, maxmem: Math.max(maxmem, required) };
}

/** @param {string} message @returns {Error & { code: string }} */
function capsuleParamsUnsupported(message) {
  const error = /** @type {Error & { code: string }} */ (new Error(message));
  error.code = "capsule_password_params_unsupported";
  return error;
}

/**
 * @param {Buffer} wrapped @param {string} password
 * @returns {Buffer}
 */
export function unwrapWithPassword(wrapped, password) {
  const headerLength = wrapped.readUInt16BE(0);
  const header = JSON.parse(wrapped.subarray(2, 2 + headerLength).toString("utf8"));
  const rest = wrapped.subarray(2 + headerLength);
  const derived = scryptSync(password, Buffer.from(header.salt, "base64"), PACK_KEY_BYTES, passwordKdfCost(header));
  const nonce = rest.subarray(0, NONCE_BYTES);
  const tag = rest.subarray(rest.length - TAG_BYTES);
  const body = rest.subarray(NONCE_BYTES, rest.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", derived, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/**
 * Verifies a container without opening it.
 *
 * The order matters and is deliberate: signature first, then the Merkle root,
 * then per-entry digests. Checking content before authorship means spending
 * work on a container nobody vouched for.
 *
 * @param {{ manifest: unknown, payload: Record<string, Buffer> }} container
 * @param {{ signingPublicKey: string }} issuer
 * @returns {{ ok: boolean, issues: { code: string, message: string }[] }}
 */
export function verifyCapsule(container, issuer) {
  const shape = validateCapsuleManifest(container.manifest);
  if (!shape.ok || !shape.manifest) return { ok: false, issues: shape.issues };
  const manifest = shape.manifest;

  /** @type {{ code: string, message: string }[]} */
  const issues = [];
  const signature = manifest.signature;
  if (!signature) {
    issues.push({ code: "capsule_unsigned", message: "the container carries no signature." });
  } else {
    const valid = verifyBytes(
      null,
      Buffer.from(signablePayload(manifest), "utf8"),
      publicKeyFrom(issuer.signingPublicKey),
      Buffer.from(signature.value, "base64"),
    );
    if (!valid) issues.push({ code: "capsule_signature_invalid", message: "the signature does not match the issuer's key." });
    const expectedKeyId = sha256Hex(Buffer.from(issuer.signingPublicKey, "base64")).slice(0, 32);
    if (signature.keyId !== expectedKeyId) {
      issues.push({ code: "capsule_signature_invalid", message: "the signature names a different key than the one offered." });
    }
  }

  const root = merkleRoot(manifest.entries, sha256Hex);
  if (root !== manifest.merkleRoot) {
    issues.push({ code: "capsule_tampered", message: "the entry list does not hash to the declared Merkle root." });
  }
  for (const entry of manifest.entries) {
    const sealed = container.payload[entry.path];
    if (!sealed) {
      issues.push({ code: "capsule_entry_missing", message: `payload/${entry.path} is named by the manifest and absent from the container.` });
      continue;
    }
    if (!manifest.encryption) {
      const digest = sha256Hex(sealed);
      if (!safeEqualHex(digest, entry.sha256)) {
        issues.push({ code: "capsule_tampered", message: `payload/${entry.path} does not match its declared digest.` });
      }
    }
  }
  const extra = Object.keys(container.payload).filter((path) => !manifest.entries.some((entry) => entry.path === path));
  for (const path of extra) {
    // An unlisted entry is not merely untidy: it is content that no digest and
    // no signature covers, sitting where a reader will assume both do.
    issues.push({ code: "capsule_unlisted_entry", message: `payload/${path} is in the container and not in the manifest.` });
  }
  return { ok: issues.length === 0, issues };
}

/** @param {string} left @param {string} right @returns {boolean} */
function safeEqualHex(left, right) {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

/**
 * Opens a verified container.
 *
 * Verification is not optional and not a separate call the caller might forget:
 * opening runs it first and refuses on any finding. "Decrypt now, check later"
 * is how unsigned content reaches a model.
 *
 * @param {{ manifest: unknown, payload: Record<string, Buffer> }} container
 * @param {{
 *   issuer: { signingPublicKey: string },
 *   recipient?: { encKeyId: string, privateKey: string, publicKey: string },
 *   passwordWrap?: Buffer,
 *   password?: string,
 * }} keys
 * @returns {{ ok: true, manifest: import("@evimed/domain").CapsuleManifest, entries: Record<string, string> } | { ok: false, issues: { code: string, message: string }[] }}
 */
export function openCapsule(container, keys) {
  const verified = verifyCapsule(container, keys.issuer);
  if (!verified.ok) return { ok: false, issues: verified.issues };
  const manifest = /** @type {import("@evimed/domain").CapsuleManifest} */ (container.manifest);

  /** @type {Buffer | null} */
  let packKey = null;
  if (manifest.encryption) {
    try {
      if (keys.recipient) packKey = unwrapForRecipient(manifest, keys.recipient);
      else if (keys.passwordWrap && keys.password) packKey = unwrapWithPassword(keys.passwordWrap, keys.password);
      else return { ok: false, issues: [{ code: "capsule_key_missing", message: "the container is encrypted and no key was offered." }] };
    } catch (error) {
      // A refused cost keeps its own code: "this container asks for more than
      // we will spend" is not "your key is wrong", and collapsing the two sends
      // the reader looking for a key problem that does not exist.
      if (error?.code === "capsule_password_params_unsupported") {
        return { ok: false, issues: [{ code: error.code, message: error.message }] };
      }
      return { ok: false, issues: [{ code: "capsule_key_invalid", message: `the offered key does not open this container: ${error?.message ?? error}` }] };
    }
  }

  /** @type {Record<string, string>} */
  const entries = {};
  for (const entry of manifest.entries) {
    const sealed = container.payload[entry.path];
    try {
      const plaintext = packKey ? openEntry(packKey, entry.path, manifest.merkleRoot, sealed) : sealed;
      if (!safeEqualHex(sha256Hex(plaintext), entry.sha256)) {
        return { ok: false, issues: [{ code: "capsule_tampered", message: `payload/${entry.path} does not match its declared digest.` }] };
      }
      entries[entry.path] = plaintext.toString("utf8");
    } catch (error) {
      return { ok: false, issues: [{ code: "capsule_tampered", message: `payload/${entry.path} could not be opened: ${error?.message ?? error}` }] };
    }
  }
  return { ok: true, manifest, entries };
}

/**
 * Content an imported container may never carry.
 *
 * The two pickle-shaped MemCube artifacts execute code on load, so they are
 * refused at the boundary rather than "handled carefully" downstream — a rule
 * that depends on every later reader remembering it is a rule that will be
 * forgotten once.
 */
export const REFUSED_IMPORT_PATHS = Object.freeze([
  "memos/activation_memory.pickle",
  "memos/parametric_memory.adapter",
]);

/**
 * @param {import("@evimed/domain").CapsuleManifest} manifest
 * @returns {{ ok: boolean, issues: { code: string, message: string }[] }}
 */
export function checkImportSafety(manifest) {
  /** @type {{ code: string, message: string }[]} */
  const issues = [];
  for (const entry of manifest.entries) {
    if (REFUSED_IMPORT_PATHS.includes(entry.path) || /\.(pickle|adapter|so|dll|dylib|exe|sh|py|js|mjs)$/i.test(entry.path)) {
      issues.push({ code: "capsule_executable_content", message: `payload/${entry.path} is executable content and is refused; a capsule carries text.` });
    }
    if (entry.path.startsWith("methods/") && !entry.path.endsWith("SKILL.md")) {
      issues.push({ code: "capsule_method_shape_invalid", message: `payload/${entry.path} is under methods/ and is not a SKILL.md.` });
    }
  }
  return { ok: issues.length === 0, issues };
}
