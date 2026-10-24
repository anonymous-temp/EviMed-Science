import type { ReceivedCapsule } from "@/lib/memoryClient";
import type { MapDay, MapEvent, MapNode, MemoryMap } from "@/lib/memoryMapClient";

/**
 * What `GET /api/memory/map?include=summary,facets,nodes,buckets,events` answers, for the accounts the overview is drawn for: the page's tests,
 * its composition test and the walk's own fixture read them, so the same two accounts — the owner's first day, and one that has lived a while —
 * are what every check sees. Dates are fixed: `today` is 2026-10-12 in Asia/Shanghai.
 */

export const TODAY = new Date("2026-10-12T04:00:00Z");

const base = (): MemoryMap => ({
  version: 1, engine: "native",
  scope: { projectId: null, range: { from: null, to: "2026-10-12", unit: "month" }, timeZone: "Asia/Shanghai", focus: null, depth: null },
  status: { topics: "empty" },
  summary: { memories: 0, documents: 0, methods: 0, projects: 0, needsLook: 0, since: null },
  facets: { projects: [], kinds: [], aboutYou: [], documentTypes: [], topics: [], dimensions: [] },
  nodes: [], edges: [], buckets: { unit: "day", series: [] }, lanes: [], events: [], truncated: { nodes: 0, edges: 0 }, missing: [],
});

export const memoryMark = (id: string, over: Partial<MapNode> = {}): MapNode => ({
  id: `memory:${id}`, type: "memory", subtype: "preference", group: "偏好", label: `偏好的一句话 ${id}`, weight: 0.5, state: "current", at: "2026-10-01T02:00:00.000Z",
  projectId: null, open: { kind: "record", id }, ...over,
});
export const methodMark = (id: string, at: string, label = `做法 ${id}`): MapNode => ({ id: `method:${id}`, type: "method", group: "做法", label, state: "current", at, open: { kind: "method", id } });
export const documentMark = (id: string, projectId: string | null, at: string, label = `资料 ${id}`): MapNode => ({
  id: `document:${id}`, type: "document", subtype: "literature", group: "文献与指南", label, state: "current", at, projectId, open: { kind: "page", href: `/app/files/${id}` },
});
const days = (rows: Array<[string, number]>): MapDay[] => rows.map(([t, document]) => ({ t, memory: 0, run: 0, method: 0, feedback: 0, document }));
export const createdEvent = (id: string, at: string, text = id): MapEvent => ({ id: `memory:${id}:created`, at, type: "memory", change: "created", ref: `memory:${id}`, lane: "account", kind: "preference", text });

/**
 * The owner's first day on the native engine: no memory file, some documents in three projects, no learned method, nothing received. The
 * overview must be a page with something on it — the documents, the projects, the strip of what was put in — and recipes for the rest.
 */
export function ownerFirstDay(over: Partial<MemoryMap> = {}): MemoryMap {
  const documents = [
    documentMark("src_a1", "prj_a", "2026-09-22T02:00:00.000Z", "阿司匹林一级预防指南"), documentMark("src_a2", "prj_a", "2026-09-30T02:00:00.000Z"),
    documentMark("src_b1", "prj_b", "2026-10-05T02:00:00.000Z"),
  ];
  return {
    ...base(),
    summary: { memories: 0, documents: 3, methods: 0, projects: 2, needsLook: 0, since: null },
    facets: {
      projects: [{ id: "prj_a", name: "阿司匹林一级预防", kind: "own", memories: 0, documents: 22 }, { id: "prj_b", name: "房颤抗凝", kind: "own", memories: 0, documents: 17 }, { id: "prj_c", name: "空项目", kind: "own", memories: 0, documents: 0 }],
      kinds: [], aboutYou: [], documentTypes: [{ id: "literature", label: "文献与指南", count: 31 }, { id: "document", label: "文档", count: 9 }, { id: "table", label: "数据表", count: 7 }], topics: [], dimensions: [],
    },
    nodes: [{ id: "project:prj_a", type: "project", label: "阿司匹林一级预防", state: "current", projectId: "prj_a" }, { id: "project:prj_b", type: "project", label: "房颤抗凝", state: "current", projectId: "prj_b" }, ...documents],
    buckets: { unit: "day", series: days([["2026-09-22", 1], ["2026-09-30", 1], ["2026-10-05", 1]]) },
    ...over,
  };
}

