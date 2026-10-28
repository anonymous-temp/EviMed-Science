import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { AgendaRecord } from "@/lib/autopilotClient";
import { TaskList } from "./TaskList";

const noop = () => {};
const actions = { recover: noop, run: noop, togglePause: noop, edit: noop, remove: noop };
const list = (projectName?: string) => render(<MemoryRouter>
  <TaskList agendas={[]} episodes={[]} selectedId={null} search="" onSearch={noop} projectName={projectName} error={null}
    onRetry={noop} onCreate={noop} busy={false} actions={actions} singleColumn />
</MemoryRouter>);

describe("TaskList header scope", () => {
  it("names the project once it is known, and says 当前项目 only once while it loads", () => {
    const loading = list();
    expect(loading.container.textContent).toContain("当前项目");
    expect(loading.container.textContent).not.toContain("当前项目 · 当前项目");
    loading.unmount();
    list("肺癌靶向治疗");
    expect(screen.getByText("肺癌靶向治疗").parentElement?.textContent).toBe("当前项目 · 肺癌靶向治疗");
  });
});

describe("what the list says with no task", () => {
  const props = { episodes: [], selectedId: null, search: "", onSearch: noop, error: null, onRetry: noop, onCreate: noop, busy: false, actions, singleColumn: false };
  const task = { id: "agenda-1", projectId: "p", revision: 1, createdAt: "", updatedAt: "", deletedAt: null, payload: { title: "每周文献", prompt: "跟进", topics: [], taskTypes: ["routine"], enabled: true, status: "active", scheduleState: "scheduled",
    schedule: { kind: "daily", timeZone: "Asia/Shanghai", time: "07:00" }, nextRunAt: "2026-10-02T23:00:00Z", outcomes: [] } } as unknown as AgendaRecord;

  it("is what the page puts there (the examples), in place of the sentence that there is none, and no search box", () => {
    render(<MemoryRouter><TaskList {...props} agendas={[]} empty={<p>从示例开始</p>} /></MemoryRouter>);
    expect(screen.getByText("从示例开始")).toBeInTheDocument();
    expect(screen.queryByText("还没有定时任务")).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it("is one line that there is none where the page offers nothing, and is not drawn once there is a task or a search without a match", () => {
    const first = render(<MemoryRouter><TaskList {...props} agendas={[]} /></MemoryRouter>);
    expect(screen.getByText("还没有定时任务")).toBeInTheDocument();
    first.unmount();
    const second = render(<MemoryRouter><TaskList {...props} agendas={[task]} empty={<p>从示例开始</p>} /></MemoryRouter>);
    expect(screen.queryByText("从示例开始")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "每周文献" })).toBeInTheDocument();
    second.unmount();
    render(<MemoryRouter><TaskList {...props} agendas={[task]} search="无此任务" empty={<p>从示例开始</p>} /></MemoryRouter>);
    expect(screen.getByText("没有匹配的任务")).toBeInTheDocument();
    expect(screen.queryByText("从示例开始")).not.toBeInTheDocument();
  });
});
