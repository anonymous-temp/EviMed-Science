import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { generateCapsuleIdentity } from "./capsuleContainer.mjs";
import { HttpError } from "./security.mjs";
import { productId } from "./productPersistence.mjs";

function unavailable() { return new HttpError(503, "capsule_identity_unavailable", "Protected capsule storage is unavailable."); }

/** Only control-plane dataDir children: never pass a project/workspace directory. */
export async function protectedCapsuleDirectory(dataDir, name) {
  if (!path.isAbsolute(dataDir) || !["capsule-keys", "capsule-snapshots", "capsule-revocations"].includes(name)) throw unavailable();
  const parent = await fs.lstat(dataDir);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw unavailable();
  const directory = path.join(dataDir, name);
  await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw unavailable(); });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || (process.getuid && info.uid !== process.getuid())) throw unavailable();
  return directory;
}

export async function readProtectedCapsuleFile(directory, name, maxBytes) {
  if (!/^[a-zA-Z0-9_-]+\.(?:json|evimedcap)$/.test(name)) throw unavailable();
  let handle;
  try {
    handle = await fs.open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > maxBytes || (process.getuid && info.uid !== process.getuid())) throw unavailable();
    return await handle.readFile({ encoding: "utf8" });
  } catch (error) { if (error.code === "ENOENT") return null; throw unavailable(); }
  finally { await handle?.close(); }
}

