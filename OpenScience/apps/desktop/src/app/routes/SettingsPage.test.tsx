import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";

const mocks = vi.hoisted(() => {
  const runtimeState = {
    status: "ready",
    serverUrl: "/api/runtime",
    setServerUrl: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    clearHostedSession: vi.fn(),
    defaultModel: "anthropic/claude-sonnet-4",
    loadCatalog: vi.fn(),
  };
  const useRuntimeStore = vi.fn(() => runtimeState) as unknown as ReturnType<typeof vi.fn> & {
    getState: ReturnType<typeof vi.fn>;
  };
  useRuntimeStore.getState = vi.fn(() => ({
    bootstrap: vi.fn(),
    connectRetry: vi.fn(),
  }));

  return {
    getClient: vi.fn(),
    jupyterStatus: vi.fn(),
    runtimeState,
    useRuntimeStore,
    fetchWebAuthMethods: vi.fn(),
    fetchWebMe: vi.fn(),
    getWebOidcStartUrl: vi.fn(() => "/api/auth/oidc/start?returnTo=%2Fsettings"),
    loginWeb: vi.fn(),
    workspaceBase: vi.fn(),
    // The session view the control plane reports. `legacy` is the default
    // because it is what these tests were written against and what the desktop
    // shell renders; the F1 settings cleanup is asserted separately, under
    // `run-stream`.
    sessionView: "legacy" as "run-stream" | "legacy",
  };
});

vi.mock("@/lib/runtime", () => ({
  getClient: mocks.getClient,
  useRuntimeStore: mocks.useRuntimeStore,
}));

vi.mock("@/lib/store", () => ({
  useUiStore: (selector: (state: { theme: string; setTheme: () => void }) => unknown) =>
    selector({ theme: "light", setTheme: vi.fn() }),
}));

vi.mock("@/lib/tauri", () => ({
  importOpenCodeLogin: vi.fn(),
  isTauri: false,
  jupyterStatus: mocks.jupyterStatus,
  openExternal: vi.fn(),
  openWorkspaceBase: vi.fn(),
  pickFolder: vi.fn(),
  removeConfigEntry: vi.fn(),
  setupJupyter: vi.fn(),
  setWorkspaceBase: vi.fn(),
  startJupyter: vi.fn(),
  workspaceBase: mocks.workspaceBase,
  setupScienceMcp: vi.fn(),
}));

vi.mock("@/lib/apiClient", () => ({
  fetchWebAuthMethods: mocks.fetchWebAuthMethods,
  fetchWebMe: mocks.fetchWebMe,
  getWebOidcStartUrl: mocks.getWebOidcStartUrl,
  hasCommandBackend: true,
  hasWebApi: true,
  loginWeb: mocks.loginWeb,
  webRuntimeProfile: () => ({ sessionView: mocks.sessionView }),
  WEB_SESSION_ENDED_EVENT: "open-science:web-session-ended",
}));

vi.mock("@/components/settings/WebResourcesCard", () => ({
  WebResourcesCard: () => <div>托管资源</div>,
}));

vi.mock("@/components/settings/WebProjectsCard", () => ({
  WebProjectsCard: ({ onProjectChange }: { onProjectChange?: () => void }) => (
    <div>
      托管项目
      <button onClick={() => onProjectChange?.()}>Simulate project switch</button>
    </div>
  ),
}));

vi.mock("@/components/settings/WebAccountCard", () => ({
  WebAccountCard: () => <div>托管账户</div>,
}));

vi.mock("@/components/settings/WebReadinessCard", () => ({
  WebReadinessCard: () => <div>部署就绪检查</div>,
}));

vi.mock("@/components/settings/WebTasksCard", () => ({
  WebTasksCard: () => <div>托管任务</div>,
}));

vi.mock("@/components/settings/WebAuditCard", () => ({
  WebAuditCard: () => <div>托管审计</div>,
}));

vi.mock("@/components/settings/WebErrorsCard", () => ({
  WebErrorsCard: () => <div>托管错误</div>,
}));

