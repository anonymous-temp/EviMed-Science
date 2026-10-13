/**
 * What a run changed in its workspace — the files an ordinary conversation produced.
 *
 * Hidden knowledge: the ledger used to know a run's files only from the `write` and `edit` tool calls in its transcript.
 * Word, Excel and PowerPoint files, charts and almost every script are written by a program the model starts with `bash`
 * (the office skills say to), so a run that built a ten-page deck had recorded nothing (course correction 2026-10-12,
 * GA16: `bash` + Python for a `.docx` → no artifact; a `cat > file` redirect → none). Reading the command line would be
 * language and would never converge; the files themselves are the fact. So a run's files are what is new or modified in
 * the workspace between its start and its end, whichever tool wrote them.
 *
 * What does not count is a closed list (`ordinaryOutputPath`, `runArtifacts.mjs`): hidden names (the platform's own
 * directories and every dot directory), dependency, cache and scratch directories, the read-only data mount and the
 * knowledge base, and the platform's own plan and receipt files. The walk is bounded in depth, in entries read and in files
 * returned, because the workspace is the model's and the model may have installed a package into it.
 *
 * Known limit, said once: two conversations running in one project at the same moment share a workspace, and a file one
 * writes inside the other's window is attributed to both. The tool-call witnesses (`artifactCandidates`) do not have that
 * limit and stay the first source; this is the second, for what they cannot see.
 *
 * @module runWorkspaceChanges
 */

import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { isOrdinaryOutputDirectory, ordinaryOutputPath } from "./runArtifacts.mjs";

/** How deep below the workspace root a changed file is looked for. */
export const WORKSPACE_WALK_DEPTH = 6;
/** How many directory entries one walk reads before it stops, and how many files it returns. */
export const WORKSPACE_WALK_ENTRIES = 6000;
export const WORKSPACE_WALK_FILES = 64;

/**
 * The files under `root` last written in `[since, until]`, as workspace-relative paths, sorted.
 *
 * @param {string} root the workspace directory on the host
 * @param {{ since: number, until?: number, maxEntries?: number, maxDepth?: number, limit?: number }} window
 *   `since` and `until` are epoch milliseconds. A file's own mtime decides; `until` carries the one millisecond of slack the
 *   ledger's other freshness checks allow.
 * @returns {Promise<string[]>}
 */
export async function workspaceChangedFiles(root, { since, until = Number.POSITIVE_INFINITY, maxEntries = WORKSPACE_WALK_ENTRIES, maxDepth = WORKSPACE_WALK_DEPTH, limit = WORKSPACE_WALK_FILES }) {
  if (!Number.isFinite(since)) return [];
  /** @type {string[]} */
  const found = [];
  /** @type {{ relative: string, depth: number }[]} */
  const queue = [{ relative: "", depth: 0 }];
  let read = 0;
  while (queue.length > 0 && read < maxEntries && found.length < limit) {
    const { relative, depth } = /** @type {{ relative: string, depth: number }} */ (queue.shift());
    /** @type {import("node:fs").Dirent[]} */
    let entries;
    try {
      entries = await readdir(path.join(root, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      read += 1;
      if (read > maxEntries || found.length >= limit) break;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      // A link is neither followed nor listed: it can name anything on the host.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (depth + 1 <= maxDepth && isOrdinaryOutputDirectory(entry.name, relative === "")) queue.push({ relative: child, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile() || !ordinaryOutputPath(child)) continue;
      const stat = await lstat(path.join(root, child)).catch(() => null);
      if (!stat?.isFile() || stat.mtimeMs < since || stat.mtimeMs > until + 1) continue;
      found.push(child);
    }
  }
  return found.sort();
}
