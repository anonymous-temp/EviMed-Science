import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectOverview as Overview } from "@/lib/memoryClient";
import { ProjectOverview, monthHeading, workPath } from "./ProjectOverview";
import { validitySpan } from "./ValidityBar";

const base: Overview = { projectId: "prj_1", paused: false, card: [], capabilities: [], works: [], timeZone: "UTC" };
function show(patch: Partial<Overview>, props: { canOpen?: (id: string) => boolean; onOpen?: (id: string) => void; onSpeak?: () => void; hasMemories?: boolean } = {}) {
  return render(
    <MemoryRouter>
      <ProjectOverview overview={{ ...base, ...patch }} canOpen={props.canOpen ?? (() => true)} onOpen={props.onOpen ?? (() => undefined)}
        onSpeak={props.onSpeak} hasMemories={props.hasMemories} />
    </MemoryRouter>,
  );
}

describe("the top of a project", () => {
  afterEach(cleanup);

  it("names a month as a list does: this year's by its number, another year's with the year", () => {
    const now = new Date("2026-10-12T00:00:00Z");
    expect(monthHeading("2026-10", now)).toBe("10月");
    expect(monthHeading("2025-12", now)).toBe("2025年12月");
    expect(monthHeading("nonsense", now)).toBe("nonsense");
  });

  it("addresses a file by its run and its path, each segment encoded", () => {
    expect(workPath("run_1", "deliverables/临床 证据/report.md")).toBe("/app/runs/run_1/files/deliverables/%E4%B8%B4%E5%BA%8A%20%E8%AF%81%E6%8D%AE/report.md");
  });

  it("draws nothing for a project with nothing to say, and each block only when it has something", () => {
    expect(show({}).container).toBeEmptyDOMElement();
    cleanup();
    show({ capabilities: [{ id: "statistical-analysis", title: "统计分析", count: 3 }] });
    expect(screen.getByRole("table", { name: "这个项目做过" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "项目卡" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "作品" })).toBeNull();
  });

  it("draws every block as one shape of section, however different their bodies, so the page's walk counts one kind", () => {
    // What the walk reads (scripts/ops/ui-walk.mjs): a section's tag and its first two distinct kinds of child.
    const shapes = (root: HTMLElement) => [...new Set([...root.querySelectorAll("section")].map((section) => `section>${[...new Set([...section.children].map((child) => child.tagName.toLowerCase()))].slice(0, 2).join("+")}`))];
    const works = [{ month: "2026-10", items: [{ runId: "run_1", title: "随访方案", path: "outputs/plan.docx", name: "plan.docx", at: "2026-10-03T08:00:00Z" }] }];
    const capabilities = [{ id: "a", title: "文献检索", count: 5 }];
    // The quiet line, the ranking and the works: a line, a table and months of rows.
    expect(shapes(show({ capabilities, works }, { hasMemories: true, onSpeak: () => undefined }).container)).toEqual(["section>h2+div"]);
    cleanup();
    // The card's rows, the ranking and the works: a list, a table and months of rows.
    expect(shapes(show({ card: [{ slot: "goal", label: "目标", recordId: "rec_1", text: "比较两种抗凝药", updatedAt: null }], capabilities, works }).container)).toEqual(["section>h2+div"]);
  });

  it("says in one line, with the one thing to do about it, that a project with memories has no card yet, and never draws a grid of empty slots", async () => {
    const onSpeak = vi.fn();
    show({}, { hasMemories: true, onSpeak });
    expect(screen.getByRole("heading", { name: "项目卡" })).toBeInTheDocument();
    expect(screen.getByText("还没有记下这个项目的目标、资料和进展。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "在对话里说说这个项目" }));
    expect(onSpeak).toHaveBeenCalledTimes(1);
    // No slot is named, and no clinical element is listed as a gap.
    expect(screen.queryByRole("list")).toBeNull();
    for (const label of ["领域", "目标", "范围或对象", "材料与数据", "阶段", "约束", "人群", "干预或暴露", "对照", "结局", "设计"]) {
      expect(screen.queryByText(label)).toBeNull();
    }
    cleanup();
    // A sentence nobody can act on is not written: a project with no conversation to open says nothing here.
    show({}, { hasMemories: true });
    expect(screen.queryByText("还没有记下这个项目的目标、资料和进展。")).toBeNull();
    cleanup();
    // Not when the project's memory is off (that line speaks), and not when the card has something.
    show({ paused: true }, { hasMemories: true, onSpeak });
    expect(screen.queryByText("还没有记下这个项目的目标、资料和进展。")).toBeNull();
    cleanup();
    show({ card: [{ slot: "goal", label: "目标", recordId: "rec_g", text: "把单体拆成三个服务", updatedAt: null }] }, { hasMemories: true, onSpeak });
    expect(screen.queryByText("还没有记下这个项目的目标、资料和进展。")).toBeNull();
  });

  it("draws the rows the project has, in the words of the card: general slots, a study's elements only when stated, and an extra by its own name or its sentence", () => {
    show({ card: [
      { slot: "field", label: "领域", recordId: "rec_f", text: "后端架构、支付系统", updatedAt: null },
      { slot: "goal", label: "目标", recordId: "rec_g", text: "把单体拆成三个服务", updatedAt: null },
      { slot: "constraints", label: "约束", recordId: "rec_c", text: "十一月底前切完", updatedAt: null },
      { slot: "ext.interface", label: "接口", recordId: "rec_i", text: "对外接口保持不变", updatedAt: null },
      { slot: "ext.release_train", label: null, recordId: "rec_r", text: "每两周一个发布窗口。", updatedAt: null },
    ] });
    const rows = within(screen.getByRole("list", { name: "项目卡" })).getAllByRole("listitem").map((row) => row.textContent);
    expect(rows).toEqual([
      "领域后端架构、支付系统", "目标把单体拆成三个服务", "约束十一月底前切完", "接口对外接口保持不变", "每两周一个发布窗口。",
    ].map((text) => expect.stringContaining(text)));
    // An extra the card has no word for is its sentence alone, not an English key.
    expect(document.body.textContent).not.toMatch(/release_train|ext\./);
    // Nothing that was not stated is listed as missing.
    for (const label of ["人群", "干预或暴露", "对照", "结局", "设计", "阶段"]) expect(screen.queryByText(label)).toBeNull();
  });

  it("reads a card from a server that sent no labels: the slot's own name", () => {
    show({ card: [{ slot: "data_source", recordId: "rec_d", text: "医院 2018 到 2024 年的电子病历", updatedAt: null }] });
    expect(screen.getByText("材料与数据")).toBeInTheDocument();
  });

  it("gives a slot a door only when the memory behind it is on the page", async () => {
    const opened = vi.fn();
    show({ card: [
      { slot: "design", recordId: "rec_a", text: "回顾性队列", updatedAt: null },
      { slot: "stage", recordId: "rec_b", text: "写分析计划", updatedAt: null },
    ] }, { canOpen: (id) => id === "rec_a", onOpen: opened });
    await userEvent.click(screen.getByRole("button", { name: /回顾性队列/ }));
    expect(opened).toHaveBeenCalledWith("rec_a");
    expect(screen.queryByRole("button", { name: /写分析计划/ })).toBeNull();
    expect(screen.getByText("阶段")).toBeInTheDocument();
  });

  it("shows the first works and the rest on request", async () => {
    const items = Array.from({ length: 9 }, (_, index) => ({
      runId: `run_${index}`, title: `研究 ${index}`, path: `deliverables/d${index}/report.md`, name: "report.md", at: `2026-10-${String(20 - index).padStart(2, "0")}T02:00:00.000Z`,
    }));
    show({ works: [{ month: "2026-10", items }] });
    expect(screen.getAllByRole("link")).toHaveLength(6);
    await userEvent.click(screen.getByRole("button", { name: "显示更多 · 还有 3 项" }));
    expect(screen.getAllByRole("link")).toHaveLength(9);
    expect(within(screen.getAllByRole("link")[0].closest("li")!).getByText("10月20日")).toBeInTheDocument();
  });
});

describe("how long a memory held", () => {
  const day = (iso: string) => Date.parse(iso);
  const now = day("2026-10-12T00:00:00Z");
  const record = (patch: Record<string, unknown> = {}) => ({ createdAt: "2026-09-12T02:00:00Z", invalidSince: null, revisions: [], relations: undefined, ...patch }) as never;

  it("is drawn for a real term — an end, or an interval a source stated — and for nothing else", () => {
    expect(validitySpan(record(), now)).toBeNull();
    expect(validitySpan(record({ invalidSince: "2026-10-03T02:00:00Z" }), now)).toMatchObject({ ended: true, ticks: [] });
    expect(validitySpan(record({ relations: { validity: { from: "2026-01-01T00:00:00Z", until: null }, caveats: [], conflicts: [] } }), now)).toMatchObject({ ended: false, from: day("2026-01-01T00:00:00Z") });
    expect(validitySpan(record({ relations: { validity: { from: null, until: "2026-09-30T00:00:00Z" }, caveats: [], conflicts: [] } }), now)).toMatchObject({ ended: true });
  });

  it("is not drawn from an age: a memory reworded any number of times, with no term and no replacement, has the date it was made and no bar", () => {
    const reworded = record({ revisions: [{ changedAt: "2026-09-20T02:00:00Z" }, { changedAt: "2026-09-25T02:00:00Z" }, { changedAt: "2026-10-01T02:00:00Z" }] });
    expect(validitySpan(reworded, now)).toBeNull();
    // Its changes are ticks on a term it has, never a term of their own.
    const changed = validitySpan(record({ revisions: [{ changedAt: "2026-09-20T02:00:00Z" }, { changedAt: "2026-09-25T02:00:00Z" }, { changedAt: "2026-10-01T02:00:00Z" }], invalidSince: "2026-10-05T00:00:00Z" }), now);
    expect(changed?.ticks).toEqual([day("2026-09-20T02:00:00Z"), day("2026-09-25T02:00:00Z"), day("2026-10-01T02:00:00Z")]);
  });

  it("does not end before the end has come, and has no bar when it ended before it began", () => {
    expect(validitySpan(record({ invalidSince: "2026-12-01T00:00:00Z", revisions: [{ changedAt: "2026-09-20T02:00:00Z" }] }), now)).toMatchObject({ ended: false, to: now });
    expect(validitySpan(record({ invalidSince: "2026-09-01T00:00:00Z" }), now)).toBeNull();
    expect(validitySpan(record({ createdAt: null }), now)).toBeNull();
  });
});
