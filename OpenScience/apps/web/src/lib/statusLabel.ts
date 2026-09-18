/**
 * A server code in the reader's words, or a Chinese sentence saying it has no
 * words yet — never the code itself.
 *
 * The shell had fourteen `LABEL[code] ?? code` sites (2026-09-18 review, B §3
 * cross-cutting), so the day the server added a value the page printed it:
 * `needs_attention`, `version-family`, `timed out`. The sibling platform's hard
 * rule 1 is the whole reason this exists — every status, enum and error code
 * on screen goes through a Chinese mapping, and an unregistered code shows as
 * unregistered rather than as itself. The code stays available to whoever
 * needs it (an operator's tooltip, a support ticket) through the caller, not
 * through the label.
 */
export function labelFor(
  table: Readonly<Record<string, string>>,
  code: string | null | undefined,
  unregistered = "未登记的状态",
): string {
  if (!code) return unregistered;
  return Object.prototype.hasOwnProperty.call(table, code) ? table[code] : unregistered;
}

/** The generic outcome words the operator ledgers write (`completed`, `failed`, …). */
export const LEDGER_STATUS_LABEL: Readonly<Record<string, string>> = Object.freeze({
  completed: "已完成",
  succeeded: "成功",
  failed: "失败",
  denied: "已拒绝",
  allowed: "已允许",
  noop: "无变化",
  queued: "排队中",
  running: "运行中",
  canceled: "已取消",
  cancelled: "已取消",
  timed_out: "已超时",
  blocked: "已阻止",
});
