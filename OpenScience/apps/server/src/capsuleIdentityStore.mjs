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
  if (!path.isAbsolute(dataDir) || !["capsule-keys", "capsule-snapshots"].includes(name)) throw unavailable();
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
    return true;
  } catch (error) { if (error.code === "EEXIST") return false; throw unavailable(); }
  finally { await handle?.close(); await fs.unlink(temporary).catch(() => {}); }
}

/** Private identities and local issuer bindings stay outside user/project mounts. */
export class CapsuleIdentityStore {
  constructor(dataDir) { this.dataDir = path.resolve(dataDir); }

  async forUser(userId) {
    productId(userId, "user");
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
    const directory = await protectedCapsuleDirectory(this.dataDir, "capsule-keys");
    const content = await readProtectedCapsuleFile(directory, `issuer-${keyId}.json`, 4096);
    if (!content) return null;
    let binding;
    try { binding = JSON.parse(content); } catch { throw unavailable(); }
    if (binding.issuerId !== issuerId || binding.keyId !== keyId) return null;
    if (typeof binding.ownerId !== "string" || typeof binding.publicKey !== "string") throw unavailable();
    return binding;
  }
}