/** An account that has lived a while: memories about the person and in projects, methods, documents, a source that changed. */
export function livedIn(over: Partial<MemoryMap> = {}): MemoryMap {
  const you = [
    memoryMark("y1", { subtype: "profile", group: "背景", label: "临床药师，做心血管方向", at: "2026-09-25T02:00:00.000Z" }),
    memoryMark("y2", { label: "回答先给结论", at: "2026-09-28T02:00:00.000Z" }),
    memoryMark("y3", { subtype: "correction", group: "纠正", label: "报告不要英文摘要", at: "2026-10-03T02:00:00.000Z" }),
    memoryMark("y4", { subtype: "writing_style", group: "写作习惯", label: "引用写到页码", at: "2026-10-04T02:00:00.000Z", open: { kind: "entry", id: "e4" }, id: "memory:entry:e4" }),
  ];
  const inProject = [
    memoryMark("p1", { subtype: "project_fact", group: "项目事实", label: "纳入 75 岁以上非瓣膜性房颤患者", projectId: "prj_b", at: "2026-10-06T02:00:00.000Z" }),
    memoryMark("p2", { subtype: "decision", group: "决定", label: "主要结局取卒中和系统性栓塞", projectId: "prj_b", state: "check", reason: "source-changed", at: "2026-10-07T02:00:00.000Z" }),
    memoryMark("p3", { subtype: "project_fact", group: "项目事实", label: "检索截止到今年九月", projectId: "prj_a", at: "2026-10-08T02:00:00.000Z" }),
  ];
  const methods = [methodMark("m1", "2026-09-24T02:00:00.000Z", "证据矩阵先行"), methodMark("m2", "2026-10-02T02:00:00.000Z", "先写方法学限制")];
  const nodes: MapNode[] = [
    { id: "you:account", type: "you", label: "你", state: "current" },
    { id: "project:prj_a", type: "project", label: "阿司匹林一级预防", state: "current", projectId: "prj_a" }, { id: "project:prj_b", type: "project", label: "房颤抗凝", state: "current", projectId: "prj_b" },
    ...you, ...inProject, ...methods, documentMark("src_a1", "prj_a", "2026-09-22T02:00:00.000Z"), documentMark("src_b1", "prj_b", "2026-10-05T02:00:00.000Z"),
  ];
  return {
    ...base(),
    summary: { memories: 7, documents: 2, methods: 2, projects: 2, needsLook: 1, since: "2026-09-25" },
    facets: {
      projects: [{ id: "prj_a", name: "阿司匹林一级预防", kind: "own", memories: 1, documents: 22 }, { id: "prj_b", name: "房颤抗凝", kind: "own", memories: 2, documents: 17 }],
      kinds: [], aboutYou: [{ id: "profile", label: "背景", count: 1 }, { id: "preference", label: "偏好", count: 1 }, { id: "correction", label: "纠正", count: 1 }, { id: "writing_style", label: "写作习惯", count: 1 }],
      documentTypes: [{ id: "literature", label: "文献与指南", count: 31 }, { id: "document", label: "文档", count: 8 }], topics: [], dimensions: [],
    },
    nodes,
    buckets: { unit: "day", series: days([["2026-09-22", 1], ["2026-10-05", 1]]) },
    events: [...you, ...inProject].map((node) => createdEvent(node.id.replace("memory:", ""), node.at ?? "2026-10-01T00:00:00Z", node.label)),
    ...over,
  };
}

export const receivedPack = (id: string, over: Partial<ReceivedCapsule> = {}): ReceivedCapsule => ({
  id, revision: 1, title: `李主任的工作方式 ${id}`, description: "", issuerTrust: "verified", importedAt: "2026-10-09T02:00:00.000Z", enabled: false, counts: { method_preference: 3, preference: 2 },
  methods: [], scanned: true, waiting: 0, scan: null, card: { author: "李主任", summary: "先问清楚再动手" }, ...over,
});

/** What the export preview of an account lists: the capsule's own entries by kind. */
export const handoverEntries = (counts: { methods: number; standards: number; background: number }) => [
  ...Array.from({ length: counts.methods }, () => ({ factKind: "method_preference", layer: "methods", origin: "explicit", content: "做法" })),
  ...Array.from({ length: counts.standards }, () => ({ factKind: "preference", layer: "profile", origin: "explicit", content: "偏好" })),
  ...Array.from({ length: counts.background }, () => ({ factKind: "expertise", layer: "knowledge", origin: "explicit", content: "背景" })),
];
