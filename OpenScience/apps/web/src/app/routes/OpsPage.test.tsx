import { act, render, screen, waitFor } from "@testing-library/react";
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
vi.mock("@/components/evolution/EvolutionPanel", () => ({ EvolutionPanel: () => <div>循证进化面板</div> }));
vi.mock("@/components/settings/WebReadinessCard", () => ({ WebReadinessCard: () => <div>部署配置检查</div> }));
vi.mock("@/components/settings/WebResourcesCard", () => ({ WebResourcesCard: () => <div>运行状况</div> }));
vi.mock("@/components/settings/WebAuditCard", () => ({ WebAuditCard: () => null }));
vi.mock("@/components/settings/WebErrorsCard", () => ({ WebErrorsCard: () => null }));
vi.mock("@/components/settings/WebSecurityCard", () => ({ WebSecurityCard: () => null }));
// The cards are keyed by the project the console is bound to, so a retarget is a remount: this one counts its mounts.
const mounts = vi.hoisted(() => ({ tasks: 0 }));
vi.mock("@/components/settings/WebTasksCard", async () => {
  const { useEffect } = await import("react");
  return { WebTasksCard: () => { useEffect(() => { mounts.tasks += 1; }, []); return null; } };
});

vi.mock("@/components/settings/GeoMarketCard", () => ({ GeoMarketCard: () => <div>循证 GEO 投放</div> }));

beforeEach(() => {
  vi.clearAllMocks();
  mounts.tasks = 0;
  setWebProjectId("alpha");
  useProjectStore.getState().clear();
  api.listWebProjects.mockResolvedValue([{ id: "default", name: "Default" }]);
});
afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  useProjectStore.getState().clear();
});

// 「项目插件」 left here on 2026-10-07 (it is on 插件与技能 now) and 「循证进化」 arrived. The console stays bound to the project the
// account is actually in: its cards remount when that project is corrected, and only then.
describe("运维: the deployment's console and the evolution engine", () => {
  it("holds the console and 循证进化, with one line on what its controls do, and no project plugins", async () => {
    api.fetchWebMe.mockResolvedValue({ project: { id: "alpha" } });
    render(<OpsPage />);
    expect(screen.getByText("部署配置检查")).toBeInTheDocument();
    expect(screen.getByText("循证 GEO 投放")).toBeInTheDocument();
    expect(screen.getByText("循证进化面板")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("停止或重启会中断进行中的研究");
    expect(screen.queryByText(/项目插件/)).not.toBeInTheDocument();
    await waitFor(() => expect(api.fetchWebMe).toHaveBeenCalled());
    expect(mounts.tasks).toBe(1);
  });

  it("puts what is running now before whether the configuration holds", () => {
    api.fetchWebMe.mockResolvedValue({ project: { id: "alpha" } });
    render(<OpsPage />);
    const running = screen.getByText("运行状况");
    const configuration = screen.getByText("部署配置检查");
    expect(running.compareDocumentPosition(configuration) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("uses the server's resolved project when the remembered project no longer exists", async () => {
    api.fetchWebMe.mockResolvedValue({ project: { id: "default" } });
    render(<OpsPage />);
    await waitFor(() => expect(mounts.tasks).toBe(2));
  });

  it("does not retarget the console when the tab's project changes during the first read", async () => {
    let resolve!: (value: { project: { id: string } }) => void;
    api.fetchWebMe.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<OpsPage />);
    setWebProjectId("beta");
    await act(async () => resolve({ project: { id: "old-project" } }));
    expect(mounts.tasks).toBe(1);
  });

  it("accepts the project store's repair of a deleted remembered project when the account answers later", async () => {
    setWebProjectId("deleted-project");
    let resolveMe!: (value: { project: { id: string } }) => void;
    api.fetchWebMe.mockReturnValue(new Promise((resolve) => { resolveMe = resolve; }));
    render(<OpsPage />);
    expect(mounts.tasks).toBe(1);
    await act(async () => { await useProjectStore.getState().load(); });
    expect(getWebProjectId()).toBe("default");
    await act(async () => resolveMe({ project: { id: "default" } }));
    expect(mounts.tasks).toBe(2);
  });
});
