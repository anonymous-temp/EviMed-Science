/**
 * The notices a run record carries, and the one vocabulary for them.
 *
 * Hidden knowledge: a run's notices used to be sentences — the gate's repair
 * instructions in English, the platform's own remarks in Chinese — flattened
 * into one string array and shown as they were. A reader got
 * 「claims[52].claim numeric fact 6 is not present…」 in their inbox. Each
 * notice now keeps the identity of what raised it (a gate check, a verdict, a
 * platform event) and is titled on read by the domain's Chinese table
 * (`describeGateIssue`, C2). The sentence stays as `text`, for readers that
 * predate the structure and never as what a reader is shown.
 *
 * Its own module because two very different callers need it: the run ledger,
 * which writes and folds notices, and the inbox, which composes a body from
 * their counts and titles.
 *
 * @module runNotices
 */

import { describeGateIssue, gateIssueSeverity } from "@evimed/domain";

/** How many notices one run keeps, and how long one sentence may be. */
export const maxQualityNotices = 40;
export const maxQualityNoticeLength = 300;

/**
 * A run notice as the ledger stores it: the finding's identity and its
 * parameters, and the legacy sentence for readers that predate the structure.
 * Title and detail are not stored; they are the domain table's, applied on
 * read (`describedQualityNotices`), so a better title reaches every run ever
 * recorded rather than only the next one.
 *
 * @typedef {{ code: string, check?: string, severity: 'safety'|'must-fix'|'advice', text: string,
 *   claimId?: string, file?: string, line?: number, detail?: string }} StoredNotice
 */

/**
 * One notice the platform raises about a run. `detail` is for the platform's
 * own Chinese sentence — a count, a deliverable name — never a validator's.
 * @param {string} code @param {string} text
 * @param {{ severity?: 'safety'|'must-fix'|'advice', check?: string, claimId?: string, file?: string, line?: number, detail?: string }} [extra]
 * @returns {StoredNotice}
 */
export function runNotice(code, text, extra = {}) {
  return { code, severity: extra.severity ?? "advice", text: String(text), ...extra };
}

/**
 * The sentences this ledger wrote before notices had codes, by the fixed
 * opening each one was written with. A closed list of the platform's own
 * former templates, frozen here — not a pattern over anybody's prose — so an
 * old run reads with the same titles a new one gets. Anything not on it is
 * advice titled 「另有技术提示」, with the sentence kept only as `text`.
 * @type {readonly [string, string, boolean][]} [opening, code, whether the sentence is Chinese and so may be shown]
 */
const legacyNoticeOpenings = Object.freeze([
  ["这次运行已有约", "run_stall_observed", true],
  ["这次运行没有通过交付前的质量门", "run_unverified_delivery", true],
  ["本次交付没有按原始题面核对", "run_brief_lost", true],
  ["运行自述文件 .evimed-run/state.json 无法解析", "run_projection_unreadable", true],
  ["内核没有把这次运行的工作状态对应到本次请求", "run_unattributed", true],
  ["计划中的交付物", "run_deliverable_dropped", true],
  ["本次运行计划", "run_planned_none_accepted", true],
  ["记忆抽取未产出记录", "memory_extraction_empty", true],
  ["记忆已记录但暂缓生效", "memory_pending", true],
  ["本次对话改写了", "memory_conflicts", true],
  ["交付物在写下回执之后被改动了", "run_files_changed_after_receipt", true],
  ["本轮没有加载「", "specialist_required_skill_missing", true],
  ["Adopted from the runtime's own browser application", "run_adopted_unchecked", false],
  ["The native input could not be assigned a deliverable contract", "run_adopted_unchecked", false],
  ["Native replay could not be attributed", "run_legacy_unattributed", false],
  ["The report was replaced with the write tool", "run_report_rewritten", false],
  ["Repair reduced the report from", "run_report_shrunk", false],
  ["delivery-receipt.json names ", "run_receipt_mismatch", false],
  ["The repair request", "run_repair_not_dispatched", false],
]);

/**
 * The run side's own "degraded" lines, by the template each is written with
 * (the socket's `evimedDiagnostics.degrade`). A closed table of the platform's
 * own openings — plus, for the one template whose opening is a variable path,
 * its fixed phrase — never a reading of anybody's prose. A line not on it is
 * `run_side_degraded`. The line itself stays as `text`, and becomes the detail
 * only when the template is written in Chinese.
 * @type {readonly [(line: string) => boolean, string][]}
 */
const runSideDegradedTemplates = Object.freeze([
  [(line) => line.startsWith("root research-tool narrowing"), "run_root_tools_unnarrowed"],
  [(line) => line.startsWith("root claim-tool narrowing"), "run_root_claim_tools_unnarrowed"],
  [(line) => line.startsWith("method section"), "run_method_sections_unregistered"],
  [(line) => line.startsWith("child guidance not installed"), "run_child_guidance_missing"],
  [(line) => line.startsWith("request size ") && line.includes("the forced compaction failed"), "run_compaction_failed"],
  [(line) => line.startsWith("request size ") && line.includes("nothing could be compacted"), "run_compaction_nothing"],
  [(line) => line.startsWith("request size ") && line.includes("compacted to"), "run_compaction_forced"],
  [(line) => line.startsWith("turn ended with children still running"), "run_children_outlived_turn"],
  [(line) => line.startsWith("children reminder steer failed"), "run_children_reminder_failed"],
  [(line) => line.includes("被两个子代理先后写入"), "run_concurrent_write"],
  [(line) => line.startsWith("capsule recall disabled"), "run_capsule_recall_off"],
  [(line) => line.startsWith("web providers not registered"), "run_web_providers_missing"],
  [(line) => line.startsWith("answer persona"), "run_answer_persona_missing"],
  [(line) => line.startsWith("capability catalogue") || line.startsWith("capability manifest"), "run_capability_catalogue_incomplete"],
  [(line) => line.startsWith("evidence ingest"), "run_evidence_ingest_failed"],
  [(line) => line.startsWith("runtime_turn_end_unknown"), "run_turn_end_unknown"],
]);

