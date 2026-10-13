import type { WebMemoryProfile, WebStructuredMemory } from "@/lib/apiClient";

/**
 * What `GET /api/memory/profile` answers, for the two kinds of account, taken from the control plane's own hand-off
 * (`handoff/ovmem.md`, 「the memory page's native routes」): the same shape for both, a memory kept as a file adding `engine`,
 * `nativeType`, `uri`, `contentHash` and — for a line of the profile document — `document`. One file used by every test of the
 * memory page, the drawer and the map, so the two shapes cannot drift apart in separate fixtures.
 *
 * The `uri` and `key` below are what the server really sends; a test that renders them has found a back-office label.
 */

const hex = (seed: string) => [...seed].reduce((text, char) => (text + char.charCodeAt(0).toString(16)).slice(-24), "").padStart(24, "a");

/** A memory of an account on the older engine. */
export function legacyRecord(patch: Partial<WebStructuredMemory> = {}): WebStructuredMemory {
  return {
    id: "rec_1", scope: "user", scopeId: "", kind: "preference", key: "preference.style",
    value: "偏好结论先行的回答。", summary: "偏好结论先行的回答。", origin: "explicit", status: "active",
    confidence: 1, importance: 0.8, sensitive: false, evidenceCount: 1, version: 2,
    createdAt: "2026-09-12T02:00:00Z", updatedAt: "2026-09-12T02:00:00Z", lastConfirmedAt: null, expiresAt: null,
    evidence: [{ sourceType: "conversation_message", sourceRef: "sessions/ses_9/messages/u1", quote: "回答先给结论", observedAt: "2026-09-12T02:00:00Z", weight: 1, fingerprint: "f1" }],
    revisions: [],
    ...patch,
  };
}

/** A memory the engine keeps as a file: a topic (`summary`) with its statements (`value`) under it. */
export function nativeFile(topic: string, value: string, patch: Partial<WebStructuredMemory> & { nativeType?: string; folder?: string } = {}): WebStructuredMemory {
  const { nativeType = "preferences", folder = "preferences/self", ...rest } = patch;
  const kind = ({ preferences: "preference", corrections: "correction", decisions: "decision", follow_ups: "follow_up", project_facts: "project_fact", project_context: "project_fact", entities: "project_fact" } as const)[nativeType as "preferences"] ?? "project_fact";
  return {
    id: `nm_${hex(topic)}`, scope: "user", scopeId: "", kind, key: `${folder}/${topic}.md`, value, summary: topic,
    origin: "explicit", status: "active", confidence: 1, importance: 0.5, sensitive: false, evidenceCount: 0, version: 4711,
    createdAt: "2026-10-12T02:00:00Z", updatedAt: "2026-10-12T02:00:00Z", lastConfirmedAt: "2026-10-12T02:00:00Z", expiresAt: null,
    evidence: [], revisions: [],
    engine: "native", nativeType, uri: `viking://user/u-0123456789abcdef01234567/memories/${folder}/${topic}.md`, contentHash: "9f2c".repeat(16),
    ...rest,
  } as WebStructuredMemory;
}

/** One line of the profile document, an item of its own on the page. */
export function nativeProfileLine(line: string, patch: Partial<WebStructuredMemory> = {}): WebStructuredMemory {
  const documentId = `nm_${hex("profile")}`;
  return {
    ...nativeFile("profile", line, { nativeType: "profile", folder: "." }),
    id: `${documentId}_${hex(line).slice(-12)}`, key: `profile.md#${hex(line).slice(-12)}`, summary: "", value: line, kind: "profile",
    document: { id: documentId }, ...patch,
  } as WebStructuredMemory;
}

const empty = { profile: [], preference: [], behavior: [], project_fact: [], analysis: [], decision: [], correction: [], follow_up: [], run_summary: [] };

/** An account on the older engine with a few memories of the usual kinds. */
export const legacyProfile: WebMemoryProfile = {
  records: [
    legacyRecord({ id: "rec_p", kind: "profile", key: "profile.who", value: "临床药师，关注老年人慢病管理。", summary: "临床药师，关注老年人慢病管理。" }),
    legacyRecord(),
    legacyRecord({ id: "rec_f", kind: "project_fact", scope: "project", scopeId: "prj_1", key: "project.fact.scope", value: "纳入范围覆盖疳证。", summary: "纳入范围覆盖疳证。" }),
  ],
  groups: empty, activeCount: 3, pendingCount: 0, episodeCount: 0, conversations: { ses_9: "阿司匹林一级预防" }, usage: {},
};

/** The same person on the second engine: a profile document of three lines, files for the other kinds. */
export const nativeProfile: WebMemoryProfile = {
  holder: { id: "u-0123456789abcdef01234567", name: "测试用户" },
  records: [
    nativeProfileLine("临床药师，关注老年人慢病管理。"),
    nativeProfileLine("所在科室是临床药学部。"),
    nativeProfileLine("常用 R 做统计分析。"),
    nativeFile("回答结构", "- 先给结论，再给依据。\n- 表格不超过五列。"),
    nativeFile("meta_analysis_method", "- Meta 分析一律用随机效应模型。", { nativeType: "preferences" }),
    nativeFile("订单服务重构", "# 订单服务重构\n领域：后端架构\n## 目标\n- 把订单拆成独立服务。\n## 约束\n- 周五前出方案。",
      { nativeType: "project_context", folder: "projects", scope: "project", scopeId: "prj_1", kind: "project_fact" }),
    nativeFile("发布窗口", "- 发布定在周三。", { nativeType: "decisions", folder: "decisions", scope: "project", scopeId: "prj_1" }),
  ],
  groups: empty, activeCount: 7, pendingCount: 0, episodeCount: 0, conversations: {}, usage: {}, engine: "native", pending: [],
};

export const nativeSettings = { learningPaused: false, recallPaused: false, pausedProjects: [], updatedAt: null, engine: "native" as const };
export const legacySettings = { learningPaused: false, recallPaused: false, pausedProjects: [], updatedAt: null, engine: "legacy" as const };
