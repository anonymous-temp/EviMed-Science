import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import {
  buildDockerKernelLaunchPlan,
  cleanupKernelContainer,
  runLimitedProcess,
} from "./commands.mjs";
import { loadConfig } from "./config.mjs";
import { assertDockerDataVolumeSupport } from "./dockerMounts.mjs";
import { runtimeReleasePolicyError } from "./releaseManifest.mjs";
import {
  RUNTIME_EXIT_OUTPUT_BYTES,
  appendTailOutput,
  buildOpenCodeLaunchPlan,
  cleanupDockerContainer,
  runtimeContainerName,
} from "./runtimeManager.mjs";
import { RUNTIME_CONTROLLER_PROTOCOL_VERSION } from "./runtimeControllerClient.mjs";
import {
  HttpError,
  assertNoSymlinkPath,
  readJson,
  safeId,
  sendError,
  sendJson,
} from "./security.mjs";

const workspaceNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,127}$/;
const missingContainerPattern = /no such (?:object|container)|does not exist|no container with name/i;

function controllerFailure(status, code, message, options = {}) {
  return new HttpError(status, code, message, options);
}

function compactError(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 512);
}

function assertExactKeys(value, allowed) {
  const allowlist = new Set(allowed);
  const unexpected = Object.keys(value ?? {}).find((key) => !allowlist.has(key));
  if (unexpected) {
    throw controllerFailure(400, "runtime_controller_payload_invalid", "Runtime controller request contains unsupported fields.");
  }
}

async function requireDirectory(root, target, code) {
  await assertNoSymlinkPath(root, target);
  const stat = await fs.lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stat?.isDirectory()) {
    throw controllerFailure(404, code, "Runtime controller project directory is unavailable.");
  }
}

async function projectFromReference(config, value) {
  const userId = safeId(value?.userId, "user id");
  const projectId = safeId(value?.projectId, "project id");
  const activeWorkspace = value?.activeWorkspace == null ? "" : String(value.activeWorkspace);
  if (activeWorkspace && !workspaceNamePattern.test(activeWorkspace)) {
    throw controllerFailure(400, "runtime_controller_workspace_invalid", "Runtime controller workspace is invalid.");
  }

  const usersRoot = path.join(config.dataDir, "users");
  const userRoot = path.join(usersRoot, userId);
  const projectsRoot = path.join(userRoot, "projects");
  const rootDir = path.join(projectsRoot, projectId);
  const baseDir = path.join(rootDir, "workspace");
  const workspaceDir = activeWorkspace ? path.join(baseDir, activeWorkspace) : baseDir;
  const runtimeDir = path.join(rootDir, "runtime");
  const metaDir = path.join(rootDir, ".openscience");

  await requireDirectory(config.dataDir, rootDir, "runtime_controller_project_missing");
  await requireDirectory(rootDir, baseDir, "runtime_controller_workspace_missing");
  await requireDirectory(rootDir, workspaceDir, "runtime_controller_workspace_missing");
  await requireDirectory(rootDir, runtimeDir, "runtime_controller_runtime_dir_missing");

  return {
    id: projectId,
    userId,
    activeWorkspace,
    userRoot,
    rootDir,
    baseDir,
    workspaceDir,
    runtimeDir,
    metaDir,
  };
}

