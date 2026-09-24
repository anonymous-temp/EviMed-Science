import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWebProjectId, setWebProjectId } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { OpsPage } from "./OpsPage";

const api = vi.hoisted(() => ({ fetchWebMe: vi.fn(), listWebProjects: vi.fn() }));
vi.mock("@/lib/apiClient", async (original) => ({
  ...await original<typeof import("@/lib/apiClient")>(),
  ...api,
  hasWebApi: true,
}));
vi.mock("@/components/settings/PluginsCard", () => ({ PluginsCard: ({ projectId }: { projectId: string }) => <div>Plugin project: {projectId}</div> }));
vi.mock("@/components/settings/WebReadinessCard", () => ({ WebReadinessCard: () => <div>部署就绪检查</div> }));
vi.mock("@/components/settings/WebResourcesCard", () => ({ WebResourcesCard: () => null }));
vi.mock("@/components/settings/WebAuditCard", () => ({ WebAuditCard: () => null }));
vi.mock("@/components/settings/WebErrorsCard", () => ({ WebErrorsCard: () => null }));
vi.mock("@/components/settings/WebSecurityCard", () => ({ WebSecurityCard: () => null }));
vi.mock("@/components/settings/WebTasksCard", () => ({ WebTasksCard: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  setWebProjectId("alpha");
  useProjectStore.getState().clear();
  api.listWebProjects.mockResolvedValue([{ id: "default", name: "Default" }]);
});
afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  useProjectStore.getState().clear();
});

// 「项目插件」 moved here from 项目 on 2026-09-23: a researcher has nothing to
// configure in it. It stays bound to the project the account is actually in.
describe("运维: the deployment's console and the project's plugins", () => {
  it("holds the console and the plugins of the tab's project, with one line on what its controls do", async () => {
    api.fetchWebMe.mockResolvedValue({ project: { id: "alpha" } });
    render(<OpsPage />);
    expect(screen.getByText("部署就绪检查")).toBeInTheDocument();
    expect(await screen.findByText("Plugin project: alpha")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("停止或重启会中断进行中的研究");
  });

  it("uses the server's resolved project when the remembered project no longer exists", async () => {
    api.fetchWebMe.mockResolvedValue({ project: { id: "default" } });
    render(<OpsPage />);
    expect(await screen.findByText("Plugin project: default")).toBeInTheDocument();
  });

  it("does not retarget the plugins when the tab's project changes during the first read", async () => {
    let resolve!: (value: { project: { id: string } }) => void;
    api.fetchWebMe.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<OpsPage />);
    setWebProjectId("beta");
    await act(async () => resolve({ project: { id: "old-project" } }));
    expect(screen.getByText("Plugin project: alpha")).toBeInTheDocument();
  });

  it("accepts the project store's repair of a deleted remembered project when the account answers later", async () => {
    setWebProjectId("deleted-project");
    let resolveMe!: (value: { project: { id: string } }) => void;
    api.fetchWebMe.mockReturnValue(new Promise((resolve) => { resolveMe = resolve; }));
    render(<OpsPage />);
    expect(screen.getByText("Plugin project: deleted-project")).toBeInTheDocument();
    await act(async () => { await useProjectStore.getState().load(); });
    expect(getWebProjectId()).toBe("default");
    await act(async () => resolveMe({ project: { id: "default" } }));
    expect(screen.getByText("Plugin project: default")).toBeInTheDocument();
  });
});