/** Publish immutable bytes atomically, so concurrent creators never read a partial key file. */
export async function writeProtectedCapsuleFile(directory, name, content) {
  if (!/^[a-zA-Z0-9_-]+\.(?:json|evimedcap)$/.test(name)) throw unavailable();
  const temporary = path.join(directory, `${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(content, "utf8"); await handle.sync(); await handle.close(); handle = null;
    await fs.link(temporary, path.join(directory, name));
    await syncCapsuleDirectory(directory);
    return true;
  } catch (error) { if (error.code === "EEXIST") return false; throw unavailable(); }
  finally { await handle?.close(); await fs.unlink(temporary).catch(() => {}); }
}

/** Private identities and local issuer bindings stay outside user/project mounts. */
export class CapsuleIdentityStore {
  constructor(dataDir) { this.dataDir = path.resolve(dataDir); }

  async forUser(userId, { accountCreatedAt = null } = {}) {
    productId(userId, "user");
    await this.assertAccountActive(userId, accountCreatedAt);
    const directory = await protectedCapsuleDirectory(this.dataDir, "capsule-keys");
    const name = `account-${createHash("sha256").update(userId).digest("hex")}.json`;
    let content = await readProtectedCapsuleFile(directory, name, 16 * 1024);
    if (!content) {
      const identity = { issuerId: `issuer-${randomUUID()}`, ...generateCapsuleIdentity() };
      await writeProtectedCapsuleFile(directory, name, JSON.stringify(identity));
      content = await readProtectedCapsuleFile(directory, name, 16 * 1024);
    }
    let identity;
    try { identity = JSON.parse(content); } catch { throw unavailable(); }
    if (!/^issuer-[a-f0-9-]{36}$/.test(identity?.issuerId) || !/^[a-f0-9]{32}$/.test(identity?.signing?.keyId)
      || typeof identity.signing.privateKey !== "string" || typeof identity.signing.publicKey !== "string") throw unavailable();
    const binding = { ownerId: userId, issuerId: identity.issuerId, keyId: identity.signing.keyId, publicKey: identity.signing.publicKey };
    await writeProtectedCapsuleFile(directory, `issuer-${binding.keyId}.json`, JSON.stringify(binding));
    const stored = await this.resolve(binding.issuerId, binding.keyId);
    if (!stored || stored.ownerId !== userId || stored.publicKey !== binding.publicKey) throw unavailable();
    return identity;
  }

  async resolve(issuerId, keyId) {
    if (typeof issuerId !== "string" || !/^[a-f0-9]{32}$/.test(keyId)) return null;
    const revokedDirectory = await protectedCapsuleDirectory(this.dataDir, "capsule-revocations");
    const revokedContent = await readProtectedCapsuleFile(revokedDirectory, `issuer-${keyId}.json`, 4096);
    if (revokedContent) {
      const binding = JSON.parse(revokedContent);
      return binding.issuerId === issuerId && binding.keyId === keyId ? binding : null;
    }
    const directory = await protectedCapsuleDirectory(this.dataDir, "capsule-keys");
    const content = await readProtectedCapsuleFile(directory, `issuer-${keyId}.json`, 4096);
    if (!content) return null;
    let binding;
    try { binding = JSON.parse(content); } catch { throw unavailable(); }
    if (binding.issuerId !== issuerId || binding.keyId !== keyId) return null;
    if (typeof binding.ownerId !== "string" || typeof binding.publicKey !== "string") throw unavailable();
    return binding;
  }

  async deletionState(userId) {
    const directory = await protectedCapsuleDirectory(this.dataDir, "capsule-revocations");
    const content = await readProtectedCapsuleFile(directory, `account-${capsuleAccountHash(userId)}.json`, 8192);
    return content ? JSON.parse(content) : null;
  }

  async assertAccountActive(userId, accountCreatedAt = null) {
    const state = await this.deletionState(userId);
    if (state?.phase === "pending") throw new HttpError(409, "capsule_account_deleting", "Account deletion is pending; retry deletion before creating capsule data.");
    if (state && (accountCreatedAt === null || state.accountCreatedAt === accountCreatedAt)) {
      throw new HttpError(409, "product_account_changed", "The account changed before this operation completed.");
    }
  }

  /** Only called while the control-plane account advisory lock is held. Keeps private keys until DB commit. */
  async prepareDeletion(userId, accountCreatedAt) {
    const previous = await this.deletionState(userId);
    if (previous?.phase === "pending" && previous.accountCreatedAt === accountCreatedAt) return previous;
    const keys = await protectedCapsuleDirectory(this.dataDir, "capsule-keys");
    const content = await readProtectedCapsuleFile(keys, `account-${capsuleAccountHash(userId)}.json`, 16384);
    const identity = content ? JSON.parse(content) : null;
    const state = { phase: "pending", userId, accountCreatedAt,
      binding: identity ? { issuerId: identity.issuerId, keyId: identity.signing.keyId, publicKey: identity.signing.publicKey, revoked: true } : null };
    const directory = await protectedCapsuleDirectory(this.dataDir, "capsule-revocations");
    await replaceProtectedCapsuleFile(directory, `account-${capsuleAccountHash(userId)}.json`, JSON.stringify(state));
    return state;
  }

  /** Retain only public revocation evidence after removing both the private identity and owner binding. */
  async finishDeletion(userId, state) {
    const revoked = await protectedCapsuleDirectory(this.dataDir, "capsule-revocations");
    const keys = await protectedCapsuleDirectory(this.dataDir, "capsule-keys");
    if (state.binding) {
      await writeProtectedCapsuleFile(revoked, `issuer-${state.binding.keyId}.json`, JSON.stringify(state.binding));
      await unlinkCapsuleFile(keys, `issuer-${state.binding.keyId}.json`);
    }
    // Remove every historical owner binding, including a key retained after a
    // previous local key rotation; retain only its public revocation evidence.
    const files = await fs.opendir(keys);
    for await (const file of files) {
      if (!/^issuer-[a-f0-9]{32}\.json$/.test(file.name)) continue;
      const content = await readProtectedCapsuleFile(keys, file.name, 4096);
      const binding = content ? JSON.parse(content) : null;
      if (binding?.ownerId !== userId) continue;
      await writeProtectedCapsuleFile(revoked, file.name, JSON.stringify({ issuerId: binding.issuerId, keyId: binding.keyId, publicKey: binding.publicKey, revoked: true }));
      await unlinkCapsuleFile(keys, file.name);
    }
    await unlinkCapsuleFile(keys, `account-${capsuleAccountHash(userId)}.json`);
    await replaceProtectedCapsuleFile(revoked, `account-${capsuleAccountHash(userId)}.json`, JSON.stringify({ phase: "completed", accountCreatedAt: state.accountCreatedAt }));
  }

  async pendingDeletions() {
    const directory = await protectedCapsuleDirectory(this.dataDir, "capsule-revocations");
    const result = [];
    const files = await fs.opendir(directory);
    for await (const file of files) {
      if (!/^account-[a-f0-9]{64}\.json$/.test(file.name)) continue;
      const content = await readProtectedCapsuleFile(directory, file.name, 8192);
      const state = content ? JSON.parse(content) : null;
      if (state?.phase === "pending" && typeof state.userId === "string" && file.name === `account-${capsuleAccountHash(state.userId)}.json`) result.push(state.userId);
    }
    return result;
  }

}


export function capsuleAccountHash(userId) { return createHash("sha256").update(productId(userId, "user")).digest("hex"); }

export async function unlinkCapsuleFile(directory, name) {
  if (!/^[a-zA-Z0-9_-]+\.(?:json|evimedcap)$/.test(name)) throw unavailable();
  await fs.unlink(path.join(directory, name)).catch(error => { if (error.code !== "ENOENT") throw error; });
}

/** Atomic, durable replacement for deletion state only; never used to replace identity keys. */
async function replaceProtectedCapsuleFile(directory, name, content) {
  if (!/^account-[a-f0-9]{64}\.json$/.test(name)) throw unavailable();
  const temporary = `${randomUUID()}.json`;
  await writeProtectedCapsuleFile(directory, temporary, content);
  try { await fs.rename(path.join(directory, temporary), path.join(directory, name)); await syncCapsuleDirectory(directory); }
  finally { await unlinkCapsuleFile(directory, temporary); }
}

async function syncCapsuleDirectory(directory) {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