function dockerInfo(config) {
  const result = spawnSync(
    config.runtimeContainerBin,
    ["info", "--format", "{{.ServerVersion}}"],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (result.status !== 0) {
    throw controllerFailure(503, "runtime_docker_unavailable", "Docker is unavailable to the runtime controller.");
  }
  const version = result.stdout.trim();
  const major = Number(version.match(/^(\d+)/)?.[1]);
  if (!Number.isSafeInteger(major)) {
    throw controllerFailure(503, "runtime_docker_version_invalid", "Docker returned an invalid server version.");
  }
  return { version, major };
}

function inspectRuntimeImage(config) {
  const format = [
    "{{.Id}}",
    '{{index .Config.Labels "io.open-science.opencode.version"}}',
    '{{index .Config.Labels "io.open-science.uv.version"}}',
  ].join("|");
  const result = spawnSync(
    config.runtimeContainerBin,
    ["image", "inspect", "--format", format, config.runtimeContainerImage],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (result.status !== 0) {
    throw controllerFailure(503, "runtime_image_unavailable", "Runtime image is unavailable to the runtime controller.");
  }
  const [imageId, opencodeVersion, uvVersion] = result.stdout.trim().split("|");
  if (!imageId || !opencodeVersion || !uvVersion) {
    throw controllerFailure(503, "runtime_image_metadata_missing", "Runtime image metadata is incomplete.");
  }
  return { imageId, opencodeVersion, uvVersion };
}

function runtimeCapacityLimits(config) {
  const maxGlobal = Number(config.maxRunningRuntimes);
  const maxPerUser = Number(config.maxRunningRuntimesPerUser);
  if (
    !Number.isSafeInteger(maxGlobal) ||
    maxGlobal <= 0 ||
    !Number.isSafeInteger(maxPerUser) ||
    maxPerUser <= 0 ||
    maxPerUser > maxGlobal
  ) {
    throw controllerFailure(503, "runtime_controller_limits_invalid", "Runtime controller capacity limits are invalid.");
  }
  return { maxGlobal, maxPerUser };
}

function kernelCapacityLimits(config) {
  const maxGlobal = Number(config.maxConcurrentKernels);
  const maxPerUser = Number(config.maxConcurrentKernelsPerUser);
  if (
    !Number.isSafeInteger(maxGlobal) ||
    maxGlobal <= 0 ||
    !Number.isSafeInteger(maxPerUser) ||
    maxPerUser <= 0 ||
    maxPerUser > maxGlobal
  ) {
    throw controllerFailure(503, "runtime_controller_limits_invalid", "Runtime controller kernel limits are invalid.");
  }
  return { maxGlobal, maxPerUser };
}

function dockerManagedInventory(config, label, { all = false } = {}) {
  const result = spawnSync(
    config.runtimeContainerBin,
    [
      "ps",
      ...(all ? ["--all"] : []),
      "--filter",
      `label=${label}`,
      "--format",
      '{{.Names}}|{{.Label "open-science.user"}}',
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (result.status !== 0) {
    throw controllerFailure(503, "runtime_inventory_unavailable", "Runtime controller could not inspect managed containers.");
  }
  const inventory = new Map();
  for (const line of result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const separator = line.indexOf("|");
    const containerName = separator < 1 ? "" : line.slice(0, separator);
    const userId = separator < 1 ? "" : line.slice(separator + 1);
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(containerName) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(userId)
    ) {
      throw controllerFailure(503, "runtime_inventory_invalid", "Runtime controller received invalid container inventory metadata.");
    }
    inventory.set(containerName, userId);
  }
  return inventory;
}

function dockerRuntimeInventory(config) {
  return dockerManagedInventory(config, "open-science.web.runtime=true");
}

function dockerKernelInventory(config) {
  return dockerManagedInventory(config, "open-science.web.kernel=true", { all: true });
}

function cleanupStaleKernelContainers(config) {
  const inventory = dockerKernelInventory(config);
  for (const containerName of inventory.keys()) {
    const result = spawnSync(
      config.runtimeContainerBin,
      ["rm", "-f", containerName],
      { encoding: "utf8", timeout: 5_000 },
    );
    if (result.status !== 0 && !missingContainerPattern.test(compactError(result.stderr))) {
      throw controllerFailure(503, "kernel_orphan_cleanup_failed", "Runtime controller could not remove an orphaned kernel container.");
    }
  }
  return inventory.size;
}

function waitForChildExit(child, timeoutMs = 2_000) {
  if (!child || child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    child.once("exit", done);
    child.kill("SIGTERM");
  });
}

function waitForSpawn(child, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
      fn(value);
    };
    const onSpawn = () => finish(resolve);
    const onError = () => finish(
      reject,
      controllerFailure(502, "runtime_spawn_failed", "Runtime controller could not start the runtime container."),
    );
    const timer = setTimeout(
      () => finish(reject, controllerFailure(504, "runtime_spawn_timeout", "Runtime container launch timed out.")),
      timeoutMs,
    );
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

async function prepareControllerSocket(socketPath) {
  if (!path.isAbsolute(socketPath)) {
    throw controllerFailure(500, "runtime_controller_socket_invalid", "Runtime controller socket path must be absolute.");
  }
  const parent = path.dirname(socketPath);
  const parsed = path.parse(parent);
  const parts = path.relative(parsed.root, parent).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw controllerFailure(500, "runtime_controller_socket_symlink", "Runtime controller socket path must not contain symbolic links.");
    }
  }
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await fs.chmod(parent, 0o700);
  current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      throw controllerFailure(500, "runtime_controller_socket_symlink", "Runtime controller socket path must not contain symbolic links.");
    }
  }
  const existing = await fs.lstat(socketPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) {
    throw controllerFailure(500, "runtime_controller_socket_symlink", "Runtime controller socket must not be a symbolic link.");
  }
  if (existing && !existing.isSocket()) {
    throw controllerFailure(500, "runtime_controller_socket_invalid", "Runtime controller path is not a Unix socket.");
  }
  if (existing) {
    const active = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: socketPath });
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeListener("connect", onConnect);
        socket.removeListener("error", onError);
        socket.destroy();
        fn(value);
      };
      const onConnect = () => finish(resolve, true);
      const onError = (error) => {
        if (error?.code === "ECONNREFUSED" || error?.code === "ENOENT") {
          finish(resolve, false);
          return;
        }
        finish(
          reject,
          controllerFailure(503, "runtime_controller_socket_probe_failed", "Runtime controller socket could not be safely inspected."),
        );
      };
      const timer = setTimeout(
        () => finish(
          reject,
          controllerFailure(503, "runtime_controller_socket_probe_timeout", "Runtime controller socket inspection timed out."),
        ),
        500,
      );
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
    if (active) {
      throw controllerFailure(409, "runtime_controller_already_running", "A runtime controller is already listening on this socket.");
    }
    const socketStat = await fs.lstat(socketPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (socketStat && (socketStat.dev !== existing.dev || socketStat.ino !== existing.ino)) {
      throw controllerFailure(409, "runtime_controller_socket_changed", "Runtime controller socket changed during startup.");
    }
    if (socketStat) await fs.rm(socketPath, { force: true });
  }
}

