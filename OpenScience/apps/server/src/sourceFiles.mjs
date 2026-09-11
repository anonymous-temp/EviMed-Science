import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { HttpError, openScopedDirectoryNoFollow, resolveScopedPath } from "./security.mjs";

/** Give the read-only parser group access without transferring Web ownership.
 * All permission changes use the same scoped descriptors as the file checks.
 * @param {{stagingRoot:string,relative:string,bytes:Buffer,parserGid:number}} input */
export async function stageParserInput({ stagingRoot, relative, bytes, parserGid }) {
  if (!Number.isSafeInteger(parserGid) || parserGid < 0 || parserGid > 65535
    || !new Set([process.getgid(), ...process.getgroups()]).has(parserGid)) {
    throw new HttpError(503, "document_parser_group_unavailable", "The Web process must belong to the parser staging group.");
  }
  const target = resolveScopedPath(stagingRoot, relative);
  if (path.dirname(path.dirname(target)) !== path.resolve(stagingRoot)) {
    throw new HttpError(400, "source_path_invalid", "Parser input must be inside one attempt directory.");
  }
  const root = await openScopedDirectoryNoFollow(stagingRoot, stagingRoot);
  const attemptPath = path.join(root.path, path.basename(path.dirname(target)));
  let parent;
  let file;
  let createdParent = false;
  let published = false;
  let temporary = "";
  let destination = "";
  try {
    if (root.stat.uid !== process.getuid()) throw new HttpError(403, "path_forbidden", "Parser staging must be owned by the Web process.");
    await root.handle.chown(-1, parserGid);
    await root.handle.chmod(0o710);
    try { await fs.mkdir(attemptPath, { mode: 0o700 }); createdParent = true; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    parent = await openScopedDirectoryNoFollow(stagingRoot, path.dirname(target));
    const namedParent = await fs.lstat(attemptPath);
    if (parent.stat.uid !== process.getuid() || namedParent.dev !== parent.stat.dev || namedParent.ino !== parent.stat.ino) {
      throw new HttpError(403, "path_forbidden", "Parser attempt must be owned by the Web process and remain unchanged.");
    }
    destination = path.join(parent.path, path.basename(target));
    const existing = await fs.lstat(destination).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (existing?.isSymbolicLink() || (existing?.isFile() && existing.nlink !== 1)) {
      throw new HttpError(403, "path_forbidden", "Parser input must not be linked.");
    }
    if (existing) throw new HttpError(409, "source_changed", "Parser input already exists for this attempt.");
    temporary = path.join(parent.path, `.parser-${randomUUID()}`);
    file = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(bytes);
    await file.sync();
    await file.chown(-1, parserGid);
    await file.chmod(0o440);
    await parent.handle.chown(-1, parserGid);
    await parent.handle.chmod(0o710);
    // Exclusive publication follows every permission change. A collision must
    // never replace another attempt's input, including a concurrent creation.
    await fs.link(temporary, destination);
    published = true;
    await fs.unlink(temporary);
    return target;
  } catch (error) {
    if (file) {
      const own = await file.stat();
      for (const name of [temporary, ...(published ? [destination] : [])]) {
        const current = await fs.lstat(name).catch(problem => { if (problem.code === "ENOENT") return null; throw problem; });
        if (current && current.dev === own.dev && current.ino === own.ino) await fs.unlink(name);
      }
    }
    if (createdParent && parent) {
      const current = await fs.lstat(attemptPath).catch(problem => { if (problem.code === "ENOENT") return null; throw problem; });
      if (current && current.dev === parent.stat.dev && current.ino === parent.stat.ino) {
        await fs.rmdir(attemptPath).catch(problem => { if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes(problem.code)) throw problem; });
      }
    }
    throw error;
  } finally {
    await file?.close();
    await parent?.handle.close();
    await root.handle.close();
  }
}

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