/** @param {string} line @returns {StoredNotice} */
export function runSideDegradedNotice(line) {
  const text = String(line).slice(0, maxQualityNoticeLength);
  const known = runSideDegradedTemplates.find(([matches]) => matches(text));
  const chinese = /[\u3400-\u9fff]/.test(text);
  return runNotice(known ? known[1] : "run_side_degraded", text, chinese ? { detail: text } : {});
}

/** @param {string} text @returns {StoredNotice} */
function legacyNotice(text) {
  if (text.startsWith("SAFETY — ")) return { code: "legacy_notice", severity: "safety", text };
  if (text.startsWith("MUST FIX — ")) return { code: "legacy_notice", severity: "must-fix", text };
  // Two templates that open with the same words and differ later; both are
  // the platform's own, so the distinguishing phrase is part of the template.
  if (text.startsWith("交付物「") && text.includes("从未提交校验")) return { code: "run_deliverable_never_submitted", severity: "advice", text, detail: text };
  if (text.startsWith("交付物「") && text.includes("每次都被契约校验拒绝")) return { code: "run_deliverable_rejected_every_time", severity: "advice", text, detail: text };
  if (text.startsWith("交付物「") && text.includes("开启了修订")) return { code: "run_revision_not_accepted", severity: "advice", text, detail: text };
  const known = legacyNoticeOpenings.find(([opening]) => text.startsWith(opening));
  if (known) return { code: known[1], severity: "advice", text, ...(known[2] ? { detail: text } : {}) };
  return { code: "legacy_notice", severity: "advice", text };
}

export const noticeCodePattern = /^[a-z][a-z0-9_.-]{0,63}$/;

/**
 * Notices as the ledger stores them, from whatever a caller holds: a stored
 * notice, a legacy string, or a `GateIssue`. Non-throwing on a bad shape,
 * like every observational field — a notice that will not parse is dropped,
 * never a reason the ledger cannot be read.
 * @param {unknown} value @returns {StoredNotice[]}
 */
export function normalizeQualityNotices(value) {
  if (!Array.isArray(value)) return [];
  /** @type {StoredNotice[]} */
  const notices = [];
  for (const item of value) {
    if (notices.length >= maxQualityNotices) break;
    if (typeof item === "string") {
      if (item.trim()) notices.push(legacyNotice(item.slice(0, maxQualityNoticeLength)));
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const raw = /** @type {Record<string, any>} */ (item);
    const text = String(raw.text ?? raw.message ?? "").trim().slice(0, maxQualityNoticeLength);
    const code = String(raw.code ?? "").trim();
    if (!text || !noticeCodePattern.test(code)) continue;
    notices.push({
      code,
      ...(typeof raw.check === "string" && raw.check && raw.check.length <= 64 ? { check: raw.check } : {}),
      severity: gateIssueSeverity(raw),
      text,
      ...(typeof raw.claimId === "string" && raw.claimId && raw.claimId.length <= 40 ? { claimId: raw.claimId } : {}),
      ...(typeof (raw.file ?? raw.path) === "string" && (raw.file ?? raw.path) ? { file: String(raw.file ?? raw.path).slice(0, 300) } : {}),
      ...(Number.isSafeInteger(raw.line) && raw.line > 0 ? { line: raw.line } : {}),
      ...(typeof raw.detail === "string" && raw.detail.trim() ? { detail: raw.detail.trim().slice(0, maxQualityNoticeLength) } : {}),
    });
  }
  return notices;
}

/** Describing a notice is a table lookup, but a ledger read describes every
 *  notice of every run; one bounded memo keeps a hot poll from redoing it. */
const describedNoticeMemo = new Map();

/**
 * Notices as a reader receives them (C2): the stored identity plus the
 * domain's Chinese title and detail, with the legacy sentence as `text`.
 * @param {unknown} value
 * @returns {(StoredNotice & { title: string })[]}
 */
export function describedQualityNotices(value) {
  return normalizeQualityNotices(value).map((stored) => {
    const key = JSON.stringify(stored);
    let described = describedNoticeMemo.get(key);
    if (!described) {
      const { code, check, severity, title, detail } = describeGateIssue(stored);
      described = Object.freeze({
        code,
        ...(check ? { check } : {}),
        severity,
        title,
        ...(detail ? { detail } : {}),
        ...(stored.claimId ? { claimId: stored.claimId } : {}),
        ...(stored.file ? { file: stored.file } : {}),
        ...(stored.line ? { line: stored.line } : {}),
        text: stored.text,
      });
      if (describedNoticeMemo.size >= 4_000) describedNoticeMemo.clear();
      describedNoticeMemo.set(key, described);
    }
    return described;
  });
}

/** @param {unknown} notice @returns {string} */
export function noticeText(notice) {
  return typeof notice === "string" ? notice : String(/** @type {any} */ (notice)?.text ?? "");
}
