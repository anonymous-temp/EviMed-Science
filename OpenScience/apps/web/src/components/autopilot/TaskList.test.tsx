import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
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
