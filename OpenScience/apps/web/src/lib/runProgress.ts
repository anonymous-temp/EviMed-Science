import { RUN_ACTIVITY_PHASE_LABELS_ZH } from "@evimed/domain";
import type {
  WebAgentRun,
  WebRunActivityPhase,
  WebRunDeliverable,
  WebRunDeliverableStatus,
  WebRunProgress,
  WebRunUsage,
} from "@/lib/apiClient";
import type { RunStreamEvent } from "@/lib/runEvents";
import { formatCny } from "@/lib/format";

/**
 * A run's progress, from whichever source is freshest.
 *
 * The ledger stores the last `RunProgress` on the record (contract C5) and the
 * run's event stream publishes each change as `run/progress`. The page used to
 * poll `planItems` every 20 s, only for three running runs, and only while
 * they ran — so a finished run's plan vanished and a delegated one read
 * 「待开始 ×3」 for 25 minutes (review B §4g). Everything here is a count of
 * something observed; nothing is an estimate or a percentage (appendix D §6.1:
 * an agent run has an odometer, never a fuel gauge).
 */

const PHASES: readonly WebRunActivityPhase[] = ["search", "screen", "fulltext", "claims", "write", "deliver"];
const DELIVERABLE_STATES: readonly WebRunDeliverableStatus[] = [
  "planned", "delegated", "submitted", "rejected", "accepted", "delivered", "failed",
];

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

function parseDeliverable(value: unknown): WebRunDeliverable | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const id = text(item.id);
  if (!id) return null;
  const status = DELIVERABLE_STATES.includes(item.status as WebRunDeliverableStatus)
    ? item.status as WebRunDeliverableStatus
    // `queued` is the plan index's word for planned-and-waiting; an unknown
    // word is read as planned rather than invented into a state.
    : "planned";
  const verdict = item.lastVerdict;
  return {
    id,
    title: text(item.title) ?? id,
    capability: text(item.capability),
    status,
    attempts: count(item.attempts),
    lastVerdict: verdict === "pass" || verdict === "issues" || verdict === "unverified" ? verdict : undefined,
    mustFixCount: typeof item.mustFixCount === "number" ? count(item.mustFixCount) : undefined,
    childSessionId: text(item.childSessionId),
  };
}

function parseUsage(value: unknown): WebRunUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  if (typeof usage.costCny !== "number" || !Number.isFinite(usage.costCny)) return undefined;
  return {
    requests: count(usage.requests),
    inputTokens: count(usage.inputTokens),
    cachedInputTokens: count(usage.cachedInputTokens),
    outputTokens: count(usage.outputTokens),
    costCny: Math.max(0, usage.costCny),
  };
}

/** A `RunProgress` from the wire or the record, or null when it is not one. */
export function parseRunProgress(value: unknown): WebRunProgress | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.deliverables) || !raw.phaseCounts || typeof raw.phaseCounts !== "object") return null;
  const phaseCounts = Object.fromEntries(
    PHASES.map((phase) => [phase, count((raw.phaseCounts as Record<string, unknown>)[phase])]),
  ) as Record<WebRunActivityPhase, number>;
  const sources = (raw.sources ?? {}) as Record<string, unknown>;
  const claims = (raw.claims ?? {}) as Record<string, unknown>;
  return {
    deliverables: raw.deliverables.map(parseDeliverable).filter((item): item is WebRunDeliverable => item !== null),
    phaseCounts,
    currentPhase: PHASES.includes(raw.currentPhase as WebRunActivityPhase) ? raw.currentPhase as WebRunActivityPhase : null,
    sources: { searched: count(sources.searched), included: count(sources.included), fullText: count(sources.fullText) },
    claims: { total: count(claims.total), verified: Math.min(count(claims.verified), count(claims.total) || count(claims.verified)) },
    children: (Array.isArray(raw.children) ? raw.children : [])
      .filter((child): child is Record<string, unknown> => Boolean(child) && typeof child === "object" && typeof (child as Record<string, unknown>).childSessionId === "string")
      .map((child) => ({
        childSessionId: String(child.childSessionId),
        deliverableId: text(child.deliverableId),
        state: (["running", "idle", "done", "failed"] as const).find((state) => state === child.state) ?? "idle",
        lastActivityAt: text(child.lastActivityAt) ?? null,
      })),
    usage: parseUsage(raw.usage),
    startedAt: text(raw.startedAt) ?? null,
    updatedAt: text(raw.updatedAt) ?? "",
  };
}

/**
 * What the event stream has said since the page opened, folded.
 *
 * `run/progress` is the aggregate and wins. Until the first one arrives, the
 * per-item `deliverable/update` frames the stream has published since the
 * kernel migration still move each deliverable's state, so a running run is
 * correct within a second either way. `run/state` carries the terminal state.
 */
export interface LiveRunFold {
  progress: WebRunProgress | null;
  deliverables: Map<string, Partial<WebRunDeliverable> & { id: string }>;
  state: string | null;
}

