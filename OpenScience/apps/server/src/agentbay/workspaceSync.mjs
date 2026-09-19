/**
 * A project's files between its host copy and its AgentBay session
 * (plan §3.1 #4).
 *
 * The host directory stays the copy of record: file previews, the knowledge
 * base, sharing, backups, quotas and the delivery gate all read it, and none of
 * them changes. An AgentBay Context — an OSS directory — carries files into a
 * session (downloaded when the session is created) and is the safety net out
 * of it (uploaded when the session is released, even one the control plane
 * lost). Three movements, and the rules they keep:
 *
 *   push     host → Context, before a session starts, through presigned
 *            upload URLs: file bytes go to OSS directly, never through the
 *            session's shared 5 Mbps egress.
 *   mirror   session → host while it lives, through the session's file API:
 *            what changed since the last look, so the UI and the run ledger see
 *            the run's files, and a full pass before the delivery gate reads
 *            them and before the session is released.
 *   recover  Context → host, when the last session ended without that final
 *            pass (a control plane that restarted, a session released on its
 *            own): the Context's automatic upload is then the newest copy.
 *
 * What never changes, whichever way bytes move: no link is followed, every
 * write resolves inside the host directory it belongs to (`security.mjs`'s
 * scoped no-follow writers), and the control plane never executes or imports a
 * file it carried.
 *
 * @module agentbay/workspaceSync
 */

import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { HttpError, openScopedFileNoFollow, readTextFileNoFollow, writeFileAtomicNoFollow, writeJsonFileAtomicNoFollow } from "../security.mjs";

/** How many uploads or downloads run at once: enough to hide round trips,
 *  few enough not to crowd a small control-plane host. */
const TRANSFER_CONCURRENCY = 8;

/** The largest tree walked or listed, the same bound the quota scan uses. */
const MAX_ENTRIES = 20_000;

/** @param {string} rel */
function assertRelative(rel) {
  if (!rel || rel.startsWith("/") || rel.includes("\\") || rel.split("/").some((part) => !part || part === "." || part === "..")
    || [...rel].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) {
    throw new HttpError(400, "agentbay_sync_path_invalid", "A synced path must be a plain relative path.");
  }
  return rel;
}

/**
 * Regular files under a host directory, by relative path. Symlinks are
 * skipped, never followed; a missing directory is an empty tree.
 * @param {string} root @param {{ exclude?: string[], maxEntries?: number }} [options]
 * @returns {Promise<Map<string, { size: number, mtimeMs: number }>>}
 */
export async function hostTree(root, { exclude = [], maxEntries = MAX_ENTRIES } = {}) {
  /** @type {Map<string, { size: number, mtimeMs: number }>} */
  const files = new Map();
  let seen = 0;
  async function walk(dir, rel) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT" && !rel) return;
      throw error;
    }
    for (const entry of entries) {
      if (++seen > maxEntries) throw new HttpError(413, "agentbay_sync_too_large", `The tree exceeds ${maxEntries} entries.`);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (!rel && exclude.includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const stat = await fs.lstat(full).catch(() => null);
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) await walk(full, childRel);
      else if (stat.isFile()) files.set(childRel, { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) });
    }
  }
  await walk(root, "");
  return files;
}

/**
 * The launcher's manifest (`evimed-session manifest`): base64 of gzipped
 * `<mtime seconds> <size> <path>` lines. A line that does not parse is dropped
 * rather than trusted — a file name with a newline in it is not one to carry.
 * @param {string} encoded
 * @returns {Map<string, { size: number, mtimeMs: number }>}
 */
export function parseSessionManifest(encoded) {
  /** @type {Map<string, { size: number, mtimeMs: number }>} */
  const files = new Map();
  const text = gunzipSync(Buffer.from(String(encoded ?? "").trim(), "base64")).toString("utf8");
  for (const line of text.split("\n")) {
    const match = /^(\d+(?:\.\d+)?) (\d+) (.+)$/.exec(line);
    if (!match) continue;
    try {
      files.set(assertRelative(match[3]), { size: Number(match[2]), mtimeMs: Math.floor(Number(match[1]) * 1000) });
    } catch {
      // isolated: an unrepresentable name stays in the session.
    }
  }
  return files;
}

