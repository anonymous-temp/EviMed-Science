import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { assertDockerDataVolumeSupport, dockerWorkspaceMount } from "./dockerMounts.mjs";
import { runtimeReleasePolicyError } from "./releaseManifest.mjs";
import {
  HttpError,
  apiBaseFromRequest,
  appendJsonLineNoFollow,
  assertObject,
  assertProjectCapacity,
  assertProjectUsageWithinQuota,
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

function assertKernelExecutionAllowed(config) {
  if (!config.enableKernel) {
    throw new HttpError(501, "kernel_disabled", "Server-side kernels are disabled until sandboxing is configured.");
  }
  if (config.kernelSandboxMode === "docker") {
    const releasePolicy = runtimeReleasePolicyError(config);
    if (releasePolicy) {
      throw new HttpError(503, releasePolicy.code, "Kernel image provenance is missing or does not match deployment configuration.");
    }
    return "docker";
  }
  if (config.kernelSandboxMode === "host") {
    if (config.production || !config.allowUnsandboxedKernel) {
      throw new HttpError(403, "kernel_sandbox_required", "Host Python kernels are not allowed for hosted production mode.");
    }
    return "host";
  }
  throw new HttpError(400, "invalid_kernel_sandbox", "Unsupported kernel sandbox mode.");
}

const workspaceNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,127}$/;

async function resolveKernelTarget(args, ctx, { requireNotebook = true } = {}) {
  const root = normalizeRoot(args.root);
  const notebook = args.notebook == null || args.notebook === ""
    ? ""
    : normalizeWorkspaceRelativePath(args.notebook, "notebook");
  let project = ctx.project;
  let notebookWithinWorkspace = notebook;

  if (notebook && requireNotebook) {
    const base = rootDirFor(ctx.project, root);
    const stat = await statExistingWorkspacePath(base, resolveScopedPath(base, notebook));
    if (!stat.isFile()) throw new HttpError(400, "not_a_file", "notebook is not a file.");
  }

  if (notebook && root === "base") {
    const parts = notebook.split("/");
    const activeWorkspace = parts.length > 1 ? parts.shift() : "";
    if (activeWorkspace && !workspaceNamePattern.test(activeWorkspace)) {
      throw new HttpError(400, "invalid_workspace", "notebook workspace contains unsupported characters.");
    }
    project = {
      ...ctx.project,
      activeWorkspace,
      workspaceDir: activeWorkspace ? path.join(ctx.project.baseDir, activeWorkspace) : ctx.project.baseDir,
    };
    notebookWithinWorkspace = parts.join("/");
  }

  const directory = notebookWithinWorkspace ? path.posix.dirname(notebookWithinWorkspace) : ".";
  return {
    project,
    workingDirectory: directory === "." ? "" : directory,
    key: `${ctx.project.userId}:${ctx.project.id}:${root}:${notebook}`,
  };
}

function kernelCodeForWorkingDirectory(code, workingDirectory) {
  if (!workingDirectory) return code;
  return [
    "import os as __open_science_os",
    `__open_science_os.chdir(${JSON.stringify(workingDirectory)})`,
    "del __open_science_os",
    code,
  ].join("\n");
}

function rCodeForWorkingDirectory(code, workingDirectory) {
  if (!workingDirectory) return code;
  return [`setwd(${JSON.stringify(workingDirectory)})`, code].join("\n");
}

