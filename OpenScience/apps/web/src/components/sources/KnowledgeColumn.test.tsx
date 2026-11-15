import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { PendingFeedbackBoundary } from "@/components/ui/PendingFeedback";
import type { ProjectGroups } from "./useProjectGroups";
import { ProjectList } from "./KnowledgeColumn";

const groups: ProjectGroups = { own: [], applicable: [], studies: [], communication: [], labels: new Map() };
const current = { id: "default", label: "我的项目" };
const hrefFor = (projectId: string) => `/app/files?scope=${projectId}&kind=wiki`;

function show(props: Partial<Parameters<typeof ProjectList>[0]> = {}) {
  return render(<PendingFeedbackBoundary mode="passive"><MemoryRouter><ProjectList groups={groups} chosen="default" hrefFor={hrefFor} current={current} loading={false} {...props} /></MemoryRouter></PendingFeedbackBoundary>);
}

afterEach(cleanup);

describe("the project column of knowledge pages and graphs", () => {
  it("keeps the current project reachable and shows a loading skeleton while projects are read", () => {
    const { container } = show({ loading: true });
    expect(screen.getByRole("link", { name: "我的项目" })).toHaveAttribute("href", "/app/files?scope=default&kind=wiki");
    expect(container.querySelector("[data-project-list] .animate-pulse")).not.toBeNull();
  });

  it("keeps the current default project as a row even when the read returned no project group", () => {
    show();
    expect(screen.getByRole("link", { name: "我的项目" })).toHaveAttribute("aria-current", "true");
  });

  it("says when there is no project instead of leaving a blank column", () => {
    show({ current: null });
    expect(screen.getByText("暂时没有可显示的项目")).toBeInTheDocument();
  });
});