vi.mock("@/components/settings/WebSecurityCard", () => ({
  WebSecurityCard: () => <div>托管安全</div>,
}));

vi.mock("@/components/settings/ClusterCard", () => ({
  ClusterCard: () => <div>Cluster</div>,
}));

vi.mock("@/components/settings/ModalCard", () => ({
  ModalCard: () => <div>Modal</div>,
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

describe("SettingsPage hosted web model configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchWebMe.mockResolvedValue({
      user: { id: "alice", name: "Alice" },
      project: { id: "paper1", name: "Paper 1" },
      projects: [{ id: "paper1", name: "Paper 1" }],
    });
    mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "local" });
    mocks.loginWeb.mockResolvedValue(undefined);
    mocks.workspaceBase.mockResolvedValue("/workspace/paper1");
    mocks.jupyterStatus.mockResolvedValue(null);
    mocks.getClient.mockReturnValue({
      listProviders: vi.fn().mockResolvedValue([
        { id: "anthropic", name: "Anthropic", models: [{ id: "claude-sonnet-4", name: "Claude Sonnet 4" }] },
      ]),
      listAuthMethods: vi.fn().mockResolvedValue({
        anthropic: [{ type: "api", label: "API key" }],
      }),
      listProviderCatalog: vi.fn().mockResolvedValue({
        all: [{ id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"] }],
      }),
      listCustomProviderIds: vi.fn().mockResolvedValue([]),
      listMcpServers: vi.fn().mockResolvedValue([
        {
          name: "science-paper-search",
          status: "connected",
          config: { type: "local", command: ["python3", "/managed/science_connectors.py"] },
        },
        {
          name: "playwright",
          status: "connected",
          config: { type: "local", command: ["npx", "-y", "@playwright/mcp"] },
        },
      ]),
      setDefaultModel: vi.fn(),
    });
  });

  it("hides browser-visible provider key and custom endpoint controls", async () => {
    render(<SettingsPage />);

    expect(await screen.findByText("托管 API 会话、项目运行时，以及由服务端管理的工作区。")).toBeInTheDocument();
    await waitFor(() => expect(mocks.getClient).toHaveBeenCalled());

    expect(screen.getByText("平台托管")).toBeInTheDocument();
    expect(screen.getByText("托管账户")).toBeInTheDocument();
    expect(screen.getByText("部署就绪检查")).toBeInTheDocument();
    expect(screen.getByText("托管项目")).toBeInTheDocument();
    expect(screen.getByText(/托管模型的凭据暂不在此界面管理/)).toBeInTheDocument();
    expect(await screen.findByDisplayValue("Claude Sonnet 4")).toBeDisabled();
    expect(screen.queryByPlaceholderText(/API key/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/接入提供方/)).not.toBeInTheDocument();
    expect(screen.queryByText("自定义接入点")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "移除" })).not.toBeInTheDocument();
    expect(screen.getByText("7 个科学连接器由服务端默认管理；Jupyter 与自定义 MCP 仍需部署方审核后配置。")).toBeInTheDocument();
    expect(screen.getByText("science-paper-search")).toBeInTheDocument();
    expect(screen.getByText("playwright")).toBeInTheDocument();
    expect(screen.getAllByText("服务端托管 · connected")).toHaveLength(2);
    expect(screen.getAllByText("由部署方配置")).toHaveLength(2);
    expect(screen.queryByText("npx -y @playwright/mcp")).not.toBeInTheDocument();
    expect(mocks.jupyterStatus).not.toHaveBeenCalled();
  });

  it("shows the deployment OIDC login action without local password fields", async () => {
    mocks.fetchWebMe.mockResolvedValue(null);
    mocks.fetchWebAuthMethods.mockResolvedValue({
      mode: "oidc",
      oidc: { label: "Research SSO", startUrl: "/api/auth/oidc/start" },
    });

    render(<SettingsPage />);

    const login = await screen.findByRole("link", { name: "Research SSO" });
    expect(login).toHaveAttribute("href", "/api/auth/oidc/start?returnTo=%2Fsettings");
    expect(screen.queryByPlaceholderText("用户名")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("密码")).not.toBeInTheDocument();
  });

  it("returns to the login state when the hosted session expires", async () => {
    render(<SettingsPage />);

    expect(await screen.findByText(/当前登录/)).toBeInTheDocument();
    expect(await screen.findAllByText(/\/workspace\/paper1/)).not.toHaveLength(0);
    fireEvent(window, new Event("open-science:web-session-ended"));

    expect(await screen.findByPlaceholderText("用户名")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("密码")).toBeInTheDocument();
    expect(screen.queryByText(/\/workspace\/paper1/)).not.toBeInTheDocument();
  });

  it("refreshes the hosted workspace path after local login", async () => {
    mocks.fetchWebMe
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        user: { id: "alice", name: "Alice" },
        project: { id: "default", name: "Default Project" },
        projects: [{ id: "default", name: "Default Project" }],
      });
    mocks.workspaceBase
      .mockRejectedValueOnce(new Error("Unauthorized"))
      .mockResolvedValueOnce("/workspace/default");

    render(<SettingsPage />);

    fireEvent.change(await screen.findByPlaceholderText("用户名"), {
      target: { value: "alice" },
    });
    fireEvent.change(screen.getByPlaceholderText("密码"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(await screen.findAllByText(/\/workspace\/default/)).not.toHaveLength(0);
    expect(mocks.loginWeb).toHaveBeenCalledWith("alice", "correct horse battery staple");
    expect(mocks.workspaceBase).toHaveBeenCalledTimes(2);
  });

  it("refreshes the hosted workspace path after a project switch", async () => {
    mocks.workspaceBase
      .mockResolvedValueOnce("/workspace/paper1")
      .mockResolvedValueOnce("/workspace/paper2");

    render(<SettingsPage />);

    expect(await screen.findAllByText(/\/workspace\/paper1/)).not.toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Simulate project switch" }));

    expect(await screen.findAllByText(/\/workspace\/paper2/)).not.toHaveLength(0);
    expect(mocks.workspaceBase).toHaveBeenCalledTimes(2);
  });

  it("offers light / dark / system appearance choices", async () => {
    render(<SettingsPage />);

    expect(await screen.findByText("外观")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "外观主题" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "浅色" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "深色" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "跟随系统" })).toBeInTheDocument();
  });
});

