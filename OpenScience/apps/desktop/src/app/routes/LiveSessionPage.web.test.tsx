import { render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LiveSessionPage } from "./LiveSessionPage";

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(async () => {}),
  connect: vi.fn(async () => {}),
  startDraft: vi.fn(),
  startSpecialistDraft: vi.fn(async () => {}),
  sendPrompt: vi.fn(async () => null),
  openSession: vi.fn(async () => {}),
  status: "offline" as "offline" | "ready",
  draftResearchAgent: null as null | Record<string, unknown>,
  specialtySelectionPending: false,
  serverUrl: "http://127.0.0.1:4096",
}));

vi.mock("@/lib/apiClient", () => ({
  hasWebApi: true,
}));

vi.mock("@/lib/tauri", () => ({
  isTauri: false,
}));

vi.mock("@/lib/runtime", () => ({
  DRAFT_KEY: "draft",
  rootSessionOf: (_parents: Record<string, string>, sessionId: string) => sessionId,
  subagentActivity: () => null,
  useRuntimeStore: () => ({
    status: mocks.status,
    switching: false,
    sending: false,
    runningSessions: {},
    // A loopback address, deliberately. The only element that can render a
    // server URL is the local-runtime block, so a fixture serving a relative
    // path made the "no loopback address on a hosted page" assertion below
    // unfailable: the string it looks for could not appear even if the hosted
    // branch rendered that block. Mutation-checked — flipping the hosted
    // condition now turns that assertion red.
    serverUrl: mocks.serverUrl,
    sessions: [],
    researchAgents: mocks.draftResearchAgent ? [mocks.draftResearchAgent] : [],
    researchSessionBindings: {},
    draftResearchAgent: mocks.draftResearchAgent,
    specialtySelectionPending: mocks.specialtySelectionPending,
    currentId: null,
    threads: {},
    error: null,
    questions: [],
    permissions: [],
    sessionParents: {},
    workspace: null,
    panes: {},
    commands: [],
    connect: mocks.connect,
    bootstrap: mocks.bootstrap,
    openSession: mocks.openSession,
    startDraft: mocks.startDraft,
    startSpecialistDraft: mocks.startSpecialistDraft,
    sendPrompt: mocks.sendPrompt,
    runShell: vi.fn(async () => null),
    runCommand: vi.fn(async () => null),
    openArtifact: vi.fn(),
    closeArtifact: vi.fn(),
    setShowFiles: vi.fn(),
    answerQuestion: vi.fn(),
    rejectQuestion: vi.fn(),
    replyPermission: vi.fn(),
    interrupt: vi.fn(),
    reconcileRunning: vi.fn(),
    approvalMode: "approve",
    setApprovalMode: vi.fn(),
  }),
}));

vi.mock("@/lib/store", () => ({
  useUiStore: () => ({
    sidebarCollapsed: false,
    setSidebarCollapsed: vi.fn(),
  }),
}));

vi.mock("@/lib/scrollMemory", () => ({
  useScrollMemory: () => () => {},
}));

vi.mock("@/components/thread/Composer", () => ({
  Composer: ({ placeholder, disabled }: { placeholder: string; disabled: boolean }) => (
    <div data-testid="composer" data-disabled={String(disabled)}>{placeholder}</div>
  ),
}));

vi.mock("@/components/thread/BlockList", () => ({
  BlockList: () => <div data-testid="blocks" />,
}));

vi.mock("@/components/thread/WorkflowStarters", () => ({
  WorkflowStarters: () => <div data-testid="starters" />,
}));

vi.mock("@/components/thread/InteractionPrompt", () => ({
  InteractionPrompt: () => <div data-testid="interaction" />,
}));

vi.mock("@/components/inspector/InspectorShell", () => ({
  InspectorShell: () => <div data-testid="inspector" />,
}));

vi.mock("@/components/inspector/RightPane", () => ({
  MaximizePaneButton: () => <button type="button">Maximize</button>,
  RightPane: ({ children }: { children: ReactNode }) => <aside>{children}</aside>,
}));

vi.mock("./FilesPage", () => ({
  SessionFilesPane: () => <div data-testid="files" />,
}));

