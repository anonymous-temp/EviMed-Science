// Runtime bridge. Desktop builds call Tauri commands; hosted web builds can set
// VITE_OPEN_SCIENCE_API_URL and serve matching command endpoints.

import type { FileRoot } from "@ai4s/shared";
import { hasCommandBackend, invokeCommand, isTauri } from "./apiClient";

export { isTauri };

const NO_BACKEND = "no desktop or web backend is configured";

export interface OpenCodeCredentials {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export type ConfigureResult =
  | { ok: true; path: string }
  | { ok: false; reason: "not-desktop" }
  | { ok: false; reason: "error"; message: string };

/**
 * Start this project's agent runtime and return its base URL.
 *
 * Hosted backends start the server-managed runtime. The desktop shell bundles
 * no agent kernel any more, so there it always REJECTS, with the named
 * `local_agent_kernel_removed` error — callers must surface that rather than
 * read `null` as "nothing to do", which is how a dead runtime comes to look
 * like an app that is merely still connecting.
 */
export async function startRuntime(): Promise<string | null> {
  if (!hasCommandBackend) return null;
  return invokeCommand<string>("start_runtime");
}

/**
 * Per-run password the sidecar requires on every request (desktop only —
 * browser dev talks to a user-run, passwordless `opencode serve`). Held in
 * memory on both sides; never persisted.
 */
export async function runtimePassword(): Promise<string | null> {
  if (!hasCommandBackend) return null;
  return invokeCommand<string>("runtime_password");
}

/**
 * Pick local files via the native dialog and copy them into the agent
 * workspace (desktop only). Returns the workspace file names; [] on cancel.
 */
export async function addFilesToWorkspace(targetDir = "", root: FileRoot = "workspace"): Promise<string[]> {
  if (isTauri) return invokeCommand<string[]>("add_files_to_workspace");
  if (!hasCommandBackend || typeof document === "undefined") return [];
  return uploadBrowserFiles(await pickBrowserFiles(), targetDir, root);
}

/**
 * Upload browser File objects (from a drag-and-drop zone) into a workspace
 * folder. Hosted web only: the desktop webview intercepts OS file drops
 * natively (the HTML5 handlers never fire) and its command set has no binary
 * write, so the desktop keeps the native picker path above. Returns the
 * uploaded workspace-relative paths.
 */
export async function uploadFilesToWorkspace(
  files: File[],
  targetDir = "",
  root: FileRoot = "workspace",
): Promise<string[]> {
  if (isTauri || !hasCommandBackend) return [];
  return uploadBrowserFiles(files, targetDir, root);
}

async function uploadBrowserFiles(files: File[], targetDir: string, root: FileRoot): Promise<string[]> {
  const uploaded: string[] = [];
  const prefix = targetDir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  for (const file of files) {
    const data = await fileToBase64(file);
    const filename = prefix ? `${prefix}/${file.name}` : file.name;
    uploaded.push(
      await invokeCommand<string>("upload_file", {
        root,
        filename,
        encoding: "base64",
        data,
      }),
    );
  }
  return uploaded;
}

/**
 * Write text into the workspace as a file (desktop only), deduplicating the
 * name on collision. Returns the actual file name written.
 */
export async function addTextToWorkspace(filename: string, content: string): Promise<string> {
  if (!hasCommandBackend) throw new Error(NO_BACKEND);
  return invokeCommand<string>("add_text_to_workspace", { filename, content });
}

/**
 * Explicitly import the user's OpenCode CLI login into the app's private
 * runtime (desktop only). Returns false when no CLI login exists; the sidecar
 * is restarted on success.
 */
export async function importOpenCodeLogin(): Promise<boolean> {
  if (!hasCommandBackend) return false;
  return invokeCommand<boolean>("import_opencode_login");
}

/** How agent actions get approved — the composer's Codex-style switch.
 *  "approve": dangerous shell commands (delete / install / remote / privilege)
 *  and web fetches prompt first. "full": everything in-workspace just runs. */
export type ApprovalMode = "approve" | "full";

/** The approval mode OpenCode's config currently holds ("approve" until changed). */
export async function getApprovalMode(): Promise<ApprovalMode> {
  if (!hasCommandBackend) return "approve";
  const mode = await invokeCommand<string>("get_approval_mode");
  return mode === "full" ? "full" : "approve";
}

/** Switch the approval mode; the sidecar restarts — the caller must reconnect. */
export async function setApprovalMode(mode: ApprovalMode): Promise<void> {
  if (!hasCommandBackend) return;
  await invokeCommand("set_approval_mode", { mode });
}

/** Remove a provider/mcp entry from the global OpenCode config (restarts the sidecar). */
export async function removeConfigEntry(section: "provider" | "mcp", key: string): Promise<void> {
  if (!hasCommandBackend) throw new Error(NO_BACKEND);
  await invokeCommand("remove_config_entry", { section, key });
}

export interface JupyterStatus {
  installed: boolean;
  running: boolean;
  url: string | null;
  token: string | null;
  mcp_command: string | null;
}

/** State of the app-managed Jupyter environment (desktop only). */
export async function jupyterStatus(): Promise<JupyterStatus | null> {
  if (!hasCommandBackend) return null;
  return invokeCommand<JupyterStatus>("jupyter_status");
}

/** Provision the isolated Jupyter env via bundled uv (first run: minutes, ~hundreds of MB). */
export async function setupJupyter(): Promise<void> {
  if (!hasCommandBackend) throw new Error(NO_BACKEND);
  await invokeCommand("setup_jupyter");
}

/** Start the managed headless jupyter-lab (idempotent). */
export async function startJupyter(): Promise<JupyterStatus> {
  if (!hasCommandBackend) throw new Error(NO_BACKEND);
  return invokeCommand<JupyterStatus>("start_jupyter");
}

/** Managed interpreter path for the shared science-MCP env, or null if not yet
 *  provisioned (desktop only). */
export async function scienceMcpPython(): Promise<string | null> {
  if (!hasCommandBackend) return null;
  return invokeCommand<string | null>("science_mcp_python");
}

/** Provision one open-source MCP pip package into the shared isolated env and
 *  return the managed Python path to launch it with (desktop only). */
export async function setupScienceMcp(pkg: string): Promise<string> {
  if (!hasCommandBackend) throw new Error(NO_BACKEND);
  return invokeCommand<string>("setup_science_mcp", { package: pkg });
}

/** Auto-start Jupyter on launch when it was enabled before. Silent no-op otherwise. */
export async function ensureJupyter(): Promise<void> {
  try {
    const s = await jupyterStatus();
    if (s?.installed && !s.running) await startJupyter();
  } catch {
    /* Jupyter is optional — never block the app on it */
  }
}

/** Open an http(s) URL in the system browser (never navigates the webview). */
export async function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  if (isTauri) {
    try {
      await invokeCommand("open_url", { url });
    } catch {
      /* opening a link must never break the app */
    }
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export type SaveResult =
  | { kind: "saved"; path: string }
  | { kind: "canceled" }
  | { kind: "not-desktop" };

/** Save text via the native "Save As" dialog (desktop only). Throws on write failure. */
export async function saveTextFile(filename: string, content: string): Promise<SaveResult> {
  if (!isTauri) return { kind: "not-desktop" };
  const path = await invokeCommand<string | null>("save_text_file", { filename, content });
  return path ? { kind: "saved", path } : { kind: "canceled" };
}

/** The active workspace directory (desktop only; null in browser). */
export async function workspacePath(): Promise<string | null> {
  if (!hasCommandBackend) return null;
  try {
    return await invokeCommand<string>("workspace_path");
  } catch {
    return null;
  }
}

/** The base folder new dated workspaces are created under (desktop only). */
export async function workspaceBase(): Promise<string | null> {
  if (!hasCommandBackend) return null;
  try {
    return await invokeCommand<string>("workspace_base");
  } catch {
    return null;
  }
}

/** Choose the base folder new session workspaces are created under.
 *  Returns the canonical path. Throws in the browser. */
export async function setWorkspaceBase(path: string): Promise<string> {
  if (!hasCommandBackend) throw new Error(NO_BACKEND);
  return invokeCommand<string>("set_workspace_base", { path });
}

/** Reveal the base workspace folder in the OS file manager. */
export async function openWorkspaceBase(): Promise<void> {
  if (!isTauri) return;
  await invokeCommand("open_workspace_base");
}

/** Switch the active workspace folder (creates it if needed; the runtime
 *  rescopes via `?directory=` — no restart). Returns the canonical path.
 *  Throws in the browser. */
export async function setWorkspace(path: string): Promise<string> {
  if (!hasCommandBackend) throw new Error(NO_BACKEND);
  return invokeCommand<string>("set_workspace", { path });
}

/** Create a new dated folder under the base workspace and switch to it. */
export async function newDatedWorkspace(name: string): Promise<string> {
  if (!hasCommandBackend) throw new Error(NO_BACKEND);
  return invokeCommand<string>("new_dated_workspace", { name });
}

/** Native folder picker; null on cancel or in the browser. */
export async function pickFolder(): Promise<string | null> {
  if (!isTauri) return null;
  return invokeCommand<string | null>("pick_folder");
}

export interface ToolStatus {
  name: string;
  found: boolean;
  version?: string | null;
}

/** Detect scientific/runtime tools on the user's system (desktop only). */
export async function detectTools(): Promise<ToolStatus[]> {
  if (!hasCommandBackend) return [];
  return invokeCommand<ToolStatus[]>("detect_tools");
}

export interface HpcCheck {
  reachable: boolean;
  slurm: string | null;
  message: string | null;
}

export interface HpcJob {
  id: string;
  state: string;
  time: string;
  partition: string;
  name: string;
}

/** Host aliases from the user's ~/.ssh/config (desktop only). */
export async function listSshHosts(): Promise<string[]> {
  if (!hasCommandBackend) return [];
  return invokeCommand<string[]>("list_ssh_hosts");
}

/** The configured cluster host, or null (desktop only). */
export async function hpcConfig(): Promise<string | null> {
  if (!hasCommandBackend) return null;
  return invokeCommand<string | null>("hpc_config");
}

/** Persist (or clear, with null) the cluster host — shared with the agent via
 *  the workspace's .openscience/hpc.json. */
export async function setHpcConfig(host: string | null): Promise<void> {
  if (!hasCommandBackend) throw new Error(NO_BACKEND);
  await invokeCommand("set_hpc_config", { host });
}

/** Probe a host over SSH: reachable? Slurm available? */
export async function hpcCheck(host: string): Promise<HpcCheck> {
  if (!hasCommandBackend) throw new Error(NO_BACKEND);
  return invokeCommand<HpcCheck>("hpc_check", { host });
}

/** The user's queued/running Slurm jobs on the host. */
export async function hpcJobs(host: string): Promise<HpcJob[]> {
  if (!hasCommandBackend) return [];
  return invokeCommand<HpcJob[]>("hpc_jobs", { host });
}

/** Cancel one of the user's Slurm jobs. */
export async function hpcCancel(host: string, jobId: string): Promise<void> {
  if (!hasCommandBackend) throw new Error(NO_BACKEND);
  await invokeCommand("hpc_cancel", { host, jobId });
}

export interface ModalStatus {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  hint: string | null;
}

/** Detect whether the user's Modal CLI is installed and authenticated. */
export async function modalStatus(): Promise<ModalStatus | null> {
  if (!hasCommandBackend) return null;
  return invokeCommand<ModalStatus>("modal_status");
}

/** Copy a bundled example project into the workspace (idempotent; never
 *  overwrites user edits). Returns the workspace directory name. */
export async function installExample(name: string): Promise<string> {
  if (!hasCommandBackend) throw new Error(NO_BACKEND);
  return invokeCommand<string>("install_example", { name });
}

/** Append a diagnostic line to <app-data>/debug.log (desktop only; no-op in browser). */
export async function logDebug(message: string): Promise<void> {
  if (!hasCommandBackend) return;
  try {
    await invokeCommand("log_debug", { message });
  } catch {
    /* never let diagnostics break the app */
  }
}

/** Write the provider key/model into OpenCode's config via the Rust command. */
export async function configureOpenCode(
  creds: OpenCodeCredentials,
): Promise<ConfigureResult> {
  if (!hasCommandBackend) return { ok: false, reason: "not-desktop" };
  try {
    const path = await invokeCommand<string>("configure_opencode", {
      provider: creds.provider,
      apiKey: creds.apiKey,
      model: creds.model,
      baseUrl: creds.baseUrl ?? null,
    });
    return { ok: true, path };
  } catch (e) {
    return { ok: false, reason: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

function pickBrowserFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.position = "fixed";
    input.style.left = "-10000px";
    input.style.top = "-10000px";
    const done = (files: File[]) => {
      cleanup();
      input.remove();
      resolve(files);
    };
    const onChange = () => done(Array.from(input.files ?? []));
    // The OS dialog can also be dismissed without a pick — resolve empty so
    // callers' finally blocks (button spinners) always run. Older engines
    // without the cancel event fall back to a window-refocus check.
    const onCancel = () => done([]);
    const onFocus = () => {
      window.setTimeout(() => {
        if (!input.files?.length) done([]);
      }, 300);
    };
    const cleanup = () => {
      input.removeEventListener("change", onChange);
      input.removeEventListener("cancel", onCancel);
      window.removeEventListener("focus", onFocus);
      window.clearTimeout(fallback);
    };
    input.addEventListener("change", onChange);
    input.addEventListener("cancel", onCancel);
    // Engines without the cancel event: the window regains focus when the OS
    // dialog closes; give the change event a beat, then treat it as a cancel.
    if (!("oncancel" in input)) window.addEventListener("focus", onFocus);
    // Last-resort settle: the picker flow can never outlive this.
    const fallback = window.setTimeout(onCancel, 5 * 60 * 1000);
    document.body.appendChild(input);
    input.click();
  });
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