// Hosted notebook cells run as short-lived, isolated Python processes. Mirror
// Jupyter's most useful display-hook behavior by evaluating a final expression
// and printing its repr, while leaving ordinary scripts and explicit stdout
// untouched. The original cell is embedded as a JSON string, never interpolated
// as wrapper syntax.
function kernelCodeWithDisplayHook(code) {
  return [
    "import ast as __evimed_ast",
    `__evimed_source = ${JSON.stringify(code)}`,
    "__evimed_tree = __evimed_ast.parse(__evimed_source, '<cell>', 'exec')",
    "if __evimed_tree.body and isinstance(__evimed_tree.body[-1], __evimed_ast.Expr):",
    "    __evimed_prefix = __evimed_ast.Module(body=__evimed_tree.body[:-1], type_ignores=[])",
    "    if __evimed_prefix.body:",
    "        exec(compile(__evimed_ast.fix_missing_locations(__evimed_prefix), '<cell>', 'exec'), globals(), globals())",
    "    __evimed_expression = __evimed_ast.Expression(__evimed_tree.body[-1].value)",
    "    __evimed_value = eval(compile(__evimed_ast.fix_missing_locations(__evimed_expression), '<cell>', 'eval'), globals(), globals())",
    "    if __evimed_value is not None:",
    "        print(repr(__evimed_value))",
    "else:",
    "    exec(compile(__evimed_tree, '<cell>', 'exec'), globals(), globals())",
  ].join("\n");
}

