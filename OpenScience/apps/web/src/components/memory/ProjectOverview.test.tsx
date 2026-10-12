import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectOverview as Overview } from "@/lib/memoryClient";
import { ProjectOverview, monthHeading, workPath } from "./ProjectOverview";
import { validitySpan } from "./ValidityBar";

const base: Overview = { projectId: "prj_1", paused: false, card: [], capabilities: [], works: [], timeZone: "UTC" };
function show(patch: Partial<Overview>, props: { canOpen?: (id: string) => boolean; onOpen?: (id: string) => void } = {}) {
  return render(
    <MemoryRouter>
      <ProjectOverview overview={{ ...base, ...patch }} canOpen={props.canOpen ?? (() => true)} onOpen={props.onOpen ?? (() => undefined)} />
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

  it("is drawn for an end, a stated interval or a version, and not for a memory with nothing else to say", () => {
    expect(validitySpan(record(), now)).toBeNull();
    expect(validitySpan(record({ invalidSince: "2026-10-03T02:00:00Z" }), now)).toMatchObject({ ended: true, ticks: [] });
    expect(validitySpan(record({ relations: { validity: { from: "2026-01-01T00:00:00Z", until: null }, caveats: [], conflicts: [] } }), now)).toMatchObject({ ended: false, from: day("2026-01-01T00:00:00Z") });
    const changed = validitySpan(record({ revisions: [{ changedAt: "2026-09-20T02:00:00Z" }, { changedAt: "2026-09-20T02:00:00Z" }, { changedAt: "2026-09-01T00:00:00Z" }, { changedAt: null }] }), now);
    expect(changed?.ticks).toEqual([day("2026-09-20T02:00:00Z")]);
  });

  it("does not end before the end has come, and has no bar when it ended before it began", () => {
    expect(validitySpan(record({ invalidSince: "2026-12-01T00:00:00Z", revisions: [{ changedAt: "2026-09-20T02:00:00Z" }] }), now)).toMatchObject({ ended: false, to: now });
    expect(validitySpan(record({ invalidSince: "2026-09-01T00:00:00Z" }), now)).toBeNull();
    expect(validitySpan(record({ createdAt: null }), now)).toBeNull();
  });
});
