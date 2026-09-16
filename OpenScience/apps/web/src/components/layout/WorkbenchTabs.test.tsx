import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { WorkbenchTabs } from "./WorkbenchTabs";

// No direct test until 2026-09-16 (review, D5). Every grouped destination —
// knowledge, memory, account — is one of these.
function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function mount(entry: string) {
  const renders = { a: vi.fn(() => <p>视图 A</p>), b: vi.fn(() => <p>视图 B</p>), c: vi.fn(() => <p>视图 C</p>) };
  render(
    <MemoryRouter initialEntries={[entry]}>
      <WorkbenchTabs
        title="记忆"
        tabs={[
          { key: "a", label: "科研记忆", render: renders.a },
          { key: "b", label: "方法胶囊", render: renders.b },
          { key: "c", label: "学习方法", render: renders.c },
        ]}
      />
      <Where />
    </MemoryRouter>,
  );
  return renders;
}

describe("WorkbenchTabs", () => {
  it("opens the tab the link names, and renders only that view", () => {
    const renders = mount("/app/memory?tab=b");
    expect(screen.getByRole("tab", { name: "方法胶囊" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("视图 B");
    expect(renders.a).not.toHaveBeenCalled();
    expect(renders.c).not.toHaveBeenCalled();
  });

  it("falls back to the first tab for an unknown key, and keeps the first tab's link clean", async () => {
    mount("/app/memory?tab=retired&x=1");
    expect(screen.getByRole("tab", { name: "科研记忆" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("tab", { name: "学习方法" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/app/memory?tab=c&x=1");
    await userEvent.click(screen.getByRole("tab", { name: "科研记忆" }));
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/app\/memory\?x=1$/);
  });

  it("is one tab stop, with arrows, Home and End moving the selection and the focus", async () => {
    mount("/app/memory");
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    tabs[0].focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "方法胶囊" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "方法胶囊" })).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "学习方法" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "科研记忆" })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "学习方法" })).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "科研记忆" })).toHaveAttribute("aria-selected", "true");
  });
});