const TASK_COMMAND_ALLOWLIST = new Set([
  "add_text_to_workspace",
  "install_example",
  "kernel_execute",
  "list_dir",
  "list_notebooks",
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
  const activeKernelExecutions = new Map();

  function trackKernelExecution(key, controller) {
    const controllers = activeKernelExecutions.get(key) ?? new Set();
    controllers.add(controller);
    activeKernelExecutions.set(key, controllers);
    return () => {
      controllers.delete(controller);
      if (controllers.size === 0) activeKernelExecutions.delete(key);
    };
  }

  const handlers = {
    async start_runtime(_args, ctx) {
      await runtimeManager.start(ctx.project);
      return `${publicApiBase(ctx)}/opencode/${encodeURIComponent(ctx.project.id)}`;
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
      return `${publicApiBase(ctx)}/opencode/${encodeURIComponent(ctx.project.id)}`;
    },

    async runtime_status(_args, ctx) {
      return await runtimeManager.status(ctx.project);
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

    async list_notebooks(args, ctx) {
      const root = normalizeRoot(args.root);
      const base = rootDirFor(ctx.project, root);
      const notebooks = [];
      await walk(base, async (rel, _full, stat) => {
        if (!rel.endsWith(".ipynb")) return;
        if (!stat.isFile()) return;
        notebooks.push({ path: rel, modified: Math.floor(stat.mtimeMs / 1000) });
      }, "", walkState(ctx.config)).catch(rethrowHttpError);
      notebooks.sort((a, b) => b.modified - a.modified);
      return notebooks;
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

    async kernel_execute(args, ctx) {
      const sandboxMode = assertKernelExecutionAllowed(config);
      const language = (args.language == null ? "python" : assertString(args.language, "language", { max: 32 })).toLowerCase();
      if (!["python", "r"].includes(language)) {
        throw new HttpError(400, "unsupported_language", "Hosted kernels support python and r.");
      }
      const code = assertString(args.code, "code", { max: 64 * 1024 });
      const target = await resolveKernelTarget(args, ctx);
      const executableCode = language === "python"
        ? kernelCodeWithDisplayHook(kernelCodeForWorkingDirectory(code, target.workingDirectory))
        : rCodeForWorkingDirectory(code, target.workingDirectory);
      if (executableCode.length > 64 * 1024) {
        throw new HttpError(400, "invalid_payload", "code is too long after applying the notebook working directory.");
      }
      const controller = new AbortController();
      const release = trackKernelExecution(target.key, controller);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
      try {
        if (sandboxMode === "docker") runtimeManager.assertDockerControlBoundary();
        const result = sandboxMode === "docker"
          ? runtimeManager.usesRuntimeController()
            ? await runtimeManager.runControlledKernel(target.project, executableCode, signal, language)
            : await runDockerKernel(executableCode, target.project, signal, config, language)
          : await runHostKernel(
              executableCode,
              target.project.workspaceDir,
              signal,
              language === "python" ? config.kernelPythonBin : config.kernelRBin,
              language,
              config.maxKernelOutputBytes,
              config.kernelTimeoutMs,
            );
        await assertProjectUsageWithinQuota(ctx.project, ctx.config);
        return result;
      } finally {
        release();
      }
    },

    async kernel_reset(args, ctx) {
      const language = (args.language == null ? "python" : assertString(args.language, "language", { max: 32 })).toLowerCase();
      if (!["python", "r"].includes(language)) throw new HttpError(400, "unsupported_language", "Hosted kernels support python and r.");
      const notebook = args.notebook == null || args.notebook === ""
        ? ""
        : normalizeWorkspaceRelativePath(args.notebook, "notebook");
      const targets = [];
      if (notebook) {
        const target = await resolveKernelTarget(args, ctx, { requireNotebook: false });
        targets.push(activeKernelExecutions.get(target.key));
      } else {
        const prefix = `${ctx.project.userId}:${ctx.project.id}:`;
        for (const [key, controllers] of activeKernelExecutions) {
          if (key.startsWith(prefix)) targets.push(controllers);
        }
      }
      for (const controllers of targets) {
        for (const controller of controllers ?? []) {
          controller.abort(new DOMException("Kernel execution was reset.", "AbortError"));
        }
      }
      return null;
    },

    async jupyter_status() {
      return { installed: false, running: false, url: null };
    },

    async setup_jupyter() {
      unsupported("Jupyter provisioning is deferred for the hosted web MVP.");
    },

    async start_jupyter() {
      unsupported("Jupyter provisioning is deferred for the hosted web MVP.");
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

function appendLimitedOutput(current, chunk, state, maxBytes) {
  if (state.truncated) return current;
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = maxBytes - state.bytes;
  if (remaining <= 0) {
    state.truncated = true;
    return `${current}\n[evimed: output truncated after ${maxBytes} bytes]\n`;
  }
  const slice = buffer.subarray(0, remaining);
  state.bytes += slice.length;
  const next = `${current}${slice.toString("utf8")}`;
  if (slice.length < buffer.length) {
    state.truncated = true;
    return `${next}\n[evimed: output truncated after ${maxBytes} bytes]\n`;
  }
  return next;
}

function dockerSecurityArgs(config) {
  const args = [];
  if (config.runtimeNoNewPrivileges !== false) {
    args.push("--security-opt", "no-new-privileges");
  }
  if (config.runtimeCapDrop) {
    args.push("--cap-drop", String(config.runtimeCapDrop));
  }
  if (Number.isFinite(config.runtimePidsLimit) && config.runtimePidsLimit > 0) {
    args.push("--pids-limit", String(config.runtimePidsLimit));
  }
  if (config.runtimeReadOnlyRoot !== false) {
    args.push("--read-only");
  }
  if (config.runtimeTmpfs) {
    args.push("--tmpfs", String(config.runtimeTmpfs));
  }
  if (config.runtimeContainerUser) {
    args.push("--user", String(config.runtimeContainerUser));
  }
  return args;
}

function safeContainerSegment(value) {
  return String(value ?? "project").toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 36) || "project";
}

function kernelContainerName(project) {
  const token = randomBytes(5).toString("hex");
  return `open-science-kernel-${safeContainerSegment(project.userId)}-${safeContainerSegment(project.id)}-${token}`.slice(0, 120);
}

export function cleanupKernelContainer(config, containerName) {
  if (!containerName) return;
  const child = spawn(config.runtimeContainerBin, ["rm", "-f", containerName], {
    stdio: "ignore",
    env: process.env,
  });
  child.on("error", () => {});
}

export function buildDockerKernelLaunchPlan(project, config, language = "python") {
  if (!["python", "r"].includes(language)) {
    throw new HttpError(400, "unsupported_language", "Hosted kernels support python and r.");
  }
  const containerName = kernelContainerName(project);
  const args = [
    "run",
    "--interactive",
    "--rm",
    "--init",
    ...(config.runtimeRequireImageLocal ? ["--pull", "never"] : []),
    "--name",
    containerName,
    "--label",
    "open-science.web.kernel=true",
    "--label",
    `open-science.user=${project.userId}`,
    "--label",
    `open-science.project=${project.id}`,
    ...dockerSecurityArgs(config),
    "--network",
    "none",
    "--cpus",
    String(config.runtimeCpuLimit),
    "--memory",
    String(config.runtimeMemoryLimit),
    "--mount",
    dockerWorkspaceMount(config, project),
    "--workdir",
    "/workspace",
    ...(language === "python" ? ["--env", "PYTHONUNBUFFERED=1"] : []),
    config.runtimeContainerImage,
    language === "python" ? "python" : "Rscript",
    "-",
  ];
  return {
    containerName,
    command: config.runtimeContainerBin,
    args,
    cwd: project.workspaceDir,
  };
}

function runDockerKernel(code, project, signal, config, language) {
  assertDockerDataVolumeSupport(config, "kernel_volume_subpath_unsupported");
  const plan = buildDockerKernelLaunchPlan(project, config, language);
  return runLimitedProcess({
    command: plan.command,
    args: plan.args,
    cwd: plan.cwd,
    stdin: code,
    signal,
    maxOutputBytes: config.maxKernelOutputBytes,
    timeoutMs: config.kernelTimeoutMs,
    onAbort: () => cleanupKernelContainer(config, plan.containerName),
    onError: () => cleanupKernelContainer(config, plan.containerName),
  });
}

function runHostKernel(code, cwd, signal, executable, language, maxOutputBytes, timeoutMs) {
  return runLimitedProcess({
    command: executable,
    args: language === "python" ? ["-c", code] : ["-"],
    cwd,
    stdin: language === "r" ? code : undefined,
    signal,
    maxOutputBytes,
    timeoutMs,
  });
}

export function runLimitedProcess({ command, args, cwd, stdin, signal, maxOutputBytes, timeoutMs, onAbort, onError, onSpawn }) {
  return new Promise((resolve) => {
    const outputLimit = Math.max(0, Math.floor(Number.isFinite(maxOutputBytes) ? maxOutputBytes : 1024 * 1024));
    const processTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : null;
    const child = spawn(command, args, { cwd, stdio: [stdin == null ? "ignore" : "pipe", "pipe", "pipe"] });
    onSpawn?.(child);
    let stdout = "";
    let stderr = "";
    const stdoutState = { bytes: 0, truncated: false };
    const stderrState = { bytes: 0, truncated: false };
    let aborted = false;
    let timedOut = false;
    let settled = false;
    const finish = (code, error = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const suffix = error
        ? error.message
        : timedOut
          ? `Execution timed out after ${processTimeoutMs}ms.`
          : aborted
            ? "Execution was aborted."
            : "";
      resolve({
        ok: code === 0 && !aborted && !timedOut && !error,
        stdout,
        stderr: suffix ? `${stderr}${stderr ? "\n" : ""}${suffix}` : stderr,
        artifacts: [],
      });
    };
    const abort = () => {
      aborted = true;
      onAbort?.();
      child.kill("SIGKILL");
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = processTimeoutMs == null
      ? null
      : setTimeout(() => {
          timedOut = true;
          onAbort?.();
          child.kill("SIGKILL");
        }, processTimeoutMs);
    if (stdin != null && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    }
    child.stdout.on("data", (chunk) => {
      stdout = appendLimitedOutput(stdout, chunk, stdoutState, outputLimit);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimitedOutput(stderr, chunk, stderrState, outputLimit);
    });
    child.once("error", (err) => {
      onError?.();
      finish(1, err);
    });
    child.on("close", (code) => finish(code));
  });
}