/** @param {{ size: number, mtimeMs: number }} entry */
function signature(entry) {
  return `${entry.size}:${Math.floor(entry.mtimeMs / 1000)}`;
}

/**
 * What a Context held when this control plane last synced it, per path — the
 * base a push diffs against, kept beside the project's runtime state.
 * `clean` says the last session ended with the control plane's own full pull,
 * so nothing in the Context is newer than the host.
 * @typedef {{ version: 1, clean: boolean, files: Record<string, { size: number, mtimeMs: number }> }} SyncManifest
 */

/** @param {string} root @param {string} file @returns {Promise<SyncManifest>} */
export async function loadSyncManifest(root, file) {
  const text = await readTextFileNoFollow(root, file, "").catch(() => "");
  try {
    const parsed = JSON.parse(text);
    if (parsed?.version === 1 && parsed.files && typeof parsed.files === "object") {
      return { version: 1, clean: parsed.clean === true, files: parsed.files };
    }
  } catch {
    // A manifest that cannot be read means nothing is known about the Context:
    // the next push carries everything, and nothing is deleted from it.
  }
  return { version: 1, clean: false, files: {} };
}

/** @param {string} root @param {string} file @param {SyncManifest} manifest */
export async function saveSyncManifest(root, file, manifest) {
  await writeJsonFileAtomicNoFollow(root, file, manifest);
}

/** Runs `worker` over `items`, `limit` at a time; the first failure rejects. */
async function pool(items, limit, worker) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index]);
    }
  });
  await Promise.all(lanes);
}

function transport(url) {
  return new URL(url).protocol === "https:" ? https : http;
}

/**
 * PUT one host file to a presigned URL, streamed, with the length stated: an
 * OSS presigned PUT is signed without a content type, so none is sent.
 *
 * Opened through the scoped no-follow opener, not by path: a run under the
 * Docker provider can leave a symlink in the host workspace, and a path read
 * would upload whatever it points at — a file of this host — into a Context
 * the next session downloads.
 * @param {string} url @param {string} root @param {string} file
 */
export async function putPresigned(url, root, file) {
  const opened = await openScopedFileNoFollow(root, file);
  try {
    await new Promise((resolve, reject) => {
      const request = transport(url).request(url, { method: "PUT", headers: { "content-length": String(opened.stat.size) } }, (response) => {
        response.resume();
        response.once("end", () => ((response.statusCode ?? 500) < 300
          ? resolve(undefined)
          : reject(new HttpError(502, "agentbay_sync_upload_failed", `A Context upload answered HTTP ${response.statusCode}.`))));
      });
      request.once("error", () => reject(new HttpError(502, "agentbay_sync_upload_failed", "A Context upload failed.")));
      const stream = opened.handle.createReadStream({ start: 0, end: Math.max(0, opened.stat.size - 1), autoClose: false });
      stream.once("error", (error) => request.destroy(error));
      if (opened.stat.size === 0) request.end();
      else stream.pipe(request);
    });
    return opened.stat.size;
  } finally {
    await opened.handle.close();
  }
}

/**
 * GET a presigned URL as a stream the scoped writer consumes.
 * @param {string} url
 * @returns {Promise<import("node:http").IncomingMessage>}
 */
export function getPresigned(url) {
  return new Promise((resolve, reject) => {
    const request = transport(url).get(url, (response) => {
      if ((response.statusCode ?? 500) >= 300) {
        response.resume();
        reject(new HttpError(502, "agentbay_sync_download_failed", `A Context download answered HTTP ${response.statusCode}.`));
        return;
      }
      resolve(response);
    });
    request.once("error", () => reject(new HttpError(502, "agentbay_sync_download_failed", "A Context download failed.")));
  });
}

