import { fetchMyCapsule } from "@/lib/memoryClient";
import { previewCapsuleExport } from "@/lib/productClient";

/** The three things a person's way of working is said in. */
export interface WorkStyle { methods: number; standards: number; background: number; total: number }

/**
 * 工作方式: what a capsule would hand over, in the three named categories of its card — 方法 (a way of doing the work), 标准与偏好 (how it
 * should come out: preferences, writing habits, corrections, the tools used) and 背景 (who they are and what they know) — from the entries a
 * preview lists. The kinds are the capsule's own (`CAPSULE_FACT_KINDS`); one that is none of the first two is background.
 */
export function workStyle(entries: ReadonlyArray<{ factKind: string }>): WorkStyle {
  const standards = new Set(["preference", "writing_style", "correction", "tooling", "behavior"]);
  let methods = 0;
  let others = 0;
  let background = 0;
  for (const entry of entries) {
    if (entry.factKind === "method_preference") methods += 1;
    else if (standards.has(entry.factKind)) others += 1;
    else background += 1;
  }
  return { methods, standards: others, background, total: methods + others + background };
}

/** What the hand-over is read from: the scopes the share dialog offers by default, so the sentence says what a file would carry. */
const HANDOVER_SCOPES = ["workstyle", "+profile", "+knowledge"];

/** What this account could hand over, in the three categories: the preview of an export, read and not made. */
export async function readHandover(): Promise<WorkStyle> {
  const mine = await fetchMyCapsule();
  if (!mine.capsule) return workStyle([]);
  return workStyle((await previewCapsuleExport(mine.capsule.id, { scopes: HANDOVER_SCOPES })).entries);
}

/** 「你能交出去的：3 种做法、5 条标准与偏好、2 条背景。」 — only the categories that hold something; null when none does. */
export function handoverSentence(style: WorkStyle): string | null {
  const held = [
    style.methods > 0 ? `${style.methods} 种做法` : "",
    style.standards > 0 ? `${style.standards} 条标准与偏好` : "",
    style.background > 0 ? `${style.background} 条背景` : "",
  ].filter(Boolean);
  return held.length > 0 ? `你能交出去的：${held.join("、")}。` : null;
}
