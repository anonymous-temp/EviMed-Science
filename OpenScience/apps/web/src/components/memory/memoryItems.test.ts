import { describe, expect, it } from "vitest";
import type { WebStructuredMemory } from "@/lib/apiClient";
import type { OwnCapsuleEntry } from "@/lib/memoryClient";
import { factItems, matches, practiceItems } from "./memoryItems";

/** A structured memory with only the fields the lists read. */
const record = (overrides: Record<string, unknown> = {}): WebStructuredMemory => ({
  id: "r1", scope: "user", scopeId: "", kind: "preference", key: "k", value: "偏好表格。", summary: "偏好表格。", status: "active",
  createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z", invalidSince: null, supersededBy: null, revisions: [], evidence: [],
  ...overrides,
} as unknown as WebStructuredMemory);
const entry = (overrides: Record<string, unknown> = {}): OwnCapsuleEntry => ({
  id: "e1", revision: 1, createdAt: "2026-09-03T00:00:00Z", updatedAt: "2026-09-03T00:00:00Z", deletedAt: null, projectId: null,
  payload: { capsuleId: "c1", factKind: "writing_style", layer: "profile", content: "引用写到页码。", status: "approved", origin: "explicit", provenance: [] },
  ...overrides,
} as OwnCapsuleEntry);

describe("the facts a list shows", () => {
  it("lists memories and notes in force, newest first, and never a run summary or a forgotten fact", () => {
    const items = factItems(
      [record({ id: "old", updatedAt: "2026-08-01T00:00:00Z" }), record({ id: "new", updatedAt: "2026-09-10T00:00:00Z" }), record({ id: "run", kind: "run_summary" }), record({ id: "gone", status: "archived" })],
      [entry(), entry({ id: "retired", payload: { ...entry().payload, status: "retired" } })],
    );
    expect(items.map((item) => item.key)).toEqual(["record:new", "entry:e1", "record:old"]);
  });

  it("files each by kind and scope, whichever store it came from: habits are about the person, a project's facts about the project", () => {
    const items = factItems(
      [record({ id: "a", kind: "behavior" }), record({ id: "b", kind: "project_fact", scope: "project", scopeId: "p1" }), record({ id: "c", kind: "profile" })],
      [entry({ id: "d", projectId: "p2", payload: { ...entry().payload, factKind: "project_fact" } }), entry({ id: "f", payload: { ...entry().payload, factKind: "method_preference" } })],
    );
    const by = Object.fromEntries(items.map((item) => [item.key, [item.group, item.kind === "record" || item.kind === "entry" ? item.section : "", item.projectId]]));
    expect(by).toEqual({
      "record:a": ["self", "habit", null], "record:b": ["project", "other", "p1"], "record:c": ["self", "background", null],
      "entry:d": ["project", "other", "p2"], "entry:f": ["self", "habit", null],
    });
  });

  it("filters the notes by a query and leaves the memories to the server's search", () => {
    const items = factItems([record({ id: "m", summary: "没有这个词" })], [entry(), entry({ id: "x", payload: { ...entry().payload, content: "别的习惯" } })], { query: "页码" });
    expect(items.map((item) => item.key)).toEqual(["entry:e1", "record:m"]);
    expect(matches("Meta 分析", "meta")).toBe(true);
  });
});

const method = (overrides: Record<string, unknown> = {}) => ({
  id: "m1", status: "approved", title: "引用标记对齐", summary: "每个标记对应一条。", name: "citation-alignment", description: "", bodyUpdatedAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z",
  ...overrides,
} as never);

describe("the practices a list shows", () => {
  it("lists only methods in force, newest first", () => {
    const items = practiceItems([
      method(), method({ id: "m2", bodyUpdatedAt: "2026-09-25T00:00:00Z" }), method({ id: "waiting", status: "candidate" }), method({ id: "stopped", status: "retired" }),
    ]);
    expect(items.map((item) => item.key)).toEqual(["method:m2", "method:m1"]);
  });

  it("searches the title and the sentence", () => {
    const all = [method()];
    expect(practiceItems(all, { query: "标记" })).toHaveLength(1);
    expect(practiceItems(all, { query: "没有" })).toEqual([]);
  });
});