/**
 * Host → Context: every file the Context does not hold at this size and time
 * is uploaded, every file it holds that the host no longer has is deleted
 * from it. Files over `maxFileBytes` stay behind and are reported.
 *
 * @param {{ client: any, contextId: string, hostRoot: string, exclude?: string[], manifest: SyncManifest,
 *   maxFileBytes: number, put?: typeof putPresigned }} input
 * @returns {Promise<{ uploaded: number, deleted: number, skipped: { path: string, size: number }[] }>}
 */
export async function pushTree({ client, contextId, hostRoot, exclude = [], manifest, maxFileBytes, put = putPresigned }) {
  const tree = await hostTree(hostRoot, { exclude });
  const skipped = [];
  const uploads = [];
  for (const [rel, entry] of tree) {
    const known = manifest.files[rel];
    if (known && signature(known) === signature(entry)) continue;
    if (entry.size > maxFileBytes) {
      skipped.push({ path: rel, size: entry.size });
      continue;
    }
    uploads.push([rel, entry]);
  }
  await pool(uploads, TRANSFER_CONCURRENCY, async ([rel, entry]) => {
    const url = await client.contexts.uploadUrl(contextId, `/${rel}`);
    await put(url, hostRoot, path.join(hostRoot, rel));
    manifest.files[rel] = { size: entry.size, mtimeMs: entry.mtimeMs };
  });
  const removed = Object.keys(manifest.files).filter((rel) => !tree.has(rel));
  await pool(removed, TRANSFER_CONCURRENCY, async (rel) => {
    await client.contexts.deleteFile(contextId, `/${rel}`);
    delete manifest.files[rel];
  });
  return { uploaded: uploads.length, deleted: removed.length, skipped };
}

/**
 * Context → host, for a Context that may be newer than the host: every file
 * whose size or modification time the manifest does not record is downloaded
 * over the host copy. Nothing on the host is deleted here — a file missing
 * from the Context may simply never have been pushed.
 *
 * @param {{ client: any, contextId: string, hostRoot: string, exclude?: string[], manifest: SyncManifest,
 *   maxFileBytes: number, get?: typeof getPresigned }} input
 * @returns {Promise<{ downloaded: number, skipped: { path: string, size: number }[] }>}
 */
export async function recoverTree({ client, contextId, hostRoot, exclude = [], manifest, maxFileBytes, get = getPresigned }) {
  /** @type {{ rel: string, size: number, modified: string | null }[]} */
  const remote = [];
  const folders = ["/"];
  let listed = 0;
  while (folders.length) {
    const folder = /** @type {string} */ (folders.shift());
    let nextToken;
    do {
      const page = await client.contexts.listFiles(contextId, folder, { nextToken });
      for (const entry of page.entries) {
        if (++listed > MAX_ENTRIES) throw new HttpError(413, "agentbay_sync_too_large", `The Context exceeds ${MAX_ENTRIES} entries.`);
        const rel = entry.path.replace(/^\/+/, "").replace(/\/+$/, "");
        if (!rel || exclude.includes(rel.split("/")[0])) continue;
        if (/folder|dir/i.test(entry.type)) folders.push(`/${rel}/`);
        else remote.push({ rel, size: Number(entry.size ?? 0), modified: entry.modified });
      }
      nextToken = page.nextToken ?? undefined;
    } while (nextToken);
  }
  // A file the manifest records and the Context no longer holds was deleted
  // there, by a session the control plane never mirrored. The host copy is
  // kept (nothing is deleted from the record here) and forgotten from the
  // manifest, so the next push carries it back and the two agree again.
  const present = new Set(remote.map((file) => file.rel));
  for (const rel of Object.keys(manifest.files)) {
    if (!present.has(rel) && !exclude.includes(rel.split("/")[0])) delete manifest.files[rel];
  }
  const skipped = [];
  const changed = remote.filter((file) => {
    let rel;
    try { rel = assertRelative(file.rel); } catch { return false; }
    const known = manifest.files[rel];
    const modifiedMs = file.modified ? Date.parse(file.modified) : NaN;
    // Newer in the Context than when this control plane last synced it: a
    // different size, or a modification time past the recorded one.
    const newer = !known || known.size !== file.size || (Number.isFinite(modifiedMs) && modifiedMs > known.mtimeMs + 2_000);
    if (!newer) return false;
    if (file.size > maxFileBytes) {
      skipped.push({ path: rel, size: file.size });
      return false;
    }
    return true;
  });
  await pool(changed, TRANSFER_CONCURRENCY, async (file) => {
    const url = await client.contexts.downloadUrl(contextId, `/${file.rel}`);
    const target = path.join(hostRoot, file.rel);
    await writeFileAtomicNoFollow(hostRoot, target, await get(url), { mode: 0o600 });
    const stat = await fs.lstat(target);
    manifest.files[file.rel] = { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) };
  });
  return { downloaded: changed.length, skipped };
}

