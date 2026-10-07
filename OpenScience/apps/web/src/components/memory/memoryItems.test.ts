import { describe, expect, it } from "vitest";
import type { WebStructuredMemory } from "@/lib/apiClient";
import type { OwnCapsuleEntry } from "@/lib/memoryClient";
import {
  OTHER_PROJECT, factItems, factRowTitle, factsOfProject, heldFrom, matches, practiceItems, projectChoices,
} from "./memoryItems";

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

  it("shows a fact another replaced under what replaced it, and one whose replacement is not here as what it was", () => {
    const items = factItems([
      record({ id: "new" }),
      record({ id: "old", status: "superseded", supersededBy: "new", createdAt: "2026-03-02T00:00:00Z", invalidSince: "2026-09-01T00:00:00Z" }),
      record({ id: "orphan", status: "superseded", supersededBy: "missing", summary: "回答用英文。", createdAt: "2026-02-01T00:00:00Z", invalidSince: "2026-04-01T00:00:00Z" }),
    ], []);
    expect(items.map((item) => item.key).sort()).toEqual(["record:new", "record:orphan"]);
    const fresh = items.find((item) => item.key === "record:new");
    expect(fresh?.kind === "record" && fresh.formerly.map((item) => item.id)).toEqual(["old"]);
    const orphan = items.find((item) => item.key === "record:orphan")!;
    expect(factRowTitle(orphan)).toBe("曾经如此：回答用英文。（2月1日～4月1日）");
    expect(factRowTitle(fresh!)).toBe("偏好表格。");
  });

  it("filters the notes by a query and leaves the memories to the server's search", () => {
    const items = factItems([record({ id: "m", summary: "没有这个词" })], [entry(), entry({ id: "x", payload: { ...entry().payload, content: "别的习惯" } })], { query: "页码" });
    expect(items.map((item) => item.key)).toEqual(["entry:e1", "record:m"]);
    expect(matches("Meta 分析", "meta")).toBe(true);
  });

  it("says a range only when it knows an end", () => {
    expect(heldFrom({ createdAt: "2026-03-02T00:00:00Z", invalidSince: "2026-09-01T00:00:00Z" })).toBe("（3月2日～9月1日）");
    expect(heldFrom({ createdAt: null, invalidSince: null })).toBe("");
  });
});

const method = (overrides: Record<string, unknown> = {}) => ({
  id: "m1", status: "approved", title: "引用标记对齐", summary: "每个标记对应一条。", name: "citation-alignment", description: "", bodyUpdatedAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z",
  ...overrides,
} as never);
const handbook = (overrides: Record<string, unknown> = {}) => ({
  id: "h1", status: "active", capabilityId: "meta-analysis", title: "每一句结论落回来源", summary: "写出处。", appliedAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-23T00:00:00Z",
  ...overrides,
} as never);

describe("the practices a list shows", () => {
  it("lists only methods in force and handbooks in use, each group newest first", () => {
    const { methods, handbooks } = practiceItems(
      [method(), method({ id: "m2", bodyUpdatedAt: "2026-09-25T00:00:00Z" }), method({ id: "waiting", status: "candidate" }), method({ id: "stopped", status: "retired" })],
      [handbook(), handbook({ id: "h2", appliedAt: "2026-09-24T00:00:00Z" }), handbook({ id: "h3", status: "retired" })],
    );
    expect(methods.map((item) => item.key)).toEqual(["method:m2", "method:m1"]);
    expect(handbooks.map((item) => item.key)).toEqual(["handbook:h2", "handbook:h1"]);
  });

  it("names a handbook's tool by its title, and never by its identifier", () => {
    const { handbooks } = practiceItems([], [handbook(), handbook({ id: "h2", capabilityId: "no-such-capability" }), handbook({ id: "h3", capabilityId: null })]);
    expect(handbooks.map((item) => item.tool)).not.toContain("meta-analysis");
    expect(handbooks.find((item) => item.key === "handbook:h2")?.tool).toBe("科研工具");
  });

  it("searches the title, the sentence and the tool", () => {
    const all = [method()];
    const books = [handbook()];
    expect(practiceItems(all, books, { query: "标记" }).methods).toHaveLength(1);
    expect(practiceItems(all, books, { query: "标记" }).handbooks).toHaveLength(0);
    expect(practiceItems(all, books, { query: "落回来源" }).handbooks).toHaveLength(1);
    expect(practiceItems(all, books, { query: "没有" })).toEqual({ methods: [], handbooks: [] });
  });
});

describe("the projects the 项目 tab can show", () => {
  const projects = [{ id: "p1", name: "疳证 Meta" }, { id: "p2", name: "信尔美" }, { id: "v1", name: "糖尿病研究" }, { id: "g1", name: "波立维" }];
  const sets = { vcr: new Set(["v1"]), geo: new Set(["g1"]) };

  it("lists the researcher's own first, then the studies, then the 循证 GEO projects, each with its kind", () => {
    expect(projectChoices(projects, sets, []).map((choice) => [choice.name, choice.kind])).toEqual([
      ["疳证 Meta", "own"], ["信尔美", "own"], ["糖尿病研究", "vcr"], ["波立维", "geo"],
    ]);
  });

  it("tells two projects of one name apart, and keeps the id the choice is made by", () => {
    const year = new Date().getFullYear();
    const twins = [
      { id: "g1", name: "波立维", createdAt: new Date(year, 8, 29, 9, 0).toISOString() },
      { id: "g2", name: "波立维", createdAt: new Date(year, 9, 1, 9, 0).toISOString() },
    ];
    const choices = projectChoices(twins, { vcr: new Set(), geo: new Set(["g1", "g2"]) }, []);
    expect(choices.map((choice) => [choice.id, choice.name])).toEqual([["g1", "波立维 · 9月29日"], ["g2", "波立维 · 10月1日"]]);
  });

  it("lists a project with no facts too, and a 「其他」 only when some fact names no project the account still has", () => {
    expect(projectChoices(projects, sets, factItems([record({ id: "x", kind: "project_fact", scope: "project", scopeId: "p1" })], [])).map((choice) => choice.id)).not.toContain(OTHER_PROJECT);
    const orphan = factItems([record({ id: "x", kind: "project_fact", scope: "project", scopeId: "deleted" })], []);
    expect(projectChoices(projects, sets, orphan).at(-1)).toEqual({ id: OTHER_PROJECT, name: "其他", kind: "own" });
  });

  it("gives a project its own facts, and 「其他」 the ones no project holds", () => {
    const facts = factItems([
      record({ id: "a", kind: "project_fact", scope: "project", scopeId: "p1" }), record({ id: "b", kind: "project_fact", scope: "project", scopeId: "deleted" }),
      record({ id: "c", kind: "decision", scope: "user" }), record({ id: "d", kind: "preference" }),
    ], []);
    const known = new Set(projects.map((project) => project.id));
    expect(factsOfProject(facts, "p1", known).map((item) => item.key)).toEqual(["record:a"]);
    expect(factsOfProject(facts, OTHER_PROJECT, known).map((item) => item.key).sort()).toEqual(["record:b", "record:c"]);
    expect(factsOfProject(facts, "p2", known)).toEqual([]);
  });
});
