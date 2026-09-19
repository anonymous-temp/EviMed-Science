import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { evidenceSourceTypeOf, isEvidenceSourceType } from "@evimed/domain";
import { claimVerification } from "./clinicalEvidenceQuality.mjs";
import {
  HttpError,
  apiBaseFromRequest,
  appendJsonLineNoFollow,
  assertObject,
  assertProjectCapacity,
  assertString,
  encodeBase64,
  isTextFile,
  mimeFor,
  normalizeRoot,
  normalizeWorkspaceRelativePath,
  openScopedDirectoryNoFollow,
  openScopedFileNoFollow,
  readTextFileNoFollow,
  resolveScopedPath,
  scopedDisplayPath,
  withProjectStorageMutation,
  writeFileAtomicNoFollow,
  writeFileExclusiveNoFollow,
} from "./security.mjs";

export const BUNDLED_EXAMPLES = Object.freeze({
  "climate-trends": Object.freeze([
    "README.md",
    "data/gistemp_global_means.csv",
  ]),
});

function rootDirFor(project, root) {
  return root === "base" ? project.baseDir : project.workspaceDir;
}

function relFromFull(rootDir, full) {
  return path.relative(rootDir, full).replace(/\\/g, "/");
}

function relativePathFromKnownRoots(value, roots, label) {
  const raw = assertString(value, label, { max: 4096 });
  if (!path.isAbsolute(raw)) return normalizeWorkspaceRelativePath(raw, label);
  const target = path.resolve(raw);
  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    const relative = path.relative(resolvedRoot, target).replace(/\\/g, "/");
    if (relative && relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative)) {
      return normalizeWorkspaceRelativePath(relative, label);
    }
  }
  throw new HttpError(400, "invalid_path", `${label} must resolve inside the active workspace.`);
}

function hostedWorkspaceName(project, value) {
  const raw = assertString(value, "path", { max: 4096 });
  const displayPrefix = `/workspace/${project.id}/`;
  let name;
  if (raw.startsWith(displayPrefix)) {
    name = raw.slice(displayPrefix.length);
  } else if (path.isAbsolute(raw)) {
    const relative = path.relative(path.resolve(project.baseDir), path.resolve(raw)).replace(/\\/g, "/");
    if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
      throw new HttpError(400, "invalid_workspace", "workspace path is outside this project.");
    }
    name = relative;
  } else {
    name = raw.replace(/^\/+/, "");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,127}$/.test(name)) {
    throw new HttpError(400, "invalid_workspace", "workspace name contains unsupported characters.");
  }
  return name;
}

async function resolveFile(project, args) {
  const root = normalizeRoot(args.root);
  const rel = assertString(args.path ?? args.rel ?? "", "path", { max: 4096 });
  const base = rootDirFor(project, root);
  return { root, base, rel, full: resolveScopedPath(base, rel) };
}

async function statExistingWorkspacePath(rootDir, full, kind = "file") {
  let opened;
  try {
    opened = kind === "directory"
      ? await openScopedDirectoryNoFollow(rootDir, full)
      : await openScopedFileNoFollow(rootDir, full);
    return opened.stat;
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw new HttpError(
        404,
        kind === "directory" ? "directory_not_found" : "file_not_found",
        kind === "directory" ? "Directory not found." : "File not found.",
      );
    }
    throw err;
  } finally {
    await opened?.handle.close();
  }
}

function finitePositive(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

async function readStableFileHandle(handle, initialStat) {
  const size = initialStat.size;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new HttpError(409, "file_changed", "File changed while it was being read.");
  }
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
    if (bytesRead === 0) throw new HttpError(409, "file_changed", "File changed while it was being read.");
    offset += bytesRead;
  }
  const finalStat = await handle.stat();
  if (
    finalStat.size !== initialStat.size ||
    finalStat.mtimeMs !== initialStat.mtimeMs ||
    finalStat.ctimeMs !== initialStat.ctimeMs
  ) {
    throw new HttpError(409, "file_changed", "File changed while it was being read.");
  }
  return buffer;
}