export function foldRunEvents(events: readonly RunStreamEvent[]): LiveRunFold {
  const fold: LiveRunFold = { progress: null, deliverables: new Map(), state: null };
  for (const event of events) {
    if (event.type === "run/progress") {
      const progress = parseRunProgress(event.progress ?? event);
      if (progress) fold.progress = progress;
    } else if (event.type === "deliverable/update") {
      const item = parseDeliverable(event);
      if (item) fold.deliverables.set(item.id, { ...fold.deliverables.get(item.id), ...item });
    } else if (event.type === "run/state" && typeof event.state === "string") {
      fold.state = event.state;
    }
  }
  return fold;
}

/** The run's progress: the live aggregate, else the one stored on the record. */
export function runProgressOf(run: WebAgentRun, live?: LiveRunFold | null): WebRunProgress | null {
  return live?.progress ?? parseRunProgress(run.progress) ?? null;
}

/**
 * The run's deliverables, kept after the run ends (contract C3), from the
 * freshest source: live progress, the stored progress, the record's own list,
 * and — for a record written before either existed — the old `planItems`.
 */
export function runDeliverables(run: WebAgentRun, live?: LiveRunFold | null): WebRunDeliverable[] {
  const progress = runProgressOf(run, live);
  const base: WebRunDeliverable[] = progress?.deliverables.length
    ? progress.deliverables
    : (run.deliverables ?? []).map(parseDeliverable).filter((item): item is WebRunDeliverable => item !== null);
  const fromPlan: WebRunDeliverable[] = base.length > 0 ? base : (run.planItems ?? []).map((item) => ({
    id: item.id,
    title: item.title,
    status: item.status === "queued" ? "planned" : item.status,
    attempts: item.attempts,
  }));
  if (!live || live.progress || live.deliverables.size === 0) return fromPlan;
  const merged = fromPlan.map((item) => ({ ...item, ...(live.deliverables.get(item.id) ?? {}) }));
  for (const [id, frame] of live.deliverables) {
    if (!merged.some((item) => item.id === id)) merged.push({ title: id, status: "planned", attempts: 0, ...frame } as WebRunDeliverable);
  }
  return merged;
}

/** What each deliverable state is called on screen. */
export const DELIVERABLE_STATUS_LABEL: Record<WebRunDeliverableStatus, string> = {
  planned: "待开始",
  delegated: "进行中",
  submitted: "核验中",
  rejected: "需修改",
  accepted: "已通过核验",
  delivered: "已交付",
  failed: "未完成",
};

/**
 * The odometer line: 「检索 6 次 · 纳入 23 篇 · 全文 13 篇 · 结论 41/72 已核对」.
 * Only what has happened is named; a plain question makes no tool call and
 * gets no line at all (principle 12).
 */
export function progressCountsLine(progress: WebRunProgress | null): string {
  if (!progress) return "";
  const parts: string[] = [];
  if (progress.phaseCounts.search > 0) parts.push(`检索 ${progress.phaseCounts.search} 次`);
  if (progress.sources.included > 0) parts.push(`纳入 ${progress.sources.included} 篇`);
  if (progress.sources.fullText > 0) parts.push(`全文 ${progress.sources.fullText} 篇`);
  if (progress.claims.total > 0) parts.push(`结论 ${progress.claims.verified}/${progress.claims.total} 已核对`);
  return parts.join(" · ");
}

/** 「正在检索」, or null when no labelled call has happened yet. */
export function currentPhaseLabel(progress: WebRunProgress | null): string | null {
  const phase = progress?.currentPhase;
  if (!phase) return null;
  const labels = RUN_ACTIVITY_PHASE_LABELS_ZH as Record<string, string>;
  return labels[phase] ? `正在${labels[phase]}` : null;
}

/** 「子任务 2/3 运行中」, or null when the run delegated nothing. */
export function childrenLine(progress: WebRunProgress | null): string | null {
  const children = progress?.children ?? [];
  if (children.length === 0) return null;
  const running = children.filter((child) => child.state === "running").length;
  return running > 0 ? `子任务 ${running}/${children.length} 运行中` : `子任务 ${children.length} 个`;
}

/**
 * The single most useful sentence on a delivered row:
 * 「72 条结论，68 条引文已核对，4 条未核对」 (review B §4e). From the ledger's
 * `claimSummary`; nothing when the run made no claims.
 */
export function claimSummaryLine(summary: WebAgentRun["claimSummary"]): string | null {
  if (!summary || !(summary.total > 0)) return null;
  const unverified = Math.max(0, summary.unverified ?? summary.total - summary.verified);
  return unverified > 0
    ? `${summary.total} 条结论，${summary.verified} 条引文已核对，${unverified} 条未核对`
    : `${summary.total} 条结论，引文全部已核对`;
}

/** 「¥0.42」 — what this run cost, when the ledger attributed it. */
export function runCostText(usage: WebRunUsage | null | undefined): string {
  return usage ? formatCny(usage.costCny) : "";
}