export function createRuntimeController(overrides = {}) {
  const config = loadConfig(overrides);
  const runtimeChildren = new Map();
  const runtimeOwners = new Map();
  // The last words of each runtime container, kept past its own death. A
  // runtime is launched with `--rm`, so by the time anything notices it exited
  // the container is already reaped and `docker logs` has nothing to say; and
  // it was launched with `stdio: "ignore"`, so nobody was listening while it
  // was alive either. Between the two, "Runtime exited before it became ready"
  // was the entire diagnosis available to an operator — the reason the
  // container gave for dying was written to a pipe pointed at /dev/null.
  // Bounded per container and dropped when the next start replaces it.
  const runtimeExitOutput = new Map();
  const kernelChildren = new Map();
  const kernelOwners = new Map();
  const projectOperations = new Map();
  const socketPath = config.runtimeControllerSocket;
  let ownedSocket = null;

  function withProjectOperation(project, operation) {
    const key = `${project.userId}:${project.id}`;
    const previous = projectOperations.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    projectOperations.set(key, current);
    return current.finally(() => {
      if (projectOperations.get(key) === current) projectOperations.delete(key);
    });
  }

  function reserveRuntimeCapacity(project) {
    const limits = runtimeCapacityLimits(config);
    const inventory = dockerRuntimeInventory(config);
    for (const [containerName, userId] of runtimeOwners) {
      inventory.set(containerName, userId);
    }
    if (inventory.size >= limits.maxGlobal) {
      throw controllerFailure(
        429,
        "runtime_limit_exceeded",
        `Too many running runtimes for the server; limit is ${limits.maxGlobal}.`,
        { retryAfterSeconds: 5 },
      );
    }
    const userCount = [...inventory.values()].filter((userId) => userId === project.userId).length;
    if (userCount >= limits.maxPerUser) {
      throw controllerFailure(
        429,
        "runtime_limit_exceeded",
        `Too many running runtimes for this user; limit is ${limits.maxPerUser}.`,
        { retryAfterSeconds: 5 },
      );
    }
    runtimeOwners.set(runtimeContainerName(project), project.userId);
  }

  function reserveKernelCapacity(project, containerName) {
    const limits = kernelCapacityLimits(config);
    const inventory = dockerKernelInventory(config);
    for (const [name, userId] of kernelOwners) inventory.set(name, userId);
    if (inventory.size >= limits.maxGlobal) {
      throw controllerFailure(
        429,
        "kernel_limit_exceeded",
        `Too many kernels are running for the server; limit is ${limits.maxGlobal}.`,
        { retryAfterSeconds: 5 },
      );
    }
    const userCount = [...inventory.values()].filter((userId) => userId === project.userId).length;
    if (userCount >= limits.maxPerUser) {
      throw controllerFailure(
        429,
        "kernel_limit_exceeded",
        `Too many kernels are running for this user; limit is ${limits.maxPerUser}.`,
        { retryAfterSeconds: 5 },
      );
    }
    kernelOwners.set(containerName, project.userId);
  }

  async function cleanupRuntime(project) {
    const containerName = runtimeContainerName(project);
    const cleanup = await cleanupDockerContainer({
      command: config.runtimeContainerBin,
      containerName,
      cwd: project.workspaceDir,
      env: process.env,
    });
    const tracked = runtimeChildren.get(containerName);
    if (tracked) {
      await waitForChildExit(tracked);
      runtimeChildren.delete(containerName);
    }
    runtimeOwners.delete(containerName);
    runtimeExitOutput.delete(containerName);
    if (cleanup.failed) {
      throw controllerFailure(502, "runtime_cleanup_failed", "Runtime controller could not clean up the runtime container.");
    }
    return {
      cleaned: cleanup.cleaned,
      missing: cleanup.missing,
      failed: false,
      reason: cleanup.reason,
    };
  }

  async function startRuntime(project, payload) {
    assertDockerDataVolumeSupport(config);
    const port = Number(payload.port);
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
      throw controllerFailure(400, "runtime_controller_port_invalid", "Runtime controller port is invalid.");
    }
    const password = typeof payload.password === "string" ? payload.password : "";
    if (!/^pw_[A-Za-z0-9_-]{16,}$/.test(password)) {
      throw controllerFailure(400, "runtime_controller_password_invalid", "Runtime controller credential is invalid.");
    }
    const plan = buildOpenCodeLaunchPlan(config, project, port, password);
    await cleanupRuntime(project);
    reserveRuntimeCapacity(project);
    let child;
    try {
      child = spawn(plan.command, plan.args, {
        cwd: plan.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: plan.env,
      });
    } catch (error) {
      runtimeOwners.delete(plan.containerName);
      throw error;
    }
    runtimeChildren.set(plan.containerName, child);
    // Both streams, not just stderr: the kernel's own startup failures come out
    // on stdout as often as not, and `docker run`'s complaints about the image
    // or the mounts come out on stderr. The cap is per container and small —
    // this is a tail for a human to read, not a log store.
    runtimeExitOutput.set(plan.containerName, "");
    const collect = (chunk) => {
      runtimeExitOutput.set(
        plan.containerName,
        appendTailOutput(runtimeExitOutput.get(plan.containerName) ?? "", chunk, RUNTIME_EXIT_OUTPUT_BYTES),
      );
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("exit", () => {
      if (runtimeChildren.get(plan.containerName) === child) {
        runtimeChildren.delete(plan.containerName);
        runtimeOwners.delete(plan.containerName);
      }
    });
    try {
      await waitForSpawn(child);
    } catch (error) {
      await cleanupRuntime(project).catch(() => {});
      throw error;
    }
    return { containerName: plan.containerName };
  }

  function runtimeStatus(project) {
    const containerName = runtimeContainerName(project);
    const tracked = runtimeChildren.get(containerName);
    if (tracked && tracked.exitCode == null && tracked.signalCode == null) {
      return { state: "running", running: true, exitCode: null, containerName, output: "" };
    }
    // Only on the not-running paths. A running container's output is not a
    // diagnosis of anything, and shipping it on every poll would put the
    // runtime's chatter through the controller socket several times a second.
    //
    // Sent as captured, newlines and all. `compactError` collapses whitespace
    // to single spaces and cuts at 512 characters, which destroyed this on the
    // way out: the reader's filters are line-based, so a single joined line
    // meant they could not fire at all — and if that one line happened to match
    // one, the whole diagnosis was deleted. Bounded already, by the tail buffer.
    const output = String(runtimeExitOutput.get(containerName) ?? "");
    const result = spawnSync(
      config.runtimeContainerBin,
      ["container", "inspect", "--format", "{{.State.Status}}|{{.State.ExitCode}}", containerName],
      { encoding: "utf8", timeout: 5_000 },
    );
    if (result.status !== 0) {
      if (missingContainerPattern.test(compactError(result.stderr))) {
        return { state: "missing", running: false, containerName, output };
      }
      throw controllerFailure(503, "runtime_status_unavailable", "Runtime controller could not inspect the runtime container.");
    }
    const [state, exitCodeRaw] = result.stdout.trim().split("|");
    const exitCode = Number(exitCodeRaw);
    return {
      state: state || "unknown",
      running: state === "running" || state === "created" || state === "restarting",
      exitCode: Number.isSafeInteger(exitCode) ? exitCode : null,
      containerName,
      output,
    };
  }

  async function runKernel(project, language, code, req, res) {
    if (!config.enableKernel || config.kernelSandboxMode !== "docker") {
      throw controllerFailure(403, "kernel_disabled", "Runtime controller kernel execution is disabled.");
    }
    const releaseError = runtimeReleasePolicyError(config);
    if (releaseError) {
      throw controllerFailure(503, releaseError.code, "Runtime release provenance does not match the controller configuration.");
    }
    assertDockerDataVolumeSupport(config, "kernel_volume_subpath_unsupported");
    if (typeof code !== "string" || code.length > 64 * 1024) {
      throw controllerFailure(400, "kernel_code_invalid", "Kernel code is missing or too large.");
    }
    if (!["python", "r"].includes(language)) {
      throw controllerFailure(400, "unsupported_language", "Hosted kernels support python and r.");
    }
    const plan = buildDockerKernelLaunchPlan(project, config, language);
    reserveKernelCapacity(project, plan.containerName);
    const abortController = new AbortController();
    const abort = () => abortController.abort(new DOMException("Kernel controller client disconnected.", "AbortError"));
    const close = () => {
      if (!res.writableEnded) abort();
    };
    req.once("aborted", abort);
    res.once("close", close);
    try {
      return await runLimitedProcess({
        command: plan.command,
        args: plan.args,
        cwd: plan.cwd,
        stdin: code,
        signal: abortController.signal,
        maxOutputBytes: config.maxKernelOutputBytes,
        timeoutMs: config.kernelTimeoutMs,
        onSpawn: (child) => {
          kernelChildren.set(plan.containerName, child);
          child.once("exit", () => kernelChildren.delete(plan.containerName));
        },
        onAbort: () => cleanupKernelContainer(config, plan.containerName),
        onError: () => cleanupKernelContainer(config, plan.containerName),
      });
    } finally {
      kernelChildren.delete(plan.containerName);
      kernelOwners.delete(plan.containerName);
      req.removeListener("aborted", abort);
      res.removeListener("close", close);
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://runtime.controller");
    try {
      if (req.method === "GET" && url.pathname === "/v1/health") {
        const docker = dockerInfo(config);
        const limits = runtimeCapacityLimits(config);
        const kernelLimits = kernelCapacityLimits(config);
        if (config.releaseManifestError) {
          throw controllerFailure(503, config.releaseManifestError, "Runtime controller release manifest is invalid.");
        }
        if (config.production && !config.releaseManifest) {
          throw controllerFailure(503, "release_manifest_missing", "Runtime controller release manifest is required.");
        }
        sendJson(res, 200, {
          data: {
            protocolVersion: RUNTIME_CONTROLLER_PROTOCOL_VERSION,
            releaseId: config.releaseId,
            dockerMajor: docker.major,
            maxRunningRuntimes: limits.maxGlobal,
            maxRunningRuntimesPerUser: limits.maxPerUser,
            maxConcurrentKernels: kernelLimits.maxGlobal,
            maxConcurrentKernelsPerUser: kernelLimits.maxPerUser,
          },
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/docker/info") {
        sendJson(res, 200, { data: dockerInfo(config) });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/docker/runtime-image") {
        sendJson(res, 200, { data: inspectRuntimeImage(config) });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/runtime/status") {
        assertExactKeys(Object.fromEntries(url.searchParams), ["userId", "projectId", "activeWorkspace"]);
        const project = await projectFromReference(config, {
          userId: url.searchParams.get("userId"),
          projectId: url.searchParams.get("projectId"),
          activeWorkspace: url.searchParams.get("activeWorkspace") ?? "",
        });
        sendJson(res, 200, { data: runtimeStatus(project) });
        return;
      }
      if (req.method === "POST" && ["/v1/runtime/start", "/v1/runtime/cleanup", "/v1/kernel/run"].includes(url.pathname)) {
        if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
          throw controllerFailure(415, "runtime_controller_content_type_invalid", "Runtime controller requires JSON requests.");
        }
        const payload = await readJson(req, config.maxJsonBytes);
        const allowed = url.pathname === "/v1/runtime/start"
          ? ["userId", "projectId", "activeWorkspace", "port", "password"]
          : url.pathname === "/v1/kernel/run"
            ? ["userId", "projectId", "activeWorkspace", "language", "code"]
            : ["userId", "projectId", "activeWorkspace"];
        assertExactKeys(payload, allowed);
        const project = await projectFromReference(config, payload);
        if (url.pathname === "/v1/runtime/start") {
          let disconnected = req.aborted || res.destroyed;
          const disconnect = () => {
            if (!res.writableEnded) disconnected = true;
          };
          req.once("aborted", disconnect);
          res.once("close", disconnect);
          try {
            if (disconnected) return;
            const result = await withProjectOperation(project, async () => {
              if (disconnected || res.destroyed) return null;
              const started = await startRuntime(project, payload);
              if (disconnected || res.destroyed) {
                await cleanupRuntime(project).catch(() => {});
                return null;
              }
              return started;
            });
            if (!result) return;
            sendJson(res, 200, { data: result });
            return;
          } finally {
            req.removeListener("aborted", disconnect);
            res.removeListener("close", disconnect);
          }
        }
        if (url.pathname === "/v1/runtime/cleanup") {
          sendJson(res, 200, { data: await withProjectOperation(project, () => cleanupRuntime(project)) });
          return;
        }
        sendJson(res, 200, { data: await runKernel(project, payload.language ?? "python", payload.code, req, res) });
        return;
      }
      throw controllerFailure(404, "runtime_controller_route_not_found", "Runtime controller route not found.");
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const safe = error instanceof HttpError
        ? error
        : controllerFailure(500, "runtime_controller_internal", "Runtime controller operation failed.");
      sendError(res, safe);
    }
  }

  const server = http.createServer((req, res) => void handle(req, res));
  server.on("clientError", (_error, socket) => socket.destroy());

  return {
    config,
    socketPath,
    async listen() {
      if (server.listening || ownedSocket) {
        throw controllerFailure(409, "runtime_controller_already_running", "Runtime controller is already listening.");
      }
      await prepareControllerSocket(socketPath);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const socketStat = await fs.lstat(socketPath);
      ownedSocket = { dev: socketStat.dev, ino: socketStat.ino };
      await fs.chmod(socketPath, 0o600);
      try {
        cleanupStaleKernelContainers(config);
      } catch (error) {
        await new Promise((resolve) => server.close(() => resolve()));
        const current = await fs.lstat(socketPath).catch(() => null);
        if (current?.isSocket() && current.dev === ownedSocket.dev && current.ino === ownedSocket.ino) {
          await fs.rm(socketPath, { force: true });
        }
        ownedSocket = null;
        throw error;
      }
      return socketPath;
    },
    async close() {
      await Promise.allSettled(
        [...runtimeChildren.keys()].map(async (containerName) => {
          const child = runtimeChildren.get(containerName);
          const result = spawnSync(config.runtimeContainerBin, ["rm", "-f", containerName], { stdio: "ignore", timeout: 5_000 });
          await waitForChildExit(child);
          return result.status;
        }),
      );
      await Promise.allSettled(
        [...kernelChildren.entries()].map(async ([containerName, child]) => {
          spawnSync(config.runtimeContainerBin, ["rm", "-f", containerName], { stdio: "ignore", timeout: 5_000 });
          await waitForChildExit(child);
        }),
      );
      await Promise.resolve().then(() => cleanupStaleKernelContainers(config)).catch(() => {});
      runtimeChildren.clear();
      runtimeOwners.clear();
      kernelChildren.clear();
      kernelOwners.clear();
      if (server.listening) {
        await new Promise((resolve) => server.close(() => resolve()));
      }
      if (ownedSocket) {
        const current = await fs.lstat(socketPath).catch((error) => {
          if (error?.code === "ENOENT") return null;
          throw error;
        });
        if (current?.isSocket() && current.dev === ownedSocket.dev && current.ino === ownedSocket.ino) {
          await fs.rm(socketPath, { force: true });
        }
        ownedSocket = null;
      }
    },
  };
}