function assertWorkspaceScanCapacity(count, limit) {
  if (limit != null && count > limit) {
    throw new HttpError(413, "workspace_scan_too_large", `Workspace scan exceeded ${limit} entries.`);
  }
}

async function walk(root, visitor, rel = "", state = { count: 0, limit: null }) {
  const full = resolveScopedPath(root, rel);
  const opened = await openScopedDirectoryNoFollow(root, full);
  try {
    const entries = await fs.readdir(opened.path, { withFileTypes: true });
    for (const entry of entries) {
      state.count += 1;
      assertWorkspaceScanCapacity(state.count, state.limit);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childFull = resolveScopedPath(root, childRel);
      const stat = await fs.lstat(path.join(opened.path, entry.name));
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        await walk(root, visitor, childRel, state);
      } else {
        await visitor(childRel, childFull, stat);
      }
    }
  } finally {
    await opened.handle.close();
  }
}

function walkState(config) {
  return { count: 0, limit: finitePositive(config.maxWorkspaceScanEntries) };
}

function rethrowHttpError(err) {
  if (err instanceof HttpError) throw err;
}

async function installBundledExample(name, ctx) {
  const examplesRoot = path.resolve(ctx.config.examplesDir);
  const sourceDir = resolveScopedPath(examplesRoot, name);
  let sourceRoot;
  try {
    sourceRoot = await openScopedDirectoryNoFollow(examplesRoot, sourceDir);
    if (!sourceRoot.stat.isDirectory()) throw new HttpError(503, "example_bundle_unavailable", "Bundled example is unavailable.");
  } catch (err) {
    if (err instanceof HttpError && err.code === "path_forbidden") throw err;
    throw new HttpError(503, "example_bundle_unavailable", "Bundled example is unavailable.");
  } finally {
    await sourceRoot?.handle.close();
  }

  await withProjectStorageMutation(ctx.project, async () => {
    try {
      await walk(examplesRoot, async (relative, sourceFile, stat) => {
        if (!stat.isFile()) return;
        if (stat.size > ctx.config.maxFileBytes) {
          throw new HttpError(413, "example_file_too_large", "Bundled example contains an oversized file.");
        }
        const destination = resolveScopedPath(ctx.project.workspaceDir, relative);
        let existing;
        try {
          existing = await openScopedFileNoFollow(ctx.project.workspaceDir, destination);
          if (!existing.stat.isFile()) throw new HttpError(400, "not_a_file", "Example destination is not a file.");
          return;
        } catch (err) {
          if (!(err?.code === "ENOENT" || (err instanceof HttpError && err.code === "file_not_found"))) {
            throw err;
          }
        } finally {
          await existing?.handle.close();
        }

        const source = await openScopedFileNoFollow(examplesRoot, sourceFile);
        let data;
        try {
          if (!source.stat.isFile()) throw new HttpError(503, "example_bundle_unavailable", "Bundled example is unavailable.");
          data = await readStableFileHandle(source.handle, source.stat);
        } finally {
          await source.handle.close();
        }
        await assertProjectCapacity(ctx.project, destination, data.length, ctx.config);
        try {
          await writeFileExclusiveNoFollow(ctx.project.workspaceDir, destination, data, { mode: 0o600 });
        } catch (err) {
          if (err?.code !== "EEXIST") throw err;
          const raced = await openScopedFileNoFollow(ctx.project.workspaceDir, destination);
          try {
            if (!raced.stat.isFile()) throw new HttpError(400, "not_a_file", "Example destination is not a file.");
          } finally {
            await raced.handle.close();
          }
        }
      }, name, walkState(ctx.config));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(500, "example_install_failed", "Bundled example could not be installed.");
    }
  });
  return name;
}

async function appendProjectJsonl(project, filename, record, options = {}) {
  await appendJsonLineNoFollow(project.rootDir, path.join(project.metaDir, filename), record, options);
}

function publicApiBase(ctx) {
  return `${apiBaseFromRequest(ctx.req, ctx.config).replace(/\/+$/, "")}/api`;
}

