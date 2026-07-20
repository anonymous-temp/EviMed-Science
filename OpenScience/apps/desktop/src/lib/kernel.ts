// Bridge to the desktop or hosted Python kernel. In a plain browser with no
// command backend these are no-ops so the app still runs in `pnpm dev`.
import type { FileRoot } from "@ai4s/shared";
import { hasCommandBackend, invokeCommand } from "./apiClient";

export interface ExecResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  result?: string | null;
  error?: string | null;
  artifacts?: unknown[];
}

export const KERNEL_UNAVAILABLE_MESSAGE = "（当前任务空间未配置计算内核）";

/** Languages with a kernel. A notebook runs one of these. */
export type KernelLanguage = "python" | "r";

/** True for cell languages that run on a kernel (vs. markdown/raw). */
export function isCodeLanguage(lang: string): lang is KernelLanguage {
  return lang === "python" || lang === "r";
}

/**
 * Run one cell in the persistent kernel for this notebook (Jupyter
 * semantics: one kernel per notebook, working directory = the notebook's
 * folder). `notebook` is the root-relative .ipynb path; omitting it runs in
 * the active workspace. Returns null when no command backend is configured.
 */
export async function kernelExecute(
  code: string,
  language: KernelLanguage = "python",
  notebook?: string,
  root?: FileRoot,
): Promise<ExecResult | null> {
  if (!hasCommandBackend) return null;
  return invokeCommand<ExecResult>("kernel_execute", { code, language, notebook, root });
}

/**
 * Restart kernel(s). With `notebook`, exactly that notebook's kernel is
 * killed (the Stop button on a hung cell — always returns promptly, even while
 * a cell is blocked mid-run); with no arguments, everything — e.g. after
 * switching workspace folder. No-op when no command backend is configured.
 */
export async function kernelReset(
  language?: KernelLanguage,
  notebook?: string,
  root?: FileRoot,
): Promise<void> {
  if (!hasCommandBackend) return;
  await invokeCommand("kernel_reset", { language, notebook, root });
}

/** Render a kernel result as the text shown under a notebook cell. */
export function formatExecResult(r: ExecResult): string {
  const stdout = trimOutput(r.stdout);
  const stderr = trimOutput(r.stderr);
  const result = trimOutput(r.result);
  const error = trimOutput(r.error);
  if (!r.ok) {
    return [stdout, stderr, error, result].filter(Boolean).join("\n") || "执行失败。";
  }
  const parts: string[] = [];
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(stderr);
  if (result) parts.push(result);
  return parts.join("\n") || "（无输出）";
}

function trimOutput(value: unknown): string {
  return typeof value === "string" ? value.trimEnd() : "";
}
