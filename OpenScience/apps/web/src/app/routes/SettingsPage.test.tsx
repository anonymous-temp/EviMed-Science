import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";

const api = vi.hoisted(() => ({ fetchWebMe: vi.fn(), getWebProjectId: vi.fn() }));
vi.mock("@/lib/apiClient", () => api);
vi.mock("@/components/settings/PluginsCard", () => ({ PluginsCard: ({ projectId }: { projectId: string }) => <div>Plugin project: {projectId}</div> }));
vi.mock("@/components/settings/WebProjectsCard", () => ({ WebProjectsCard: ({ onProjectChange }: { onProjectChange: (project: { id: string }) => void }) => <div>托管项目自助管理<button onClick={() => onProjectChange({ id: "beta" })}>Switch project</button></div> }));
vi.mock("@/components/settings/WebReadinessCard", () => ({ WebReadinessCard: () => <div>SaaS 部署就绪</div> }));
vi.mock("@/components/settings/WebResourcesCard", () => ({ WebResourcesCard: () => <div>资源与配额</div> }));
vi.mock("@/components/settings/WebAuditCard", () => ({ WebAuditCard: () => <div>项目审计记录</div> }));
vi.mock("@/components/settings/WebErrorsCard", () => ({ WebErrorsCard: () => <div>错误记录</div> }));
vi.mock("@/components/settings/WebSecurityCard", () => ({ WebSecurityCard: () => <div>安全记录</div> }));
vi.mock("@/components/settings/WebTasksCard", () => ({ WebTasksCard: () => <div>异步任务状态</div> }));

beforeEach(() => { vi.clearAllMocks(); api.getWebProjectId.mockReturnValue("alpha"); });

describe("SettingsPage", () => {
  beforeEach(() => {
    api.fetchWebMe.mockResolvedValue({
      user: { id: "alice", name: "Alice", tenantId: "alice" },
      project: { id: "paper1", name: "Paper 1" },
      projects: [{ id: "paper1", name: "Paper 1" }],
    });
  });

  it("keeps the operational surface: projects, resources, data flow and readiness", async () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    expect(await screen.findByText("托管项目自助管理")).toBeInTheDocument();
    expect(screen.getByText("资源与配额")).toBeInTheDocument();
    expect(screen.getByText("隐私与数据流向")).toBeInTheDocument();
    expect(screen.getByText("SaaS 部署就绪")).toBeInTheDocument();
    expect(screen.getByText("任务、审计与安全详情")).toBeInTheDocument();
    expect(screen.getByText("异步任务状态")).toBeInTheDocument();
    expect(screen.getByText("项目审计记录")).toBeInTheDocument();
    expect(screen.getByText("错误记录")).toBeInTheDocument();
    expect(screen.getByText("安全记录")).toBeInTheDocument();
  });

  // A hosted account does not pick a model and does not hold a provider key —
  // the gateway resolves both per request. A control here would be one the
  // server refuses, which is worse than no control at all.
  it("offers no model, credential or approval control", async () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    await screen.findByText("托管项目自助管理");
    for (const gone of [/API Key/i, /审批模式/, /选择模型/, /添加 MCP/]) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }
    // The data-flow card names the model that handles the data, not a choice.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("scopes the data-flow card to the project the account is actually in", async () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    expect((await screen.findAllByText(/\/workspace\/paper1/)).length).toBeGreaterThan(0);
  });
});

describe("SettingsPage plugin project binding", () => {
  it("starts with the current tab's project and ignores a late initial response after a selection", async () => {
    let resolve!: (value: { project: { id: string } }) => void;
    api.fetchWebMe.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<SettingsPage />);
    expect(screen.getByText("Plugin project: alpha")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Switch project" }));
    await act(async () => resolve({ project: { id: "alpha" } }));
    expect(screen.getByText("Plugin project: beta")).toBeInTheDocument();
  });

  it("uses the server's resolved project when the remembered project no longer exists", async () => {
    api.fetchWebMe.mockResolvedValue({ project: { id: "default" } });
    render(<SettingsPage />);
    expect(await screen.findByText("Plugin project: default")).toBeInTheDocument();
  });

  it("does not retarget cards when the tab's project changes during initial validation", async () => {
    let resolve!: (value: { project: { id: string } }) => void;
    api.fetchWebMe.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<SettingsPage />);
    api.getWebProjectId.mockReturnValue("beta");
    await act(async () => resolve({ project: { id: "old-project" } }));
    expect(screen.getByText("Plugin project: alpha")).toBeInTheDocument();
  });
});
