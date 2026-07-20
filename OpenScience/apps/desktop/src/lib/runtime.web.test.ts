import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clientOpts: [] as Record<string, unknown>[],
  statusCb: (_status: string) => {},
  eventCb: (_event: unknown) => {},
  sendPrompt: vi.fn(async (_sessionId: string, _text: string, _agent?: string, _model?: string | null) => {}),
  createSession: vi.fn(async () => "ses_new"),
  getMessages: vi.fn(async (_sessionId: string): Promise<unknown[]> => []),
  listWebResearchAgents: vi.fn(),
  listWebResearchSessions: vi.fn(),
  putWebResearchSession: vi.fn(),
  listWebAgentRuns: vi.fn(),
  dispatchWebAgentRun: vi.fn(),
  fetchWebMe: vi.fn(),
  startRuntime: vi.fn(async () => "http://web.test/api/opencode/default"),
  projectId: "default",
}));

vi.mock("./apiClient", () => ({
  hasCommandBackend: true,
  hasWebApi: true,
  fetchWithWebAuth: vi.fn(globalThis.fetch),
  listWebResearchAgents: mocks.listWebResearchAgents,
  listWebResearchSessions: mocks.listWebResearchSessions,
  putWebResearchSession: mocks.putWebResearchSession,
  listWebAgentRuns: mocks.listWebAgentRuns,
  dispatchWebAgentRun: mocks.dispatchWebAgentRun,
  fetchWebMe: mocks.fetchWebMe,
  getWebProjectId: () => mocks.projectId,
  setWebProjectId: (projectId: string) => {
    mocks.projectId = projectId;
  },
}));

vi.mock("./tauri", () => ({
  isTauri: false,
  logDebug: async () => {},
  detectTools: async () => [],
  startRuntime: mocks.startRuntime,
  workspacePath: async () => `/workspace/${mocks.projectId}`,
  runtimePassword: async () => null,
  getApprovalMode: async () => "approve",
  setApprovalMode: async () => {},
  newDatedWorkspace: async (name: string) => `/workspace/default/${name}`,
  setWorkspace: async (path: string) => path,
}));

vi.mock("./kernel", () => ({
  kernelReset: async () => {},
}));

vi.mock("@ai4s/sdk", () => {
  class OpenCodeClient {
    constructor(opts: Record<string, unknown>) {
      mocks.clientOpts.push(opts);
    }
    onStatus(cb: (status: string) => void) {
      mocks.statusCb = cb;
      return () => {
        mocks.statusCb = () => {};
      };
    }
    onEvent(cb: (event: unknown) => void) {
      mocks.eventCb = cb;
    }
    async connect() {
      mocks.statusCb("ready");
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
      return "deepseek/deepseek-v4-pro";
    }
    async createSession() {
      return mocks.createSession();
    }
    async sendPrompt(sessionId: string, text: string, agent?: string, model?: string | null) {
      await mocks.sendPrompt(sessionId, text, agent, model);
    }
    async getMessages(sessionId: string) {
      return mocks.getMessages(sessionId);
    }
    async listQuestions() {
      return [];
    }
    async listPermissions() {
      return [];
    }
    close() {
      mocks.statusCb("offline");
    }
  }
  return { OpenCodeClient, DEFAULT_OPENCODE_URL: "http://127.0.0.1:4096" };
});

import { useRuntimeStore } from "./runtime";

const agent = {
  id: "adr-analysis",
  version: "1.0.0",
  title: "Drug Safety Analysis",
  category: "Pharmacovigilance",
  description: "Mine adverse-event signals.",
  skill: "adr-analysis",
  estimatedMinutes: [20, 40] as [number, number],
  starterPrompts: ["Analyze osimertinib."],
  requiredInputs: ["drug"],
  optionalInputs: ["uploadedFiles"],
  requiredTools: ["evimed_adr_signal_analysis"],
  optionalTools: [],
  dataSources: ["faers"],
  outputs: [{ path: "safety-report.md", required: true }],
  completionChecks: ["requiredOutputsExist"],
  runtimeAgent: "evimed-adr-analysis",
};

