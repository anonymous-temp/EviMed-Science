import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRuntimeStore } from "@/lib/runtime";
import { WorkspaceChip } from "./WorkspaceChip";

const mocks = vi.hoisted(() => ({
  projectId: "default",
  clientOpts: [] as Record<string, unknown>[],
  projects: [
    { id: "default", name: "Default Project" },
    { id: "paper1", name: "Paper 1" },
  ],
  createdProjects: [] as { id: string; name: string }[],
}));

vi.mock("@/lib/apiClient", () => ({
  hasCommandBackend: true,
  hasWebApi: true,
  fetchWithWebAuth: vi.fn(globalThis.fetch),
  getWebProjectId: () => mocks.projectId,
  setWebProjectId: (projectId: string) => {
    mocks.projectId = projectId;
  },
  listWebProjects: async () => mocks.projects,
  createWebProject: async (id: string, name: string) => {
    const project = { id, name };
    mocks.createdProjects.push(project);
    mocks.projects = [...mocks.projects, project];
    return project;
  },
  fetchWebMe: async () => ({ project: { id: mocks.projectId, name: mocks.projectId } }),
  listWebResearchAgents: async () => [],
  listWebResearchSessions: async () => [],
  putWebResearchSession: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  isTauri: false,
  logDebug: async () => {},
  detectTools: async () => [],
  startRuntime: async () => `http://127.0.0.1:8787/api/runtime/${mocks.projectId}`,
  workspacePath: async () => `/workspace/${mocks.projectId}`,
  runtimePassword: async () => null,
  getApprovalMode: async () => "approve",
  setApprovalMode: async () => {},
  newDatedWorkspace: async (name: string) => `/workspace/${mocks.projectId}/${name}`,
  setWorkspace: async (path: string) => path,
  pickFolder: async () => null,
}));

vi.mock("@/lib/kernel", () => ({ kernelReset: async () => {} }));

vi.mock("@ai4s/sdk", () => {
  class RuntimeClient {
    private statusCb: (s: string) => void = () => {};
    constructor(opts: Record<string, unknown>) {
      mocks.clientOpts.push(opts);
    }
    onStatus(cb: (s: string) => void) {
      this.statusCb = cb;
      return () => {
        this.statusCb = () => {};
      };
    }
    onEvent() {}
    async connect() {
      this.statusCb("ready");
    }
    async listSessions() {
      return [];
    }
    async listSkills() {
      return [];
    }
    async listAgents() {
      return [];
    }
    async listCommands() {
      return [];
    }
    async getDefaultModel() {
      return null;
    }
    close() {}
  }
  return { RuntimeClient, DEFAULT_RUNTIME_URL: "http://127.0.0.1:4096" };
});

describe("WorkspaceChip hosted web mode", () => {
  beforeEach(() => {
    mocks.projectId = "default";
    mocks.clientOpts.length = 0;
    mocks.projects = [
      { id: "default", name: "Default Project" },
      { id: "paper1", name: "Paper 1" },
    ];
    mocks.createdProjects.length = 0;
    useRuntimeStore.getState().resetProjectState();
    useRuntimeStore.setState({ currentId: null, workspace: "/workspace/default", sending: false });
  });

  it("switches the hosted project and reconnects to its proxied runtime", async () => {
    useRuntimeStore.setState({
      currentId: "ses_shared",
      threads: { ses_shared: { blocks: [{ kind: "user", text: "old project" }], index: {}, loaded: true } },
      researchSessionBindings: {
        ses_shared: {
          sessionId: "ses_shared",
          mode: "specialist",
          agentId: "adr-analysis",
          agentVersion: "1.0.0",
          runtimeAgent: "evimed-adr-analysis",
          createdAt: "2026-07-16T00:00:00.000Z",
          updatedAt: "2026-07-16T00:00:00.000Z",
        },
      },
    });
    useRuntimeStore.setState({ currentId: null });
    render(<WorkspaceChip />);
    expect(screen.getByRole("button", { name: "选择项目工作区" })).toHaveTextContent(
      "default",
    );

    await userEvent.click(screen.getByRole("button", { name: "选择项目工作区" }));
    const menu = await screen.findByRole("menu");
    await userEvent.click(within(menu).getByRole("menuitem", { name: /Paper 1/ }));

    await waitFor(() => expect(mocks.projectId).toBe("paper1"));
    await waitFor(() =>
      expect(mocks.clientOpts[mocks.clientOpts.length - 1]).toMatchObject({
        baseUrl: "http://127.0.0.1:8787/api/runtime/paper1",
      }),
    );
    expect(mocks.clientOpts[mocks.clientOpts.length - 1].directory).toBeUndefined();
    expect(useRuntimeStore.getState().threads).toEqual({});
    expect(useRuntimeStore.getState().researchSessionBindings).toEqual({});
  });

  it("creates a hosted project before switching to it", async () => {
    render(<WorkspaceChip />);

    await userEvent.click(screen.getByRole("button", { name: "选择项目工作区" }));
    const menu = await screen.findByRole("menu");
    await userEvent.type(within(menu).getByRole("textbox", { name: "新项目 id" }), "review_2026");
    await userEvent.click(within(menu).getByRole("button", { name: "创建项目" }));

    await waitFor(() =>
      expect(mocks.createdProjects).toContainEqual({ id: "review_2026", name: "review_2026" }),
    );
    await waitFor(() => expect(mocks.projectId).toBe("review_2026"));
    await waitFor(() =>
      expect(mocks.clientOpts[mocks.clientOpts.length - 1]).toMatchObject({
        baseUrl: "http://127.0.0.1:8787/api/runtime/review_2026",
      }),
    );
    expect(mocks.clientOpts[mocks.clientOpts.length - 1].directory).toBeUndefined();
  });
});