describe("SettingsPage under the server-managed runtime (F1 settings cleanup, §18.3)", () => {
  beforeEach(() => {
    mocks.sessionView = "run-stream";
    mocks.fetchWebMe.mockResolvedValue({ user: { id: "u1", name: "Alice" } });
    mocks.fetchWebAuthMethods.mockResolvedValue({ mode: "password" });
    mocks.workspaceBase.mockResolvedValue("/workspace/default");
  });

  it("drops the retiring kernel's runtime, model and MCP cards, and keeps account / projects / resources / readiness", async () => {
    render(<SettingsPage />);
    await screen.findByText("Alice");

    // Gone: three cards that would let a person configure nothing. The runtime
    // URL card is the one that matters most — it offered a text field and a
    // Connect button for a runtime the control plane starts.
    expect(screen.queryByText("模型")).toBeNull();
    expect(screen.queryByText("MCP 服务器")).toBeNull();
    expect(screen.queryByPlaceholderText("托管运行时代理")).toBeNull();
    expect(screen.queryByRole("button", { name: "重新连接" })).toBeNull();

    // Kept: everything that belongs to the control plane rather than the kernel.
    expect(screen.getByText("托管账户")).toBeInTheDocument();
    expect(screen.getByText("托管项目")).toBeInTheDocument();
    expect(screen.getByText("托管资源")).toBeInTheDocument();
    expect(screen.getByText("部署就绪检查")).toBeInTheDocument();
    expect(screen.getByText("外观")).toBeInTheDocument();

    // And the runtime card is replaced rather than silently missing: a reader
    // who went looking for it is told where the configuration went.
    expect(screen.getByText("智能体运行时")).toBeInTheDocument();
    expect(screen.getByText(/由控制面启动并管理/)).toBeInTheDocument();
  });
});