function specialistBinding(sessionId = "ses_new") {
  return {
    sessionId,
    mode: "specialist" as const,
    agentId: agent.id,
    agentVersion: agent.version,
    runtimeAgent: agent.runtimeAgent,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
  };
}

function runningRun(sessionId = "ses_new", id = "run_1") {
  return {
    id,
    dispatchId: `turn_${id}`,
    dispatchStatus: "accepted" as const,
    sessionId,
    mode: "specialist" as const,
    agentId: agent.id,
    agentVersion: agent.version,
    runtimeAgent: agent.runtimeAgent,
    model: "deepseek/deepseek-v4-pro",
    status: "running" as const,
    createdAt: "2026-07-16T00:00:00.000Z",
    startedAt: "2026-07-16T00:00:00.000Z",
    finishedAt: null,
    durationMs: null,
    errorCode: null,
    artifacts: [] as string[],
  };
}

beforeEach(() => {
  mocks.projectId = "default";
  mocks.clientOpts.length = 0;
  mocks.sendPrompt.mockClear();
  mocks.createSession.mockClear();
  mocks.getMessages.mockReset();
  mocks.getMessages.mockResolvedValue([]);
  mocks.listWebResearchAgents.mockReset();
  mocks.listWebResearchAgents.mockResolvedValue([agent]);
  mocks.listWebResearchSessions.mockReset();
  mocks.listWebResearchSessions.mockResolvedValue([]);
  mocks.putWebResearchSession.mockReset();
  mocks.putWebResearchSession.mockImplementation(async (sessionId: string, selection: { mode: string }) => (
    selection.mode === "specialist"
      ? specialistBinding(sessionId)
      : {
          sessionId,
          mode: "open-domain",
          agentId: null,
          agentVersion: null,
          runtimeAgent: null,
          createdAt: "2026-07-16T00:00:00.000Z",
          updatedAt: "2026-07-16T00:00:00.000Z",
        }
  ));
  mocks.listWebAgentRuns.mockReset();
  mocks.listWebAgentRuns.mockResolvedValue([]);
  mocks.dispatchWebAgentRun.mockReset();
  let runSequence = 0;
  mocks.dispatchWebAgentRun.mockImplementation(async (sessionId: string) => runningRun(sessionId, `run_${++runSequence}`));
  mocks.fetchWebMe.mockReset();
  mocks.fetchWebMe.mockImplementation(async () => ({ project: { id: mocks.projectId, name: mocks.projectId } }));
  mocks.startRuntime.mockReset();
  mocks.startRuntime.mockImplementation(async () => `http://web.test/api/opencode/${mocks.projectId}`);
  useRuntimeStore.setState({
    status: "offline",
    serverUrl: "http://127.0.0.1:4096",
    error: null,
    currentId: null,
    threads: {},
    workspacePinned: false,
    switching: false,
    sending: false,
    runningSessions: {},
    sessions: [],
    skills: [],
    agents: [],
    commands: [],
    researchAgents: [],
    researchSessionBindings: {},
    draftResearchAgent: null,
    specialtySelectionPending: false,
  });
});

