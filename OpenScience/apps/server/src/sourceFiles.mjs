import { constants } from "node:fs";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { HttpError, openScopedDirectoryNoFollow } from "./security.mjs";

/** An opaque copy namespace, never the lease credential itself. @param {any} job */
export function sourceAttemptId(job) {
  if (typeof job?.leaseToken !== "string" || !job.leaseToken) throw new HttpError(400, "source_job_invalid", "A source copy requires a lease identity.");
  return createHash("sha256").update(job.leaseToken).digest("hex").slice(0, 24);
}

/** Remove only service-owned source copies. Every recursive parent remains
 * open, so replacing an ancestor with a symlink cannot redirect deletion.
 * generation restricts abandoned-job cleanup to its own copy; originals and
 * other attempts remain outside the deletion inventory.
 * @param {{projectRoot:string,sourceId:string,jobIds:string[],parserStagingRoot?:string,generation?:number,attemptId?:string,stagingOnly?:boolean}} input */
export async function removeSourceCopies({ projectRoot, sourceId, jobIds, parserStagingRoot = "", generation, attemptId, stagingOnly = false }) {
  if (!/^src_[a-f0-9]{32}$/.test(sourceId) || !Array.isArray(jobIds) || jobIds.length > 10000
    || jobIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(id))) {
    throw new HttpError(400, "source_cleanup_path_invalid", "Source cleanup identity is invalid.");
  }
  if (generation !== undefined ? !Number.isSafeInteger(generation) || generation < 1 || !/^[a-f0-9]{24}$/.test(attemptId ?? "")
    : attemptId !== undefined || stagingOnly) throw new HttpError(400, "source_cleanup_path_invalid", "Source cleanup attempt is invalid.");
  if (process.platform !== "linux") throw new HttpError(503, "source_cleanup_platform_unsupported", "Source copy deletion requires descriptor-relative filesystem support.");
  let visited = 0;
  /** @param {string} parent @param {string} name @param {number} depth */
  async function remove(parent, name, depth) {
    if (++visited > 10000 || depth > 32) throw new HttpError(413, "source_cleanup_limit", "Source cleanup exceeded its bounded file walk.");
    const target = path.join(parent, name);
    let info;
    try { info = await fs.lstat(target); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (!info.isDirectory()) {
      // Unlink the owned name itself, including symlinks; never follow it.
      await fs.unlink(target).catch(error => { if (error.code !== "ENOENT") throw error; });
      return;
    }
    const directory = await fs.open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = await directory.stat();
      if (opened.dev !== info.dev || opened.ino !== info.ino) throw new HttpError(409, "source_cleanup_changed", "Source cleanup directory changed.");
      const anchor = `/proc/self/fd/${directory.fd}`;
      for (const child of await fs.readdir(anchor)) await remove(anchor, child, depth + 1);
      const current = await fs.lstat(target);
      if (current.dev !== opened.dev || current.ino !== opened.ino) throw new HttpError(409, "source_cleanup_changed", "Source cleanup directory was replaced.");
      await fs.rmdir(target);
    } finally { await directory.close(); }
  }
  /** @param {string} root @param {string} relative */
  async function scoped(root, relative) {
    let parent;
    try {
      parent = await openScopedDirectoryNoFollow(root, path.dirname(path.join(root, relative)));
      await remove(parent.path, path.basename(relative), 0);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "file_not_found") throw error;
    } finally { await parent?.handle.close(); }
  }
  if (generation === undefined) {
    await scoped(projectRoot, `knowledge-base/.evimed-derived/${sourceId}`);
    await scoped(projectRoot, `knowledge-base/.evimed-openlist-staging/${sourceId}`);
  } else for (const jobId of jobIds) {
    if (!stagingOnly) await scoped(projectRoot, `knowledge-base/.evimed-derived/${sourceId}/generation-${generation}-${jobId}-${attemptId}`);
    await scoped(projectRoot, `knowledge-base/.evimed-openlist-staging/${sourceId}/${jobId}-${attemptId}`);
  }
  if (parserStagingRoot && generation !== undefined) {
    for (const jobId of jobIds) await scoped(parserStagingRoot, `${jobId}-${attemptId}`);
  } else if (parserStagingRoot && jobIds.length) {
    let directory;
    try {
      directory = await openScopedDirectoryNoFollow(parserStagingRoot, parserStagingRoot);
      const names = await fs.readdir(directory.path);
      if (names.length > 100000) throw new HttpError(413, "source_cleanup_limit", "Parser cleanup exceeded its bounded inventory.");
      const owned = new Set(jobIds);
      for (const name of names) {
        if (owned.has(name) || (/-[a-f0-9]{24}$/.test(name) && owned.has(name.slice(0, -25)))) await remove(directory.path, name, 0);
      }
    } catch (error) { if (error.code !== "ENOENT" && error.code !== "file_not_found") throw error; }
    finally { await directory?.handle.close(); }
  }
  return { visited };
}