describe("LiveSessionPage hosted web mode", () => {
  beforeEach(() => {
    mocks.bootstrap.mockClear();
    mocks.connect.mockClear();
    mocks.startDraft.mockClear();
    mocks.startSpecialistDraft.mockClear();
    mocks.sendPrompt.mockClear();
    mocks.openSession.mockClear();
    mocks.status = "offline";
    mocks.draftResearchAgent = null;
    mocks.specialtySelectionPending = false;
  });

  it("loads a direct session after the hosted runtime becomes ready", () => {
    const view = render(
      <MemoryRouter initialEntries={["/live/ses_existing"]}>
        <Routes>
          <Route path="/live/:sessionId" element={<LiveSessionPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(mocks.openSession).not.toHaveBeenCalled();

    mocks.status = "ready";
    view.rerender(
      <MemoryRouter initialEntries={["/live/ses_existing"]}>
        <Routes>
          <Route path="/live/:sessionId" element={<LiveSessionPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(mocks.openSession).toHaveBeenCalledWith("ses_existing");
  });

  it("starts the server-managed runtime instead of pointing the reader at a local one", async () => {
    render(
      <MemoryRouter initialEntries={["/live"]}>
        <Routes>
          <Route path="/live" element={<LiveSessionPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(mocks.startDraft).toHaveBeenCalled();
    // A hosted page must never hand the reader a runtime to start themselves.
    // This used to be spelled as the absence of the retired kernel's `serve`
    // command; a loopback address is the part that actually made it local, and
    // it survives the kernel that is gone.
    expect(screen.queryByText(/127\.0\.0\.1|localhost/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "启动科研服务" })).toHaveLength(2);

    await userEvent.click(screen.getAllByRole("button", { name: "启动科研服务" })[1]);

    expect(mocks.bootstrap).toHaveBeenCalledTimes(1);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(screen.getByTestId("composer")).toHaveTextContent("科研服务连接后即可开始");
  });

  it("selects a specialty draft from the query string instead of resetting to open-domain", () => {
    render(
      <MemoryRouter initialEntries={["/live?agent=adr-analysis"]}>
        <Routes>
          <Route path="/live" element={<LiveSessionPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(mocks.startSpecialistDraft).toHaveBeenCalledWith("adr-analysis");
    expect(mocks.startDraft).not.toHaveBeenCalled();
  });

  it("shows specialty identity and starter prompts on the shared conversation page", async () => {
    mocks.draftResearchAgent = {
      id: "adr-analysis",
      version: "1.0.0",
      title: "Drug Safety Analysis",
      category: "Pharmacovigilance",
      description: "Mine adverse-event signals and synthesize safety evidence.",
      skill: "adr-analysis",
      estimatedMinutes: [20, 40],
      starterPrompts: ["Analyze cardiac safety signals associated with osimertinib."],
      requiredInputs: ["drug"],
      optionalInputs: ["adverseEvent", "uploadedFiles"],
      requiredTools: [],
      optionalTools: [],
      dataSources: [],
      outputs: [],
      completionChecks: [],
      runtimeAgent: "evimed-adr-analysis",
    };
    render(
      <MemoryRouter initialEntries={["/live?agent=adr-analysis"]}>
        <Routes>
          <Route path="/live" element={<LiveSessionPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("药品安全性分析")).toBeInTheDocument();
    expect(screen.getByText(/不良事件信号挖掘/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /分析奥希替尼相关的心脏安全性信号/ }));
    expect(mocks.sendPrompt).toHaveBeenCalledWith("分析奥希替尼相关的心脏安全性信号，并形成可追溯的证据报告。");
  });

  it("shows a back-to-bottom button once the user scrolls up, and hides it after returning", async () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/live"]}>
        <Routes>
          <Route path="/live" element={<LiveSessionPage />} />
        </Routes>
      </MemoryRouter>,
    );
    // jsdom reports zero layout metrics — give the chat scroller fake ones.
    const scroller = container.querySelector(".min-h-0.flex-1.overflow-y-auto")!;
    let top = 0;
    Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(scroller, "scrollTop", {
      get: () => top,
      set: (v: number) => {
        top = v;
      },
      configurable: true,
    });

    // At the bottom there is no button; scrolling up floats one.
    expect(screen.queryByRole("button", { name: "回到底部" })).not.toBeInTheDocument();
    fireEvent.scroll(scroller);
    const back = await screen.findByRole("button", { name: "回到底部" });
    await userEvent.click(back);
    expect(top).toBe(1000);
    expect(screen.queryByRole("button", { name: "回到底部" })).not.toBeInTheDocument();
  });

  it("locks the composer while the specialty route is resolving", () => {
    mocks.specialtySelectionPending = true;
    render(
      <MemoryRouter initialEntries={["/live?agent=adr-analysis"]}>
        <Routes>
          <Route path="/live" element={<LiveSessionPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId("composer")).toHaveTextContent("正在加载科研工作流");
    expect(screen.getByTestId("composer")).toHaveAttribute("data-disabled", "true");
  });
});
