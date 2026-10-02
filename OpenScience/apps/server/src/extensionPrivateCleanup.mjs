import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { HttpError, openScopedDirectoryNoFollow } from "./security.mjs";

/** Called only by the durable account-deletion recovery, after its account
 * transaction committed and while the account admission lock is held.
 * Fixed namespaces only: no customer pathname is accepted.
 * @param {string} dataDir @param {string} userId */
export async function removePrivateExtensionFiles(dataDir, userId) {
  if (typeof userId !== "string" || !userId || userId.length > 128) throw new HttpError(400, "extension_contract_invalid", "Invalid account cleanup identity.");
  const owner = createHash("sha256").update(userId).digest("hex");
  let visited = 0;
  const remove = async (directory, name, depth) => {
    if (++visited > 100000 || depth > 24) throw new HttpError(413, "project_scan_too_large", "Private extension cleanup remains pending.");
    const target = path.join(directory, name);
    let before;
    try { before = await fs.lstat(target); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (!before.isDirectory() || before.isSymbolicLink()) {
      // Unlinking a link never follows or modifies its target.
      await fs.unlink(target); return;
    }
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino) throw new HttpError(403, "path_forbidden", "Private extension cleanup entry changed.");
      const anchored = process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : target;
      for (const entry of await fs.readdir(anchored)) await remove(anchored, entry, depth + 1);
      await handle.sync();
      const current = await fs.lstat(target);
      if (current.dev !== opened.dev || current.ino !== opened.ino) throw new HttpError(403, "path_forbidden", "Private extension cleanup entry changed.");
      await fs.rmdir(target);
    } finally { await handle.close(); }
  };
  for (const namespace of ["skill-library", "personal-skill-generations"]) {
    let parent;
    try { parent = await openScopedDirectoryNoFollow(dataDir, path.join(dataDir, ".openscience", namespace)); }
    catch (error) { if (["ENOENT", "file_not_found"].includes(error.code)) continue; throw error; }
    try { await remove(parent.path, owner, 0); await parent.handle.sync(); } finally { await parent.handle.close(); }
  }
}
