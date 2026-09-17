// Read/open/download workspace files for artifact previews. In a plain browser
// without a configured Web API these return null / no-op so the app still runs
// in `pnpm dev`.
// Paths are root-relative; `root` picks the tree ("workspace" = the active
// session folder, default; "base" = the folder all session workspaces live under).
import type { ClaimVerification } from "./claimCitations";
import type { FileRoot } from "@ai4s/shared";
import { hasWebApi, invokeCommand, webFileDownloadUrl } from "./apiClient";

export type { FileRoot };

export interface ArtifactFile {
  path: string;
  mime: string;
  /** "utf8" for text, "base64" for binary. */
  encoding: "utf8" | "base64";
  data: string;
  size: number;
}

/** Read a root-relative file. Returns null when no desktop or hosted backend is configured. */
export async function readArtifact(path: string, root?: FileRoot): Promise<ArtifactFile | null> {
  if (!hasWebApi) return null;
  return invokeCommand<ArtifactFile>("read_artifact", { path, root });
}

/** Whether each claim of a clinical evidence matrix quotes the preserved source
 *  it names, as the control plane finds it on disk right now. */
export async function readClaimVerification(matrixPath: string, root?: FileRoot): Promise<ClaimVerification | null> {
  if (!hasWebApi) return null;
  return invokeCommand<ClaimVerification>("claim_verification", { path: matrixPath, root });
}

/** URL a workspace file is previewable at. Desktop uses the local file server;
 *  hosted Web uses the authenticated server preview endpoint. */
export async function previewUrl(path: string, root?: FileRoot): Promise<string | null> {
  if (!hasWebApi) return null;
  return invokeCommand<string>("preview_url", { path, root });
}

/** Open a root-relative file in the OS default application (desktop only). */
export async function openArtifactExternally(path: string, root?: FileRoot): Promise<void> {
  if (!hasWebApi) return;
  await invokeCommand("open_path", { path, root });
}

/** Download a root-relative hosted file through the authenticated Web API. */
export async function downloadArtifact(path: string, root?: FileRoot, filename?: string): Promise<void> {
  if (!hasWebApi) {
    await openArtifactExternally(path, root);
    return;
  }
  downloadUrl(webFileDownloadUrl(path, root), filename || filenameFromPath(path));
}

/** Download the immutable text captured in a historical tool event instead of
 * a same-named workspace file that a later session may have replaced. */
export function downloadInlineArtifact(content: string, filename: string): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  try {
    downloadUrl(url, filename || "download.txt");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function filenameFromPath(value: string): string {
  const name = value.replace(/\\/g, "/").split("/").filter(Boolean).pop();
  return name || "download";
}

function downloadUrl(url: string, filename: string): void {
  if (typeof document === "undefined") return;
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** Introspect a file too big to preview WITHOUT loading it: runs the bundled
 *  large-file probe and returns its compact memory pointer (schema / shape /
 *  sample / key numbers). Returns null when no desktop or hosted backend is
 *  configured; throws the probe's error message on failure. */
export async function probeLargeFile(path: string, root?: FileRoot): Promise<LargeFilePointer | null> {
  if (!hasWebApi) return null;
  const json = await invokeCommand<string>("probe_large_file", { path, root });
  return JSON.parse(json) as LargeFilePointer;
}

/** The probe's JSON pointer. Fields vary by format; these are the common ones
 *  the panel renders (all optional — unknown formats still show size + note). */
export interface LargeFilePointer {
  format?: string;
  size?: string;
  size_bytes?: number;
  note?: string;
  error?: string;
  hint?: string;
  // tables
  columns?: { name: string; dtype: string }[];
  n_columns?: number;
  approx_rows?: number;
  sample_head?: string[][];
  // genomics
  approx_reads?: number;
  approx_sequences?: number;
  approx_variants?: number;
  read_length?: { min: number; max: number; mean: number };
  samples?: string[];
  sample_ids?: string[];
  gzipped?: boolean;
  // hdf5 / fits / netcdf / parquet
  datasets?: { path: string; shape: number[]; dtype: string }[];
  num_rows?: number;
  [k: string]: unknown;
}

export interface NotebookEntry {
  path: string;
  /** Seconds since the epoch (newest first from the backend). */
  modified: number;
}

/** All .ipynb files under the root, newest first. `root: "base"` spans every
 *  session folder. */
export async function listNotebooks(root?: FileRoot): Promise<NotebookEntry[]> {
  if (!hasWebApi) return [];
  return invokeCommand<NotebookEntry[]>("list_notebooks", { root });
}

export interface DirEntry {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  /** Seconds since the epoch. */
  modified: number;
}

/** List one directory under the root (non-recursive; "" = the root). */
export async function listDir(rel: string, root?: FileRoot): Promise<DirEntry[]> {
  if (!hasWebApi) return [];
  return invokeCommand<DirEntry[]>("list_dir", { rel, root });
}

/** Write text to a root-relative path through the configured backend. */
export async function writeWorkspaceFile(
  path: string,
  content: string,
  root?: FileRoot,
): Promise<void> {
  if (!hasWebApi) throw new Error("no desktop or web backend is configured");
  await invokeCommand("write_workspace_file", { path, content, root });
}

/** Decode a base64 artifact into raw bytes for binary renderers (docx/xlsx/pptx). */
export function base64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