async function readProvenance(project) {
  const file = path.join(project.metaDir, "provenance.jsonl");
  const rotated = await readTextFileNoFollow(project.rootDir, `${file}.1`, "");
  const current = await readTextFileNoFollow(project.rootDir, file, "");
  const text = `${rotated}${current}`;
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function capProvenanceText(value, max = 100 * 1024) {
  if (typeof value !== "string") return undefined;
  if (Buffer.byteLength(value, "utf8") <= max) return value;
  const marker = "\n[truncated]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const source = Buffer.from(value, "utf8");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = Math.max(0, max - markerBytes);
  while (end > 0) {
    try {
      return `${decoder.decode(source.subarray(0, end))}${marker}`;
    } catch {
      end -= 1;
    }
  }
  return marker;
}

function optionalLimitedString(value, label, max) {
  if (value == null) return undefined;
  return assertString(value, label, { max });
}

function unsupported(message) {
  throw new HttpError(501, "unsupported_in_web", message);
}

const TASK_COMMAND_ALLOWLIST = new Set([
  "add_text_to_workspace",
  "install_example",
  "list_dir",
  "list_provenance",
  "probe_large_file",
  "read_artifact",
  "read_env_lockfile",
  "record_provenance",
  "resolve_artifact",
  "upload_file",
  "write_workspace_file",
]);

export function createCommandRegistry({ config, runtimeManager }) {
  const handlers = {
    // The value returned is the control plane's own surface, not a kernel's.
    // It used to be a pass-through base URL the browser then spoke a kernel's
    // protocol over, which is why the frontend knew that protocol; the browser
    // now creates sessions and subscribes to events through the control plane,
    // and the kernel is unreachable from it.
    async start_runtime(_args, ctx) {
      await runtimeManager.start(ctx.project);
      return `${publicApiBase(ctx)}/runtime`;
    },

    async runtime_password() {
      return null;
    },

    async stop_runtime(_args, ctx) {
      await runtimeManager.stop(ctx.project);
      return null;
    },

    async restart_runtime(_args, ctx) {
      await runtimeManager.restart(ctx.project);
      return `${publicApiBase(ctx)}/runtime`;
    },

    async runtime_status(_args, ctx) {
      return runtimeManager.status(ctx.project);
    },

    async workspace_path(_args, ctx) {
      return scopedDisplayPath(ctx.project, ctx.project.activeWorkspace ?? "");
    },

    async workspace_base(_args, ctx) {
      return `/workspace/${ctx.project.id}`;
    },

    async set_workspace_base() {
      unsupported("Hosted workspaces are managed by the server.");
    },

    async open_workspace_base() {
      // The browser cannot reveal a server directory in a local file manager.
      return null;
    },

    async set_workspace(args, ctx) {
      const name = hostedWorkspaceName(ctx.project, args.path);
      if (ctx.project.activeWorkspace === name) return scopedDisplayPath(ctx.project, name);
      await ctx.store.setProjectWorkspace(ctx.project, name);
      await runtimeManager.stop(ctx.project);
      return scopedDisplayPath(ctx.project, name);
    },

    async new_dated_workspace(args, ctx) {
      const name = assertString(args.name, "name", { max: 128 });
      if (name.includes("/") || name.includes("\\") || name.includes("..")) {
        throw new HttpError(400, "invalid_workspace", "invalid folder name.");
      }
      await ctx.store.setProjectWorkspace(ctx.project, name);
      await runtimeManager.stop(ctx.project);
      return scopedDisplayPath(ctx.project, name);
    },

    async pick_folder() {
      return null;
    },

    async add_files_to_workspace() {
      return [];
    },

    async upload_file(args, ctx) {
      const root = normalizeRoot(args.root);
      const rel = normalizeWorkspaceRelativePath(args.path ?? args.filename, "filename");
      const encoding = args.encoding === "base64" ? "base64" : "utf8";
      const raw = assertString(args.data, "data", { max: Math.ceil(ctx.config.maxFileBytes * 1.4) });
      const buffer = encoding === "base64" ? Buffer.from(raw, "base64") : Buffer.from(raw, "utf8");
      if (buffer.length > ctx.config.maxFileBytes) throw new HttpError(413, "file_too_large", "file is too large.");
      const base = rootDirFor(ctx.project, root);
      const full = resolveScopedPath(base, rel);
      await withProjectStorageMutation(ctx.project, async () => {
        await assertProjectCapacity(ctx.project, full, buffer.length, ctx.config);
        await writeFileAtomicNoFollow(base, full, buffer, { mode: 0o600 });
      });
      return relFromFull(base, full);
    },

    async add_text_to_workspace(args, ctx) {
      const filename = normalizeWorkspaceRelativePath(args.filename, "filename");
      const content = assertString(args.content, "content", { max: ctx.config.maxFileBytes });
      const full = resolveScopedPath(ctx.project.workspaceDir, filename);
      await withProjectStorageMutation(ctx.project, async () => {
        await assertProjectCapacity(ctx.project, full, Buffer.byteLength(content, "utf8"), ctx.config);
        await writeFileAtomicNoFollow(ctx.project.workspaceDir, full, content, { encoding: "utf8" });
      });
      return relFromFull(ctx.project.workspaceDir, full);
    },

    async read_artifact(args, ctx) {
      const { base, full } = await resolveFile(ctx.project, args);
      const opened = await openScopedFileNoFollow(base, full).catch((err) => {
        if (err?.code === "ENOENT" || (err instanceof HttpError && err.code === "file_not_found")) {
          throw new HttpError(404, "file_not_found", "File not found.");
        }
        throw err;
      });
      try {
        const { stat } = opened;
        if (!stat.isFile()) throw new HttpError(400, "not_a_file", "path is not a file.");
        if (stat.size > ctx.config.maxFileBytes) {
          throw new HttpError(413, "file_too_large", "file is too large to read directly.");
        }
        const data = await readStableFileHandle(opened.handle, stat);
        const encoding = isTextFile(full) ? "utf8" : "base64";
        return {
          path: args.path,
          mime: mimeFor(full),
          encoding,
          data: encoding === "utf8" ? data.toString("utf8") : encodeBase64(data),
          size: stat.size,
        };
      } finally {
        await opened.handle.close();
      }
    },

    /**
     * Whether each claim of a clinical evidence matrix quotes the source it
     * names, for the reader of the report beside it (2026-09-17).
     *
     * Computed when asked, from what is on disk: the matrix at `path` and the
     * preserved sources its claims name under `.evimed-sources/`. No stored
     * verdict to go stale, and the comparison is the delivery gate's own
     * (`claimVerification` in @evimed/domain), so the mark a reader sees and
     * the gate's notice cannot disagree. `.evimed-sources/` is write-protected
     * against the run's own tools, which is what makes a match worth showing.
     */
    async claim_verification(args, ctx) {
      const { base, full } = await resolveFile(ctx.project, args);
      if (path.basename(full) !== "clinical-evidence-matrix.json") {
        throw new HttpError(400, "not_a_claim_matrix", "path must name a clinical-evidence-matrix.json.");
      }
      /** @param {string} root @param {string} file @returns {Promise<string | null>} */
      const readText = async (root, file) => {
        let opened;
        try {
          opened = await openScopedFileNoFollow(root, file);
          if (!opened.stat.isFile() || opened.stat.size > ctx.config.maxFileBytes) return null;
          return (await readStableFileHandle(opened.handle, opened.stat)).toString("utf8");
        } catch {
          return null;
        } finally {
          await opened?.handle.close();
        }
      };
      const text = await readText(base, full);
      if (text == null) throw new HttpError(404, "file_not_found", "File not found.");
      let matrix;
      try { matrix = JSON.parse(text); } catch { throw new HttpError(422, "claim_matrix_invalid", "The matrix is not valid JSON."); }
      const named = (Array.isArray(matrix?.claims) ? matrix.claims : []).flatMap((/** @type {any} */ claim) => [
        claim?.artifactPath,
        ...(Array.isArray(claim?.supportingSources) ? claim.supportingSources.map((/** @type {any} */ source) => source?.artifactPath) : []),
      ]).filter((value) => typeof value === "string" && value.startsWith(".evimed-sources/"));
      /** @type {Record<string, string>} */
      const sourceArtifacts = {};
      // Bounded like the gate: one canonical file per document, 48 at most.
      for (const artifactPath of [...new Set(named)].slice(0, 48)) {
        let source = null;
        try { source = await readText(ctx.project.workspaceDir, resolveScopedPath(ctx.project.workspaceDir, artifactPath)); } catch { /* an unsafe path is an unread source */ }
        if (source) sourceArtifacts[artifactPath] = source;
      }
      const verdict = claimVerification({ matrix, sourceArtifacts });
      // What each quoted source is (C8), for the badge beside it. The
      // preserving tool wrote it into the capture as `source.json` when it
      // preserved the text; a capture from before that is typed from the URL
      // the claim cites, by the same domain table.
      /** @type {Map<string, string | null>} */
      const preservedTypes = new Map();
      for (const artifactPath of Object.keys(sourceArtifacts)) {
        const sidecar = path.posix.join(path.posix.dirname(artifactPath), "source.json");
        let declared = null;
        try { declared = JSON.parse(await readText(ctx.project.workspaceDir, resolveScopedPath(ctx.project.workspaceDir, sidecar)) ?? "null")?.sourceType; } catch { /* no sidecar */ }
        preservedTypes.set(artifactPath, isEvidenceSourceType(declared) ? declared : null);
      }
      const matrixClaims = new Map((Array.isArray(matrix?.claims) ? matrix.claims : []).map((/** @type {any} */ claim) => [String(claim?.claimId), claim]));
      for (const claim of verdict.claims) {
        const cited = matrixClaims.get(claim.claimId);
        claim.sources.forEach((/** @type {Record<string, any>} */ source, index) => {
          const origin = claim.claimType === "synthesized" ? cited?.supportingSources?.[index] : cited;
          source.sourceType = (source.artifactPath && preservedTypes.get(source.artifactPath))
            || evidenceSourceTypeOf({ url: origin?.sourceUrl });
        });
      }
      return verdict;
    },

    async resolve_artifact(args, ctx) {
      const requested = assertString(args.path, "path", { max: 4096 });
      const direct = resolveScopedPath(ctx.project.workspaceDir, requested);
      let directFile;
      try {
        directFile = await openScopedFileNoFollow(ctx.project.workspaceDir, direct);
        if (directFile.stat.isFile()) return requested.replace(/\\/g, "/");
      } catch (err) {
        if (!(err?.code === "ENOENT" || (err instanceof HttpError && err.code === "path_forbidden"))) throw err;
      } finally {
        await directFile?.handle.close();
      }
      const targetName = path.basename(requested);
      let found = null;
      await walk(ctx.project.workspaceDir, async (rel, _full, stat) => {
        if (!found && stat.isFile() && path.basename(rel) === targetName) found = rel;
      }, "", walkState(ctx.config)).catch(rethrowHttpError);
      return found;
    },

    async preview_url(args, ctx) {
      const root = normalizeRoot(args.root);
      const rel = assertString(args.path, "path", { max: 4096 });
      const encoded = encodeURIComponent(rel.replace(/\\/g, "/"));
      return `${publicApiBase(ctx)}/files/preview/${encoded}?root=${root}&projectId=${encodeURIComponent(ctx.project.id)}`;
    },

    async open_path() {
      return null;
    },

    async open_url() {
      return null;
    },

    async save_text_file() {
      unsupported("Browser downloads must use the file download endpoint.");
    },

    async list_dir(args, ctx) {
      const root = normalizeRoot(args.root);
      const rel = assertString(args.rel ?? "", "rel", { max: 4096 });
      const base = rootDirFor(ctx.project, root);
      const dir = resolveScopedPath(base, rel);
      let opened;
      try {
        opened = await openScopedDirectoryNoFollow(base, dir);
      } catch (err) {
        if (err?.code === "ENOENT" || (err instanceof HttpError && err.code === "file_not_found")) {
          if (root === "base" && rel === "knowledge-base") return [];
          throw new HttpError(404, "directory_not_found", "Directory not found.");
        }
        throw err;
      }
      try {
        const entries = await fs.readdir(opened.path, { withFileTypes: true });
        const maxEntries = finitePositive(ctx.config.maxWorkspaceScanEntries);
        if (maxEntries != null && entries.length > maxEntries) {
          throw new HttpError(413, "directory_too_large", `Directory contains more than ${maxEntries} entries.`);
        }
        const result = [];
        for (const entry of entries) {
          const stat = await fs.lstat(path.join(opened.path, entry.name));
          if (stat.isSymbolicLink()) continue;
          const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
          result.push({
            path: entryRel.replace(/\\/g, "/"),
            name: entry.name,
            isDir: stat.isDirectory(),
            size: stat.size,
            modified: Math.floor(stat.mtimeMs / 1000),
          });
        }
        result.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
        return result;
      } finally {
        await opened.handle.close();
      }
    },

    async write_workspace_file(args, ctx) {
      const root = normalizeRoot(args.root);
      const rel = assertString(args.path, "path", { max: 4096 });
      const content = assertString(args.content, "content", { max: ctx.config.maxFileBytes });
      const base = rootDirFor(ctx.project, root);
      const full = resolveScopedPath(base, rel);
      await withProjectStorageMutation(ctx.project, async () => {
        await assertProjectCapacity(ctx.project, full, Buffer.byteLength(content, "utf8"), ctx.config);
        await writeFileAtomicNoFollow(base, full, content, { encoding: "utf8" });
      });
      return null;
    },

    async probe_large_file(args, ctx) {
      const { base, full } = await resolveFile(ctx.project, args);
      const stat = await statExistingWorkspacePath(base, full, "file");
      if (!stat.isFile()) throw new HttpError(400, "not_a_file", "path is not a file.");
      return JSON.stringify({
        format: path.extname(full).replace(/^\./, "") || "unknown",
        size_bytes: stat.size,
        size: `${stat.size} bytes`,
        note: "Hosted web probe reports metadata only in this slice.",
      });
    },

    async record_provenance(args, ctx) {
      assertObject(args, "provenance");
      const rawArtifactPath = assertString(args.path, "path", { max: 4096 });
      const artifactPath = relativePathFromKnownRoots(
        rawArtifactPath,
        [runtimeManager.runtimeWorkspaceRoot(ctx.project), ctx.project.workspaceDir],
        "path",
      );
      const content = capProvenanceText(args.content ?? args.code);
      const rawLog = optionalLimitedString(args.log, "log", 4096);
      const log = rawLog?.split(rawArtifactPath).join(artifactPath);
      const sessionId = optionalLimitedString(args.sessionId, "sessionId", 256);
      const callId = optionalLimitedString(args.callId, "callId", 256);
      const model = optionalLimitedString(args.model, "model", 256);
      return withProjectStorageMutation(ctx.project, async () => {
        const existing = await readProvenance(ctx.project);
        if (callId && existing.some((item) => item.callId === callId && (item.sessionId ?? undefined) === sessionId)) {
          return null;
        }
        if (
          sessionId && content &&
          existing.some((item) => item.sessionId === sessionId && item.path === artifactPath && item.content === content)
        ) return null;
        const version = existing.filter((item) => item.path === artifactPath).length + 1;
        const record = {
          path: artifactPath,
          version,
          ts: Math.floor(Date.now() / 1000),
          tool: assertString(args.tool ?? "unknown", "tool", { max: 256 }),
          ...(content ? { content } : {}),
          ...(log ? { log } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(callId ? { callId } : {}),
          ...(model ? { model } : {}),
        };
        await appendProjectJsonl(ctx.project, "provenance.jsonl", record, { maxBytes: ctx.config.maxLogFileBytes });
        return null;
      });
    },

    async list_provenance(args, ctx) {
      const artifactPath = relativePathFromKnownRoots(
        args.path,
        [runtimeManager.runtimeWorkspaceRoot(ctx.project), ctx.project.workspaceDir],
        "path",
      );
      return (await readProvenance(ctx.project)).filter((record) => record.path === artifactPath);
    },

    async read_env_lockfile(args, ctx) {
      const hash = assertString(args.hash, "hash", { max: 128 });
      if (!/^[a-fA-F0-9]+$/.test(hash)) throw new HttpError(400, "invalid_hash", "invalid lockfile id.");
      const full = resolveScopedPath(ctx.project.metaDir, `env/${hash}.txt`);
      return readTextFileNoFollow(ctx.project.rootDir, full);
    },

    // Desktop experiment runs are indexed by Tauri/SQLite. Hosted research
    // runs are server-owned AgentRuns and are exposed through /api/agent-runs;
    // these explicit compatibility handlers prevent a browser from forging
    // provenance while keeping the shared command surface deterministic.
    async record_run() {
      throw new HttpError(403, "run_recording_server_managed", "Hosted run records are managed by the server.");
    },

    async list_runs() {
      return [];
    },

    async query_runs_cmd() {
      return { rows: [], total: 0, facets: { status: [], surface: [] } };
    },

    async read_run_log() {
      return null;
    },

    async science_mcp_python() {
      return null;
    },

    async setup_science_mcp() {
      unsupported("One-click MCP installation is deferred for the hosted web MVP.");
    },

    async install_example(args, ctx) {
      const name = assertString(args.name, "name", { max: 128 });
      if (!Object.hasOwn(BUNDLED_EXAMPLES, name)) {
        throw new HttpError(404, "example_not_found", "Example is not bundled on the server.");
      }
      return installBundledExample(name, ctx);
    },

    async detect_tools() {
      return [];
    },

    async get_approval_mode() {
      return config.approvalMode === "full" && config.allowFullApproval ? "full" : "approve";
    },

    async set_approval_mode(args) {
      const mode = assertString(args.mode, "mode", { max: 16 });
      if (mode !== "approve" && mode !== "full") {
        throw new HttpError(400, "invalid_approval_mode", "approval mode must be approve or full.");
      }
      throw new HttpError(
        403,
        "approval_mode_managed",
        "Hosted approval mode is configured by the server operator and cannot be changed by users.",
      );
    },

    // These two keep the retired kernel's name because the name is the wire:
    // an already-loaded browser bundle can still call them, and a rename would
    // turn each of those calls into an anonymous 404. Nothing in this repo
    // calls them any more — the desktop shell and its client are gone — and
    // both answer without a kernel: providers are configured by the
    // deployment, and there is no credential store to import from.
    async configure_opencode() {
      unsupported("Model/provider configuration is deferred for this web slice.");
    },

    async import_opencode_login() {
      return false;
    },

    async remove_config_entry() {
      unsupported("Provider and MCP configuration is managed by the server deployment.");
    },

    async list_ssh_hosts() {
      return [];
    },

    async hpc_config() {
      return null;
    },

    async set_hpc_config() {
      unsupported("HPC integration is deferred for hosted web mode.");
    },

    async hpc_check() {
      unsupported("HPC integration is deferred for hosted web mode.");
    },

    async hpc_jobs() {
      return [];
    },

    async hpc_cancel() {
      unsupported("HPC integration is deferred for hosted web mode.");
    },

    async modal_status() {
      return null;
    },

    async log_debug(args, ctx) {
      const message = assertString(args.message ?? "", "message", { max: 4096 });
      await appendProjectJsonl(ctx.project, "debug.jsonl", {
        createdAt: new Date().toISOString(),
        message,
      }, {
        maxBytes: ctx.config.maxLogFileBytes,
      });
      return null;
    },
  };

  return {
    has(command) {
      return Object.hasOwn(handlers, command);
    },
    canEnqueue(command) {
      return TASK_COMMAND_ALLOWLIST.has(command) && Object.hasOwn(handlers, command);
    },
    listTaskCommands() {
      return Object.keys(handlers).filter((command) => TASK_COMMAND_ALLOWLIST.has(command)).sort();
    },
    list() {
      return Object.keys(handlers).sort();
    },
    async invoke(command, args, ctx) {
      if (!Object.hasOwn(handlers, command)) {
        throw new HttpError(404, "unknown_command", `Command "${command}" is not available.`);
      }
      return handlers[command](assertObject(args ?? {}, "args"), ctx);
    },
  };
}