/**
 * Session → host: what changed in the session since `seen` last recorded it
 * is read through the file API and written over the host copy, with the
 * session's modification time; what the session deleted is deleted on the
 * host, but only a file `seen` knew the session had — a file that only ever
 * existed on the host (an upload made while the run worked) is never touched.
 *
 * `seen` maps a path to the session's own signature for it. Empty, every
 * session file is compared with the host copy instead, which is how a session
 * the control plane reattached to (and never watched) is brought home.
 *
 * @param {{ listSession: () => Promise<Map<string, { size: number, mtimeMs: number }>>,
 *   readSession: (rel: string) => Promise<Buffer>, hostRoot: string, seen: Map<string, string>, maxFileBytes: number }} input
 * @returns {Promise<{ pulled: number, deleted: number, skipped: { path: string, size: number }[] }>}
 */
export async function mirrorSession({ listSession, readSession, hostRoot, seen, maxFileBytes }) {
  const session = await listSession();
  const skipped = [];
  const changed = [];
  for (const [rel, entry] of session) {
    const sig = signature(entry);
    if (seen.has(rel)) {
      if (seen.get(rel) === sig) continue;
    } else {
      const host = await fs.lstat(path.join(hostRoot, rel)).catch(() => null);
      if (host?.isFile() && host.size === entry.size && Math.floor(host.mtimeMs / 1000) >= Math.floor(entry.mtimeMs / 1000)) {
        seen.set(rel, sig);
        continue;
      }
    }
    if (entry.size > maxFileBytes) {
      skipped.push({ path: rel, size: entry.size });
      continue;
    }
    changed.push([rel, entry, sig]);
  }
  await pool(changed, TRANSFER_CONCURRENCY, async ([rel, entry, sig]) => {
    const target = path.join(hostRoot, rel);
    await writeFileAtomicNoFollow(hostRoot, target, await readSession(rel), { mode: 0o600 });
    const when = new Date(entry.mtimeMs);
    await fs.lutimes(target, when, when).catch(() => {});
    seen.set(rel, sig);
  });
  let deleted = 0;
  for (const rel of [...seen.keys()]) {
    if (session.has(rel)) continue;
    seen.delete(rel);
    const target = path.join(hostRoot, rel);
    const stat = await fs.lstat(target).catch(() => null);
    if (stat?.isFile()) {
      await fs.rm(target, { force: true });
      deleted += 1;
    }
  }
  return { pulled: changed.length, deleted, skipped };
}

/**
 * A session's manifest as the baseline a fresh session starts from: what it
 * downloaded is what was just pushed, so nothing in it needs carrying back.
 * @param {Map<string, { size: number, mtimeMs: number }>} files
 * @returns {Map<string, string>}
 */
export function baselineFrom(files) {
  return new Map([...files].map(([rel, entry]) => [rel, signature(entry)]));
}

/**
 * The mirror's record of what a session held (`seen`, path → signature) as a
 * sync manifest's file table: the same size and whole-second time, which is
 * all a push compares.
 * @param {Map<string, string>} seen
 * @returns {Record<string, { size: number, mtimeMs: number }>}
 */
export function manifestFromSignatures(seen) {
  /** @type {Record<string, { size: number, mtimeMs: number }>} */
  const files = {};
  for (const [rel, sig] of seen) {
    const match = /^(\d+):(\d+)$/.exec(sig);
    if (match) files[rel] = { size: Number(match[1]), mtimeMs: Number(match[2]) * 1000 };
  }
  return files;
}
