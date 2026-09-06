import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWebProjectId, setWebProjectId } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { SettingsPage } from "./SettingsPage";

const api = vi.hoisted(() => ({ fetchWebMe: vi.fn(), listWebProjects: vi.fn() }));
vi.mock("@/lib/apiClient", async (original) => ({
  ...await original<typeof import("@/lib/apiClient")>(),
  ...api,
  hasWebApi: true,
}));
vi.mock("@/components/settings/PluginsCard", () => ({ PluginsCard: ({ projectId }: { projectId: string }) => <div>Plugin project: {projectId}</div> }));
vi.mock("@/components/settings/WebProjectsCard", () => ({ WebProjectsCard: () => null }));
vi.mock("@/components/settings/WebReadinessCard", () => ({ WebReadinessCard: () => null }));
vi.mock("@/components/settings/WebResourcesCard", () => ({ WebResourcesCard: () => null }));
vi.mock("@/components/settings/WebAuditCard", () => ({ WebAuditCard: () => null }));
vi.mock("@/components/settings/WebErrorsCard", () => ({ WebErrorsCard: () => null }));
vi.mock("@/components/settings/WebSecurityCard", () => ({ WebSecurityCard: () => null }));
vi.mock("@/components/settings/WebTasksCard", () => ({ WebTasksCard: () => null }));
vi.mock("@/components/settings/DataFlowCard", () => ({ DataFlowCard: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  setWebProjectId("deleted-project");
  useProjectStore.getState().clear();
  api.listWebProjects.mockResolvedValue([{ id: "default", name: "Default" }]);
});
afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  useProjectStore.getState().clear();
});

describe("SettingsPage automatic project fallback", () => {
  it("accepts the real store's repaired project when the initial account response arrives later", async () => {
    let resolveMe!: (value: { project: { id: string } }) => void;
    api.fetchWebMe.mockReturnValue(new Promise((resolve) => { resolveMe = resolve; }));
    render(<SettingsPage />);
    expect(screen.getByText("Plugin project: deleted-project")).toBeInTheDocument();

    await act(async () => { await useProjectStore.getState().load(); });
    expect(getWebProjectId()).toBe("default");
    expect(window.sessionStorage.getItem("openScience.projectId")).toBe("default");
    expect(useProjectStore.getState().currentId).toBe("default");

    await act(async () => resolveMe({ project: { id: "default" } }));
    expect(screen.getByText("Plugin project: default")).toBeInTheDocument();
  });

  it("still ignores an old fallback response after the tab selects another project", async () => {
    let resolveMe!: (value: { project: { id: string } }) => void;
    api.fetchWebMe.mockReturnValue(new Promise((resolve) => { resolveMe = resolve; }));
    render(<SettingsPage />);
    await act(async () => { await useProjectStore.getState().load(); });
    setWebProjectId("new-project");

    await act(async () => resolveMe({ project: { id: "default" } }));
    expect(screen.queryByText("Plugin project: default")).not.toBeInTheDocument();
    expect(getWebProjectId()).toBe("new-project");
  });
});
