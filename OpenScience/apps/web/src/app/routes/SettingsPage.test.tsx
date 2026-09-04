import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";

const mocks = vi.hoisted(() => ({
  fetchWebMe: vi.fn(),
}));

vi.mock("@/lib/apiClient", () => ({
  fetchWebMe: mocks.fetchWebMe,
}));

vi.mock("@/components/settings/WebProjectsCard", () => ({
  WebProjectsCard: () => <div>托管项目自助管理</div>,
}));
vi.mock("@/components/settings/WebResourcesCard", () => ({
  WebResourcesCard: () => <div>资源与配额</div>,
}));
vi.mock("@/components/settings/WebReadinessCard", () => ({
  WebReadinessCard: () => <div>SaaS 部署就绪</div>,
}));
vi.mock("@/components/settings/WebTasksCard", () => ({
  WebTasksCard: () => <div>异步任务状态</div>,
}));
vi.mock("@/components/settings/WebAuditCard", () => ({
  WebAuditCard: () => <div>项目审计记录</div>,
}));
vi.mock("@/components/settings/WebErrorsCard", () => ({
  WebErrorsCard: () => <div>错误记录</div>,
}));
vi.mock("@/components/settings/WebSecurityCard", () => ({
  WebSecurityCard: () => <div>安全记录</div>,
}));

describe("SettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchWebMe.mockResolvedValue({
      user: { id: "alice", name: "Alice", tenantId: "alice" },
      project: { id: "paper1", name: "Paper 1" },
      projects: [{ id: "paper1", name: "Paper 1" }],
    });
  });

  it("keeps the operational surface: projects, resources, data flow and readiness", async () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

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
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

    await screen.findByText("托管项目自助管理");
    for (const gone of [/API Key/i, /审批模式/, /选择模型/, /添加 MCP/]) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }
    // Nothing on this page is a picker. The data-flow card names the model
    // that handles the data, which is a statement, not a choice.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("scopes the data-flow card to the project the account is actually in", async () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

    // The path is rendered inside a sentence, so match the fragment.
    expect((await screen.findAllByText(/\/workspace\/paper1/)).length).toBeGreaterThan(0);
  });
});