describe("hosted web runtime bootstrap", () => {
  it("atomically dispatches a hosted prompt through the trusted run endpoint", async () => {
    await useRuntimeStore.getState().bootstrap();
    const result = await useRuntimeStore.getState().sendPrompt("one trusted turn");

    expect(result).toBe("ses_new");
    expect(mocks.dispatchWebAgentRun).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchWebAgentRun).toHaveBeenCalledWith(
      "ses_new",
      "one trusted turn",
      expect.stringMatching(/^turn_/),
    );
    expect(mocks.sendPrompt).not.toHaveBeenCalled();
  });

  it("explicitly starts the replacement runtime after creating a hosted session workspace", async () => {
    await useRuntimeStore.getState().bootstrap();
    mocks.startRuntime.mockClear();

    await useRuntimeStore.getState().sendPrompt("start in a fresh workspace");

    expect(mocks.startRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchWebAgentRun).toHaveBeenCalledTimes(1);
  });

  it("surfaces hosted runtime bootstrap failure without creating or dispatching a session", async () => {
    await useRuntimeStore.getState().bootstrap();
    mocks.startRuntime.mockRejectedValueOnce(new Error("科研模型服务尚未配置（runtime_model_provider_unavailable）"));

    const result = await useRuntimeStore.getState().sendPrompt("must fail visibly");

    expect(result).toBeNull();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.dispatchWebAgentRun).not.toHaveBeenCalled();
    expect(useRuntimeStore.getState().sending).toBe(false);
    expect(useRuntimeStore.getState().threads.draft.blocks).toContainEqual(expect.objectContaining({
      kind: "status-line",
      tone: "error",
      text: expect.stringContaining("runtime_model_provider_unavailable"),
    }));
  });

  it("recovers an accepted hosted dispatch when the browser loses its response without resending", async () => {
    await useRuntimeStore.getState().bootstrap();
    mocks.dispatchWebAgentRun.mockRejectedValueOnce(new Error("response lost"));
    mocks.listWebAgentRuns.mockResolvedValue([runningRun("ses_new", "run_accepted")]);

    const result = await useRuntimeStore.getState().sendPrompt("accepted exactly once");

    expect(result).toBe("ses_new");
    expect(mocks.dispatchWebAgentRun).toHaveBeenCalledTimes(1);
    expect(mocks.sendPrompt).not.toHaveBeenCalled();
    expect(useRuntimeStore.getState().activeAgentRuns).toEqual({ ses_new: "run_accepted" });
    expect(useRuntimeStore.getState().runningSessions.ses_new).toBe(true);
  });

  it("starts the hosted runtime through the command backend and connects to the proxy URL", async () => {
    await useRuntimeStore.getState().bootstrap();

    expect(useRuntimeStore.getState().status).toBe("ready");
    expect(useRuntimeStore.getState().serverUrl).toBe("http://web.test/api/opencode/default");
    expect(mocks.clientOpts[mocks.clientOpts.length - 1]).toMatchObject({
      baseUrl: "http://web.test/api/opencode/default",
    });
    expect(useRuntimeStore.getState().workspace).toBe("/workspace/default");
    expect(mocks.clientOpts[mocks.clientOpts.length - 1].directory).toBeUndefined();
    expect(mocks.clientOpts[mocks.clientOpts.length - 1].password).toBeUndefined();
  });

  it("persists a specialist binding before the first prompt and pins every turn", async () => {
    await useRuntimeStore.getState().bootstrap();
    await useRuntimeStore.getState().startSpecialistDraft("adr-analysis");

    await useRuntimeStore.getState().sendPrompt("first question");
    mocks.eventCb({ type: "session.idle", sessionId: "ses_new" });
    await useRuntimeStore.getState().sendPrompt("follow up");

    expect(mocks.putWebResearchSession).toHaveBeenCalledTimes(1);
    expect(mocks.putWebResearchSession).toHaveBeenCalledWith("ses_new", {
      mode: "specialist",
      agentId: "adr-analysis",
      agentVersion: "1.0.0",
    });
    expect(mocks.putWebResearchSession.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.dispatchWebAgentRun.mock.invocationCallOrder[0],
    );
    expect(mocks.dispatchWebAgentRun).toHaveBeenNthCalledWith(
      1,
      "ses_new",
      "first question",
      expect.stringMatching(/^turn_/),
    );
    expect(mocks.dispatchWebAgentRun).toHaveBeenNthCalledWith(
      2,
      "ses_new",
      "follow up",
      expect.stringMatching(/^turn_/),
    );
    expect(mocks.sendPrompt).not.toHaveBeenCalled();
  });

  it("refreshes server-owned failed and canceled runs without resending the model turn", async () => {
    await useRuntimeStore.getState().bootstrap();
    useRuntimeStore.getState().startDraft();

    await useRuntimeStore.getState().sendPrompt("will fail");
    mocks.eventCb({ type: "error", sessionId: "ses_new", message: "provider unavailable" });
    await vi.waitFor(() => expect(mocks.listWebAgentRuns).toHaveBeenCalled());

    await useRuntimeStore.getState().sendPrompt("will stop");
    await useRuntimeStore.getState().interrupt();
    expect(mocks.dispatchWebAgentRun).toHaveBeenCalledTimes(2);
    expect(mocks.sendPrompt).not.toHaveBeenCalled();
  });

  it("never submits folded artifact paths or terminal state from the browser", async () => {
    await useRuntimeStore.getState().bootstrap();
    await useRuntimeStore.getState().sendPrompt("write the report");
    mocks.eventCb({
      type: "tool.updated",
      sessionId: "ses_new",
      callId: "call_write",
      tool: "write",
      status: "success",
      title: "Write report",
      input: { filePath: "reports/summary.md", content: "done" },
      output: "Wrote reports/summary.md",
    });
    mocks.eventCb({ type: "session.idle", sessionId: "ses_new" });

    await vi.waitFor(() => expect(mocks.listWebAgentRuns).toHaveBeenCalled());
  });

  it("recovers a running hosted run after reload and terminally reconciles completed history", async () => {
    mocks.listWebAgentRuns
      .mockResolvedValueOnce([runningRun("ses_saved", "run_saved")])
      .mockResolvedValue([]);
    mocks.getMessages.mockResolvedValue([
      { role: "user", parts: [{ type: "text", text: "question" }] },
      {
        role: "assistant",
        completed: 1783301200079,
        parts: [
          {
            type: "tool",
            tool: "write",
            state: {
              status: "completed",
              title: "Write recovered report",
              input: { filePath: "reports/recovered.md", content: "done" },
              output: "Wrote reports/recovered.md",
            },
          },
          { type: "text", text: "done" },
        ],
      },
    ]);

    await useRuntimeStore.getState().bootstrap();

    await vi.waitFor(() => expect(mocks.listWebAgentRuns.mock.calls.length).toBeGreaterThan(1));
    expect(useRuntimeStore.getState().activeAgentRuns).toEqual({});
  });

  it("clears hosted active run recovery state on project reset", async () => {
    mocks.listWebAgentRuns.mockResolvedValue([runningRun("ses_saved", "run_saved")]);
    mocks.getMessages.mockResolvedValue([
      { role: "assistant", parts: [{ type: "text", text: "working" }] },
    ]);
    await useRuntimeStore.getState().bootstrap();
    await vi.waitFor(() => expect(useRuntimeStore.getState().activeAgentRuns).toEqual({ ses_saved: "run_saved" }));

    useRuntimeStore.getState().resetProjectState();

    expect(useRuntimeStore.getState().activeAgentRuns).toEqual({});
  });

  it("keeps plain drafts open-domain and unpinned", async () => {
    await useRuntimeStore.getState().bootstrap();
    useRuntimeStore.getState().startDraft();

    await useRuntimeStore.getState().sendPrompt("explore this topic");

    expect(mocks.putWebResearchSession).toHaveBeenCalledWith("ses_new", { mode: "open-domain" });
    expect(mocks.dispatchWebAgentRun).toHaveBeenCalledWith(
      "ses_new",
      "explore this topic",
      expect.stringMatching(/^turn_/),
    );
  });

  it("restores a persisted specialist binding before reopening a session", async () => {
    mocks.listWebResearchSessions.mockResolvedValue([specialistBinding("ses_saved")]);
    await useRuntimeStore.getState().bootstrap();
    useRuntimeStore.setState({ sessions: [{ id: "ses_saved", title: "Saved ADR analysis" }] as never[] });

    await useRuntimeStore.getState().openSession("ses_saved");
    await useRuntimeStore.getState().sendPrompt("recalculate with a narrower date range");

    expect(useRuntimeStore.getState().researchSessionBindings.ses_saved).toMatchObject({
      mode: "specialist",
      agentId: "adr-analysis",
      runtimeAgent: "evimed-adr-analysis",
    });
    expect(mocks.dispatchWebAgentRun).toHaveBeenCalledWith(
      "ses_saved",
      "recalculate with a narrower date range",
      expect.stringMatching(/^turn_/),
    );
  });

  it("resets synchronously and ignores a stale specialty lookup after the route returns to open-domain", async () => {
    let resolveCatalog!: (value: (typeof agent)[]) => void;
    mocks.listWebResearchAgents.mockReturnValue(new Promise((resolve) => {
      resolveCatalog = resolve;
    }));
    useRuntimeStore.setState({
      currentId: "ses_previous",
      draftResearchAgent: agent,
      threads: {
        ses_previous: { blocks: [{ kind: "user", text: "private" }], index: {}, loaded: true },
        draft: { blocks: [{ kind: "user", text: "stale draft" }], index: {}, loaded: true },
      },
    });

    const pending = useRuntimeStore.getState().startSpecialistDraft("adr-analysis");
    expect(useRuntimeStore.getState().currentId).toBeNull();
    expect(useRuntimeStore.getState().draftResearchAgent).toBeNull();
    expect(useRuntimeStore.getState().threads.draft).toBeUndefined();

    useRuntimeStore.getState().startDraft();
    resolveCatalog([agent]);
    await pending;

    expect(useRuntimeStore.getState().currentId).toBeNull();
    expect(useRuntimeStore.getState().draftResearchAgent).toBeNull();
  });

  it("awaits a deferred specialty selection before an immediate programmatic first send", async () => {
    await useRuntimeStore.getState().bootstrap();
    let resolveCatalog!: (value: (typeof agent)[]) => void;
    mocks.listWebResearchAgents.mockReturnValue(new Promise((resolve) => {
      resolveCatalog = resolve;
    }));

    const selecting = useRuntimeStore.getState().startSpecialistDraft("adr-analysis");
    const sending = useRuntimeStore.getState().sendPrompt("send without waiting for the route effect");
    expect(useRuntimeStore.getState().specialtySelectionPending).toBe(true);
    expect(mocks.putWebResearchSession).not.toHaveBeenCalled();

    resolveCatalog([agent]);
    await Promise.all([selecting, sending]);

    expect(mocks.putWebResearchSession).toHaveBeenCalledWith("ses_new", {
      mode: "specialist",
      agentId: "adr-analysis",
      agentVersion: "1.0.0",
    });
    expect(mocks.dispatchWebAgentRun).toHaveBeenLastCalledWith(
      "ses_new",
      "send without waiting for the route effect",
      expect.stringMatching(/^turn_/),
    );
    expect(useRuntimeStore.getState().specialtySelectionPending).toBe(false);
  });

  it("discards a deferred specialty result when another session becomes active", async () => {
    let resolveCatalog!: (value: (typeof agent)[]) => void;
    mocks.listWebResearchAgents.mockReturnValue(new Promise((resolve) => {
      resolveCatalog = resolve;
    }));

    const selecting = useRuntimeStore.getState().startSpecialistDraft("adr-analysis");
    useRuntimeStore.setState({ currentId: "ses_replaced" });
    resolveCatalog([agent]);
    await selecting;

    expect(useRuntimeStore.getState().currentId).toBe("ses_replaced");
    expect(useRuntimeStore.getState().draftResearchAgent).toBeNull();
    expect(useRuntimeStore.getState().specialtySelectionPending).toBe(false);
  });

  it("cancels an immediate first send before echo or side effects when navigation opens another session", async () => {
    await useRuntimeStore.getState().bootstrap();
    let resolveCatalog!: (value: (typeof agent)[]) => void;
    mocks.listWebResearchAgents.mockReturnValue(new Promise((resolve) => {
      resolveCatalog = resolve;
    }));
    useRuntimeStore.setState({ sessions: [{ id: "ses_replacement", title: "Replacement" }] as never[] });

    const selecting = useRuntimeStore.getState().startSpecialistDraft("adr-analysis");
    const sending = useRuntimeStore.getState().sendPrompt("must never reach the replacement session");
    const opening = useRuntimeStore.getState().openSession("ses_replacement");

    await expect(sending).resolves.toBeNull();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.putWebResearchSession).not.toHaveBeenCalled();
    expect(mocks.dispatchWebAgentRun).not.toHaveBeenCalled();
    expect(mocks.sendPrompt).not.toHaveBeenCalled();
    expect(useRuntimeStore.getState().threads.draft).toBeUndefined();
    expect(useRuntimeStore.getState().threads.ses_replacement?.blocks ?? []).toEqual([]);

    resolveCatalog([agent]);
    await Promise.all([selecting, opening]);
    expect(useRuntimeStore.getState().currentId).toBe("ses_replacement");
    expect(useRuntimeStore.getState().threads.ses_replacement.blocks).toEqual([]);
  });

  it("leaves an unknown specialty selection as a blank unpinned draft", async () => {
    useRuntimeStore.setState({ currentId: "ses_previous", draftResearchAgent: agent });
    mocks.listWebResearchAgents.mockResolvedValue([]);

    await useRuntimeStore.getState().startSpecialistDraft("retired-agent");

    expect(useRuntimeStore.getState().currentId).toBeNull();
    expect(useRuntimeStore.getState().draftResearchAgent).toBeNull();
    expect(useRuntimeStore.getState().error).toContain("retired-agent");
  });

  it("switches projects without leaking an identical session id binding, thread, or agent pin", async () => {
    await useRuntimeStore.getState().bootstrap();
    useRuntimeStore.setState({
      currentId: "ses_shared",
      sessions: [{ id: "ses_shared", title: "Default project ADR" }] as never[],
      threads: {
        ses_shared: { blocks: [{ kind: "user", text: "default private thread" }], index: {}, loaded: true },
      },
      researchAgents: [agent],
      researchSessionBindings: { ses_shared: specialistBinding("ses_shared") },
    });
    mocks.listWebResearchSessions.mockImplementation(async () => (
      mocks.projectId === "paper1"
        ? [{
            sessionId: "ses_shared",
            mode: "open-domain" as const,
            agentId: null,
            agentVersion: null,
            runtimeAgent: null,
            createdAt: "2026-07-16T00:00:00.000Z",
            updatedAt: "2026-07-16T00:00:00.000Z",
          }]
        : [specialistBinding("ses_shared")]
    ));

    await useRuntimeStore.getState().switchHostedProject("paper1");

    expect(mocks.projectId).toBe("paper1");
    expect(useRuntimeStore.getState().currentId).toBeNull();
    expect(useRuntimeStore.getState().threads).toEqual({});
    expect(useRuntimeStore.getState().researchSessionBindings).toEqual({});
    expect(useRuntimeStore.getState().researchAgents).toEqual([]);

    useRuntimeStore.setState({ sessions: [{ id: "ses_shared", title: "Paper 1 open research" }] as never[] });
    await useRuntimeStore.getState().openSession("ses_shared");
    await useRuntimeStore.getState().sendPrompt("continue here");
    expect(useRuntimeStore.getState().researchSessionBindings.ses_shared.runtimeAgent).toBeNull();
    expect(mocks.dispatchWebAgentRun).toHaveBeenLastCalledWith(
      "ses_shared",
      "continue here",
      expect.stringMatching(/^turn_/),
    );
  });

  it("restores and reboots the previous project when a switch fails", async () => {
    await useRuntimeStore.getState().bootstrap();
    mocks.fetchWebMe.mockImplementation(async () => {
      if (mocks.projectId === "paper1") throw new Error("project unavailable");
      return { project: { id: mocks.projectId, name: mocks.projectId } };
    });
    useRuntimeStore.setState({ currentId: "ses_private", threads: { ses_private: { blocks: [], index: {}, loaded: true } } });

    await expect(useRuntimeStore.getState().switchHostedProject("paper1")).rejects.toThrow("project unavailable");

    expect(mocks.projectId).toBe("default");
    expect(useRuntimeStore.getState().currentId).toBeNull();
    expect(useRuntimeStore.getState().threads).toEqual({});
    expect(mocks.clientOpts[mocks.clientOpts.length - 1]).toMatchObject({
      baseUrl: "http://web.test/api/opencode/default",
    });
  });
});
