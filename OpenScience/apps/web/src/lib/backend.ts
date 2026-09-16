// Thin wrappers over the control plane's command endpoint, one per command so
// a call site names what it wants rather than a string.
//
// This was the desktop bridge: every function branched on whether a packaged
// Tauri shell was present, and the desktop half held the native pickers, the
// SSH/HPC and Modal panels, the kernel-config writers and the local runs
// index. That shell is gone, and those functions are deleted rather than left
// returning "not on this platform" — a body that only says no reads like a
// feature that is merely switched off.

import type { FileRoot } from "@ai4s/shared";
import { hasWebApi, invokeCommand } from "./apiClient";

const NO_BACKEND = "no backend is configured";

/**
 * Pick local files through the browser and upload them into the workspace.
 * Returns the workspace file names; [] on cancel.
 */
export async function addFilesToWorkspace(targetDir = "", root: FileRoot = "workspace"): Promise<string[]> {
  if (!hasWebApi || typeof document === "undefined") return [];
  return uploadBrowserFiles(await pickBrowserFiles(), targetDir, root);
}

/**
 * Upload browser File objects (from a drag-and-drop zone) into a workspace
 * folder. Returns the uploaded workspace-relative paths.
 */
export async function uploadFilesToWorkspace(
  files: File[],
  targetDir = "",
  root: FileRoot = "workspace",
): Promise<string[]> {
  if (!hasWebApi) return [];
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
 * Write text into the workspace as a file, deduplicating the name on
 * collision. Returns the actual file name written.
 */
export async function addTextToWorkspace(filename: string, content: string): Promise<string> {
  if (!hasWebApi) throw new Error(NO_BACKEND);
  return invokeCommand<string>("add_text_to_workspace", { filename, content });
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
