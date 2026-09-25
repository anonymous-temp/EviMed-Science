import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWebProjectId, WebApiError, type WebAgentRun } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { PROJECT_EXPLAINER } from "@/lib/projectNames";
import { RUNS_CHANGED_EVENT } from "@/lib/runPresentation";
import { provideFrameSessionSearch } from "@/lib/runtimeUiBridge";
import { ProjectBrowser } from "./ProjectBrowser";

const PROJECTS = [
  { id: "default", name: "我的研究" },
  { id: "paper1", name: "Paper 1" },
  { id: "p-heart", name: "心衰" },
];

const mocks = vi.hoisted(() => ({
  runs: {} as Record<string, WebAgentRun[]>,
  projects: [] as Array<{ id: string; name: string }>,
  listWebProjects: vi.fn(),
  listWebAgentRuns: vi.fn(),
  fetchWebMe: vi.fn(),
  createWebProject: vi.fn(),
  renameWebProject: vi.fn(),
  warmWebRuntime: vi.fn(),
  listGeoProjects: vi.fn(),
}));

// The real store drives the component; only the network is replaced, and the
// tab's project stays the real session-storage binding, so a switch moves the
// same header every request reads.
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  hasWebApi: true,
  listWebProjects: mocks.listWebProjects,
  listWebAgentRuns: mocks.listWebAgentRuns,
  fetchWebMe: mocks.fetchWebMe,
  createWebProject: mocks.createWebProject,
  renameWebProject: mocks.renameWebProject,
}));

vi.mock("@/lib/runtimeWarm", () => ({ warmWebRuntime: mocks.warmWebRuntime }));

vi.mock("@/lib/geoClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/geoClient")>()),
  listGeoProjects: mocks.listGeoProjects,
}));

function run(overrides: Partial<WebAgentRun> & { id: string }): WebAgentRun {
  return {
    dispatchId: null,
    question: null,
    dispatchStatus: "accepted",
    sessionId: `ses-${overrides.id}`,
    mode: "specialist",
    agentId: null,
    agentVersion: null,
    runtimeAgent: null,
    model: "deepseek",
    status: "succeeded",
    createdAt: "2026-09-04T00:00:00.000Z",
    startedAt: "2026-09-04T00:00:00.000Z",
    finishedAt: "2026-09-04T00:01:00.000Z",
    durationMs: 60_000,
    errorCode: null,
    artifacts: [],
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {location.pathname}{location.search}
      <span data-testid="intent">{JSON.stringify(location.state?.runtimeUiIntent ?? null)}</span>
    </div>
  );
}

function renderBrowser(initialPath = "/app/chat") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="*" element={<><ProjectBrowser /><LocationProbe /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The ledger reads, by the project each one named. */
function readProjects(): Array<string | undefined> {
  return mocks.listWebAgentRuns.mock.calls.map(([options]) => (options as { projectId?: string } | undefined)?.projectId);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  useProjectStore.getState().clear();
  mocks.projects = [...PROJECTS];
  mocks.runs = {};
  mocks.listWebProjects.mockImplementation(async () => mocks.projects);
  mocks.listWebAgentRuns.mockImplementation(async ({ projectId }: { projectId?: string } = {}) => mocks.runs[projectId ?? "default"] ?? []);
  mocks.fetchWebMe.mockImplementation(async ({ projectId }: { projectId?: string } = {}) => {
    const id = projectId ?? getWebProjectId();
    return { user: { id: "alice", name: "Alice" }, project: { id, name: id }, projects: mocks.projects };
  });
  mocks.renameWebProject.mockImplementation(async (id: string, name: string) => ({ id, name }));
});

afterEach(() => {
  useProjectStore.getState().clear();
});

describe("ProjectBrowser — the projects and their tasks", () => {
  it("lists every project as a group; only the current one is open, and only its tasks are read", async () => {
    mocks.runs.default = [run({ id: "run-1", question: "阿司匹林一级预防的证据" })];
    mocks.runs.paper1 = [run({ id: "p1-a", question: "论文一的任务" })];
    renderBrowser();

    const current = await screen.findByRole("button", { name: /^我的研究\s*（当前项目）$/ });
    expect(current).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Paper 1" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "心衰" })).toHaveAttribute("aria-expanded", "false");
    expect(await screen.findByRole("link", { name: /阿司匹林一级预防的证据/ })).toHaveAttribute("href", "/app/chat/ses-run-1");
    expect(screen.queryByText("论文一的任务")).not.toBeInTheDocument();
    // Never every project's ledger on load: the other two were not asked.
    expect(readProjects()).toEqual(["default"]);
  });

  // The section is named and not explained (2026-09-23 plan §4: the
  // interface does not describe how the system works).
  it("names the section without a sentence about what a project is", async () => {
    renderBrowser();
    const section = await screen.findByRole("region", { name: "项目" });
    expect(section).not.toHaveAccessibleDescription(PROJECT_EXPLAINER);
    expect(within(section).getByRole("heading", { name: "项目" })).not.toHaveAttribute("title");
  });

  it("opens another project's group and reads its tasks under that project", async () => {
    mocks.runs.paper1 = [run({ id: "p1-a", question: "论文一的任务" })];
    renderBrowser();
    const group = await screen.findByRole("button", { name: "Paper 1" });

    await userEvent.click(group);

    expect(group).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("button", { name: /论文一的任务/ })).toBeInTheDocument();
    expect(mocks.listWebAgentRuns).toHaveBeenCalledWith({ projectId: "paper1" });
    // Nothing moved: opening a group is looking, not switching.
    expect(useProjectStore.getState().currentId).toBe("default");
    expect(getWebProjectId()).toBe("default");
  });

  it("remembers which groups are open across a reload", async () => {
    const first = renderBrowser();
    await userEvent.click(await screen.findByRole("button", { name: "Paper 1" }));
    await userEvent.click(screen.getByRole("button", { name: /^我的研究\s*（当前项目）$/ }));
    expect(JSON.parse(window.localStorage.getItem("ai4s.sidebar.projectGroups") ?? "{}")).toEqual({ default: false, paper1: true });
    first.unmount();
    mocks.listWebAgentRuns.mockClear();

    renderBrowser();

    expect(await screen.findByRole("button", { name: "Paper 1" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^我的研究\s*（当前项目）$/ })).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(readProjects()).toContain("paper1"));
  });

  // The switch used to reload the document (2026-09-19,
  // 「点一个切换的话就得重新刷新一遍」); now it moves the tab and lands.
  it("opens another project's task by switching in place, then landing on its conversation", async () => {
    mocks.runs.paper1 = [run({ id: "p1-a", question: "论文一的任务", sessionId: "ses-p1" })];
    renderBrowser("/app/files");
    await userEvent.click(await screen.findByRole("button", { name: "Paper 1" }));

    await userEvent.click(await screen.findByRole("button", { name: /论文一的任务/ }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/chat/ses-p1"));
    expect(mocks.fetchWebMe).toHaveBeenCalledWith({ projectId: "paper1" });
    expect(useProjectStore.getState().currentId).toBe("paper1");
    expect(getWebProjectId()).toBe("paper1");
    // The task is a link in the current project now, and it is the open one.
    expect(screen.getByRole("link", { name: /论文一的任务/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: /^Paper 1\s*（当前项目）$/ })).toBeInTheDocument();
  });

  it("gives the keyboard focus back to the task it opened in another project", async () => {
    mocks.runs.paper1 = [run({ id: "p1-a", question: "论文一的任务" })];
    renderBrowser("/app/files");
    await userEvent.click(await screen.findByRole("button", { name: "Paper 1" }));
    const row = await screen.findByRole("button", { name: /论文一的任务/ });

    act(() => row.focus());
    await userEvent.keyboard("{Enter}");

    await waitFor(() => expect(screen.getByRole("link", { name: /论文一的任务/ })).toHaveFocus());
  });

  it("starts a new task in another project: the switch first, then an intent minted there", async () => {
    renderBrowser("/app/files");

    await userEvent.click(await screen.findByRole("button", { name: "在「Paper 1」新建对话" }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/app\/chat/));
    expect(useProjectStore.getState().currentId).toBe("paper1");
    const intent = JSON.parse(screen.getByTestId("intent").textContent!);
    expect(intent).toMatchObject({ kind: "create", projectId: "paper1" });
    expect(screen.getByRole("button", { name: /^Paper 1\s*（当前项目）$/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("starts a new task in the current project without asking the server anything", async () => {
    renderBrowser("/app/files");

    await userEvent.click(await screen.findByRole("button", { name: "在「我的研究」新建对话" }));

    expect(screen.getByTestId("location")).toHaveTextContent(/^\/app\/chat/);
    expect(JSON.parse(screen.getByTestId("intent").textContent!)).toMatchObject({ kind: "create", projectId: "default" });
    expect(mocks.fetchWebMe).not.toHaveBeenCalled();
  });

  // A switch that fails has to say so where it was asked for. Moving anyway
  // would leave the tab on a project the account cannot open.
  it("stays where it was when a switch is refused, and says why under that project", async () => {
    mocks.runs.paper1 = [run({ id: "p1-a", question: "论文一的任务" })];
    mocks.fetchWebMe.mockRejectedValue(new WebApiError("project unavailable", { status: 503, code: "runtime_unavailable" }));
    renderBrowser("/app/files");
    await userEvent.click(await screen.findByRole("button", { name: "Paper 1" }));

    await userEvent.click(await screen.findByRole("button", { name: /论文一的任务/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("运行时出现问题，稍后重试。");
    expect(useProjectStore.getState().currentId).toBe("default");
    expect(getWebProjectId()).toBe("default");
    expect(screen.getByTestId("location")).toHaveTextContent("/app/files");
  });

  it("stays where it was when the server resolves a different project", async () => {
    mocks.fetchWebMe.mockImplementation(async () => ({ user: { id: "alice", name: "Alice" }, project: { id: "default", name: "我的研究" }, projects: PROJECTS }));
    renderBrowser("/app/files");

    await userEvent.click(await screen.findByRole("button", { name: "在「Paper 1」新建对话" }));

    // Said in the dictionary's words for a switch, as the dropdown before this did.
    expect(await screen.findByRole("alert")).toHaveTextContent("无法切换到这个项目，请稍后重试。");
    expect(useProjectStore.getState().currentId).toBe("default");
    expect(screen.getByTestId("location")).toHaveTextContent("/app/files");
  });

  // The kernel's own list folds at five and says how many it folded.
  it("shows five tasks, then the rest on request, and folds them again", async () => {
    mocks.runs.default = Array.from({ length: 7 }, (_, index) => run({ id: `r${index}`, question: `任务 ${index}` }));
    renderBrowser();
    await screen.findByRole("link", { name: /任务 0/ });
    expect(screen.getAllByRole("link", { name: /^任务 \d/ })).toHaveLength(5);

    const more = screen.getByRole("button", { name: "展开其余 2 条对话" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(more);
    expect(screen.getAllByRole("link", { name: /^任务 \d/ })).toHaveLength(7);

    await userEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(screen.getAllByRole("link", { name: /^任务 \d/ })).toHaveLength(5);
  });

  it("marks a project whose task is running, in words as well as the dot", async () => {
    mocks.runs.default = [run({ id: "r", question: "进行中的任务", status: "running", finishedAt: null })];
    renderBrowser();
    expect(await screen.findByRole("button", { name: /^我的研究\s*（当前项目，有对话正在运行）$/ })).toBeInTheDocument();
  });

  it("marks the task on screen as the current page", async () => {
    mocks.runs.default = [run({ id: "a", question: "打开着的任务" }), run({ id: "b", question: "另一个任务" })];
    renderBrowser("/app/chat/ses-a");
    expect(await screen.findByRole("link", { name: /打开着的任务/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /另一个任务/ })).not.toHaveAttribute("aria-current");
  });

  // Hovering is the cheapest moment to start a cold runtime: by the click it
  // may already be up. Never for the project the shell is already in, and
  // only as a guess — free room only, nothing stopped for it (2026-09-24).
  it("warms another project's runtime when the pointer or keyboard reaches its group", async () => {
    renderBrowser();
    const other = await screen.findByRole("button", { name: "Paper 1" });

    await userEvent.hover(other);
    expect(mocks.warmWebRuntime).toHaveBeenCalledWith("paper1", { speculative: true });

    mocks.warmWebRuntime.mockClear();
    act(() => screen.getByRole("button", { name: "在「心衰」新建对话" }).focus());
    expect(mocks.warmWebRuntime).toHaveBeenCalledWith("p-heart", { speculative: true });

    mocks.warmWebRuntime.mockClear();
    await userEvent.hover(screen.getByRole("button", { name: /^我的研究\s*（当前项目）$/ }));
    expect(mocks.warmWebRuntime).not.toHaveBeenCalled();
  });

  // Opening a group is the strongest signal short of a click, and a cold
  // runtime takes about five seconds (2026-09-19 measurement; plan §3.11).
  // Keyboard, so the pointer's own warming is not what is being observed.
  it("warms a project's runtime when its group is expanded from the keyboard", async () => {
    renderBrowser();
    const other = await screen.findByRole("button", { name: "Paper 1" });
    act(() => other.focus());
    mocks.warmWebRuntime.mockClear();

    await userEvent.keyboard("{Enter}");
    expect(other).toHaveAttribute("aria-expanded", "true");
    expect(mocks.warmWebRuntime).toHaveBeenCalledWith("paper1", { speculative: true });
  });

  // The everyday two: search and a new project. Export, rename and delete
  // live in 设置 → 项目 (2026-09-23 plan §5.2).
  it("offers search and a new project at the head of the section, and nothing else", async () => {
    renderBrowser();
    expect(await screen.findByRole("button", { name: "搜索对话" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建项目" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "管理项目" })).not.toBeInTheDocument();
  });
});

describe("ProjectBrowser — reading the ledgers", () => {
  // A ledger that cannot be read is not an empty ledger. Reporting it as one
  // would tell someone their work is gone.
  it("says a first read failed, with a retry, and keeps rows a later read cannot refresh", async () => {
    mocks.listWebAgentRuns.mockRejectedValueOnce(new Error("boom"));
    renderBrowser();

    expect(await screen.findByText("这个项目的对话暂时读不到")).toBeInTheDocument();
    expect(screen.queryByText("还没有对话")).not.toBeInTheDocument();

    mocks.runs.default = [run({ id: "run-1", question: "已经读到的运行" })];
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByRole("link", { name: /已经读到的运行/ });

    mocks.listWebAgentRuns.mockRejectedValue(new Error("boom"));
    await act(async () => { window.dispatchEvent(new Event(RUNS_CHANGED_EVENT)); });
    expect(screen.getByRole("link", { name: /已经读到的运行/ })).toBeInTheDocument();
    expect(screen.queryByText("这个项目的对话暂时读不到")).not.toBeInTheDocument();
  });

  it("re-reads every open group when a page announces a change to its runs", async () => {
    renderBrowser();
    await userEvent.click(await screen.findByRole("button", { name: "Paper 1" }));
    await waitFor(() => expect(readProjects()).toEqual(["default", "paper1"]));

    await act(async () => { window.dispatchEvent(new Event(RUNS_CHANGED_EVENT)); });

    expect(readProjects().slice(2).sort()).toEqual(["default", "paper1"]);
  });

  it("says so when a project has no tasks yet", async () => {
    renderBrowser();
    expect(await screen.findByText("还没有对话")).toBeInTheDocument();
  });

  // The list of projects itself failing must not cost the reader the tasks of
  // the project the tab is in.
  it("shows a project-list failure with a retry and keeps the current project's tasks reachable", async () => {
    mocks.listWebProjects.mockRejectedValueOnce(new WebApiError("gateway down", { status: 503, code: "runtime_unavailable" }));
    mocks.runs.default = [run({ id: "run-1", question: "当前项目里的任务" })];
    renderBrowser();

    expect(await screen.findByRole("alert")).toHaveTextContent("运行时出现问题，稍后重试。");
    expect(screen.getByRole("button", { name: "当前项目" })).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("link", { name: /当前项目里的任务/ })).toBeInTheDocument();
    // Its real name is unknown, so it cannot be renamed from here.
    expect(screen.queryByRole("button", { name: /重命名项目/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("button", { name: /^我的研究\s*（当前项目）$/ })).toBeInTheDocument();
  });
});

describe("ProjectBrowser — task rows", () => {
  // A run whose session id is not addressable has no conversation to open, so
  // it is not a row (it used to be a greyed row with a tooltip explaining why).
  it("lists no row for a run with no addressable session", async () => {
    mocks.runs.default = [
      run({ id: "run-1", question: "早期的运行", sessionId: "not a session id" }),
      run({ id: "run-2", question: "可以打开的运行" }),
    ];
    renderBrowser();
    expect(await screen.findByRole("link", { name: /可以打开的运行/ })).toBeInTheDocument();
    expect(screen.queryByText("早期的运行")).toBeNull();
  });

  // The controls the run ledger page held for one conversation, on its row.
  it("offers stop and rename on a running conversation's row, and the identifiers to operators only", async () => {
    mocks.runs.default = [run({ id: "run-1", question: "进行中的研究", status: "running", finishedAt: null })];
    const view = renderBrowser();
    await userEvent.click(await screen.findByRole("button", { name: "「进行中的研究」的操作" }));
    expect(await screen.findByRole("menuitem", { name: "停止" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "重命名" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "复制诊断信息" })).toBeNull();
    view.unmount();

    const researcher = mocks.fetchWebMe.getMockImplementation();
    mocks.fetchWebMe.mockImplementation(async (options: { projectId?: string } = {}) => ({ ...(await researcher?.(options)), operator: true }));
    renderBrowser();
    await userEvent.click(await screen.findByRole("button", { name: "「进行中的研究」的操作" }));
    expect(await screen.findByRole("menuitem", { name: "复制诊断信息" })).toBeInTheDocument();
  });

  // The ledger records a run per turn; the list shows a conversation once
  // (production, 2026-09-24: a question and its follow-up were two rows).
  it("lists a conversation with a follow-up as one row, named by its first question", async () => {
    mocks.runs.default = [
      run({ id: "turn-2", sessionId: "ses-shared", question: "那 65–69 岁呢？", startedAt: "2026-09-24T02:50:00Z", finishedAt: "2026-09-24T02:50:40Z", createdAt: "2026-09-24T02:50:00Z" }),
      run({ id: "turn-1", sessionId: "ses-shared", question: "阿司匹林一级预防的获益与风险", startedAt: "2026-09-24T02:48:00Z", finishedAt: "2026-09-24T02:49:20Z", createdAt: "2026-09-24T02:48:00Z" }),
    ];
    renderBrowser();
    const rows = await screen.findAllByRole("link", { name: /阿司匹林一级预防的获益与风险/ });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute("href", "/app/chat/ses-shared");
    expect(screen.queryByRole("link", { name: /那 65–69 岁呢/ })).toBeNull();
  });

  it("does not offer 停止 on a conversation that has finished", async () => {
    mocks.runs.default = [run({ id: "run-1", question: "做完的研究" })];
    renderBrowser();
    await userEvent.click(await screen.findByRole("button", { name: "「做完的研究」的操作" }));
    expect(await screen.findByRole("menuitem", { name: "重命名" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "停止" })).toBeNull();
  });

  // One line: the title and a time. How the verification came out belongs to
  // the report, not to the list (2026-09-23 plan §5.2).
  it("shows no delivery or verification state on a row", async () => {
    mocks.runs.default = [
      run({ id: "clean", question: "干净的运行" }),
      run({ id: "open", question: "有待复核的运行", verification: "unverified" }),
      run({ id: "failed", question: "没做完的运行", status: "failed", errorCode: "runtime_stalled" }),
    ];
    renderBrowser();
    await screen.findByRole("link", { name: /干净的运行/ });
    for (const name of [/干净的运行/, /有待复核的运行/, /没做完的运行/]) {
      const row = screen.getByRole("link", { name });
      expect(row).not.toHaveTextContent(/已交付|核对|未完成|已取消/);
      expect(row.querySelector("[data-run-state]")).toBeNull();
    }
  });

  // A spinner while it works; a dot once it has finished and nobody opened it.
  it("marks a running conversation with a spinner and an unopened finished one with a dot", async () => {
    window.localStorage.setItem("evimed.runs.seen.v1", JSON.stringify({ since: Date.parse("2026-01-01T00:00:00Z"), seen: {} }));
    mocks.runs.default = [
      run({ id: "c", question: "还在做的", status: "running", finishedAt: null }),
      run({ id: "d", question: "刚做完的", finishedAt: new Date().toISOString() }),
    ];
    renderBrowser();
    const running = await screen.findByRole("link", { name: /还在做的/ });
    expect(within(running).getByLabelText("进行中")).toBeInTheDocument();
    const finished = screen.getByRole("link", { name: /刚做完的/ });
    expect(within(finished).getByRole("img", { name: "未打开" })).toBeInTheDocument();
    window.localStorage.removeItem("evimed.runs.seen.v1");
  });

  it("titles a row with the ledger's title before its question", async () => {
    mocks.runs.default = [run({ id: "t", title: "阿司匹林一级预防（≥70 岁）", question: "请以「临床证据深度分析」能力完成以下任务：原题" })];
    renderBrowser();
    expect(await screen.findByRole("link", { name: /阿司匹林一级预防（≥70 岁）/ })).toBeInTheDocument();
    expect(screen.queryByText(/请以「/)).not.toBeInTheDocument();
  });
});

describe("ProjectBrowser — search", () => {
  let release: (() => void) | null = null;
  afterEach(() => {
    release?.();
    release = null;
  });

  it("searches the tasks of every loaded project, naming each one's project, and offers to read the rest", async () => {
    mocks.runs.default = [run({ id: "d1", question: "阿司匹林一级预防" }), run({ id: "d2", question: "二甲双胍" })];
    mocks.runs.paper1 = [run({ id: "p1", question: "阿司匹林与出血" })];
    mocks.runs["p-heart"] = [run({ id: "h1", question: "阿司匹林在心衰中的作用" })];
    renderBrowser();
    await screen.findByRole("link", { name: /阿司匹林一级预防/ });
    await userEvent.click(screen.getByRole("button", { name: "Paper 1" }));
    await screen.findByRole("button", { name: /阿司匹林与出血/ });

    await userEvent.click(screen.getByRole("button", { name: "搜索对话" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索对话" }), "阿司匹林");

    const results = screen.getByRole("list", { name: "搜索结果" });
    expect(within(results).getAllByRole("listitem")).toHaveLength(2);
    expect(within(results).getByRole("button", { name: /阿司匹林与出血/ })).toHaveTextContent("Paper 1");
    expect(within(results).getByRole("link", { name: /阿司匹林一级预防/ })).toHaveTextContent("我的研究");
    expect(within(results).queryByText(/二甲双胍/)).not.toBeInTheDocument();
    // The project nobody opened was not read behind the reader's back…
    expect(readProjects()).not.toContain("p-heart");
    // …but it is one click away.
    await userEvent.click(screen.getByRole("button", { name: "在其余 1 个项目中查找" }));
    expect(await screen.findByRole("button", { name: /阿司匹林在心衰中的作用/ })).toBeInTheDocument();
    expect(mocks.listWebAgentRuns).toHaveBeenCalledWith({ projectId: "p-heart" });
  });

  it("closes with Escape, back to the tree, the focus on the search button", async () => {
    mocks.runs.default = [run({ id: "d1", question: "阿司匹林一级预防" })];
    renderBrowser();
    await screen.findByRole("link", { name: /阿司匹林一级预防/ });
    await userEvent.click(screen.getByRole("button", { name: "搜索对话" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索对话" }), "不存在的词");
    expect(screen.getByText("没有匹配的对话")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /阿司匹林一级预防/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "搜索对话" })).toHaveFocus());
  });

  it("opens a result in another project in place, and the tree shows it where it lives", async () => {
    mocks.runs.paper1 = Array.from({ length: 7 }, (_, index) => run({ id: `p${index}`, question: `论文任务 ${index}` }));
    renderBrowser();
    await userEvent.click(await screen.findByRole("button", { name: "Paper 1" }));
    await screen.findByRole("button", { name: /论文任务 0/ });
    await userEvent.click(screen.getByRole("button", { name: "Paper 1" }));
    await userEvent.click(screen.getByRole("button", { name: "搜索对话" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索对话" }), "论文任务 6");

    await userEvent.click(within(screen.getByRole("list", { name: "搜索结果" })).getByRole("button", { name: /论文任务 6/ }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/chat/ses-p6"));
    expect(useProjectStore.getState().currentId).toBe("paper1");
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    // Its group is open again and unfolded past the first five, so the row is visible.
    expect(screen.getByRole("button", { name: /^Paper 1\s*（当前项目）$/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: /论文任务 6/ })).toHaveAttribute("aria-current", "page");
  });

  it("keeps the conversation-content matches of the project on screen under the results", async () => {
    release = provideFrameSessionSearch(async () => ({
      ok: true,
      hasMore: false,
      items: [{ sessionId: "sess-x", title: "引用了 ASPREE 的对话", snippet: "ASPREE 研究显示…" }],
    }));
    renderBrowser();
    await screen.findByRole("button", { name: /^我的研究\s*（当前项目）$/ });
    await userEvent.click(screen.getByRole("button", { name: "搜索对话" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索对话" }), "ASPREE");

    expect(await screen.findByRole("link", { name: /引用了 ASPREE 的对话/ })).toHaveAttribute("href", "/app/chat/sess-x");
  });
});

describe("ProjectBrowser — creating and renaming", () => {
  // The field said 「新项目名」 and refused every Chinese name, because it was
  // the server's id (review B §2). It takes a name; the server keys it. And a
  // new project is for a task, so it opens on one — as adding a workspace does
  // in the kernel's own list.
  it("creates a project from a name in any language, then opens a new task in it", async () => {
    mocks.createWebProject.mockImplementation(async (name: string) => {
      const project = { id: "p-1a2b3c4d", name };
      mocks.projects = [...mocks.projects, project];
      return project;
    });
    renderBrowser("/app/files");
    await userEvent.click(await screen.findByRole("button", { name: "新建项目" }));
    await userEvent.type(screen.getByRole("textbox", { name: "新项目名" }), "阿司匹林一级预防{Enter}");

    await waitFor(() => expect(mocks.createWebProject).toHaveBeenCalledWith("阿司匹林一级预防"));
    await waitFor(() => expect(useProjectStore.getState().currentId).toBe("p-1a2b3c4d"));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/app\/chat/));
    expect(JSON.parse(screen.getByTestId("intent").textContent!)).toMatchObject({ kind: "create", projectId: "p-1a2b3c4d" });
    expect(screen.getByRole("button", { name: /^阿司匹林一级预防\s*（当前项目）$/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("asks for a name before creating, without calling the API", async () => {
    renderBrowser();
    await userEvent.click(await screen.findByRole("button", { name: "新建项目" }));
    await userEvent.type(screen.getByRole("textbox", { name: "新项目名" }), "   {Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("请给项目起个名字。");
    expect(mocks.createWebProject).not.toHaveBeenCalled();
  });

  it("explains the project limit in Chinese, with its reason", async () => {
    mocks.createWebProject.mockRejectedValue(new WebApiError("This account already holds 3 projects", { status: 409, code: "project_limit_reached" }));
    renderBrowser();
    await userEvent.click(await screen.findByRole("button", { name: "新建项目" }));
    await userEvent.type(screen.getByRole("textbox", { name: "新项目名" }), "第四个{Enter}");

    // The sentence is the error-code registry's (one place for every code's
    // Chinese), not a second copy kept here: the limit, why it exists, and
    // what to do about it.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("项目数已达上限");
    expect(alert).toHaveTextContent("每个项目都有独立的存储空间和研究运行时");
    expect(alert).toHaveTextContent("再新建");
    expect(alert.textContent).not.toMatch(/[A-Za-z]{4,}/);
    expect(useProjectStore.getState().currentId).toBe("default");
  });

  it("renames a project in place, and gives the focus back to its group", async () => {
    renderBrowser();
    await userEvent.click(await screen.findByRole("button", { name: "重命名项目「Paper 1」" }));
    const input = screen.getByRole("textbox", { name: "新的项目名" });
    expect(input).toHaveValue("Paper 1");
    await userEvent.clear(input);
    await userEvent.type(input, "论文一{Enter}");

    await waitFor(() => expect(mocks.renameWebProject).toHaveBeenCalledWith("paper1", "论文一"));
    await waitFor(() => expect(screen.getByRole("button", { name: "论文一" })).toHaveFocus());
  });

  it("leaves a rename with Escape, untouched", async () => {
    renderBrowser();
    await userEvent.click(await screen.findByRole("button", { name: "重命名项目「Paper 1」" }));
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("textbox", { name: "新的项目名" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Paper 1" })).toBeInTheDocument();
    expect(mocks.renameWebProject).not.toHaveBeenCalled();
  });

  it("refuses an empty name in a rename, without calling the API", async () => {
    renderBrowser();
    await userEvent.click(await screen.findByRole("button", { name: "重命名项目「Paper 1」" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "新的项目名" }));
    await userEvent.keyboard("{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("请给项目起个名字。");
    expect(mocks.renameWebProject).not.toHaveBeenCalled();
  });
});

describe("ProjectBrowser — GEO projects", () => {
  // A GEO project is an ordinary project with a GEO row: it sits among the
  // others, with the radar where the folder would be.
  it("gives a GEO project the radar icon when the module is offered", async () => {
    mocks.listGeoProjects.mockResolvedValue([{ id: "geo_1", projectId: "p-heart", name: "心衰" }]);
    render(
      <MemoryRouter initialEntries={["/app/chat"]}>
        <ProjectBrowser geo />
      </MemoryRouter>,
    );
    const heart = await screen.findByRole("button", { name: "心衰" });
    await waitFor(() => expect(heart.querySelector("svg.lucide-radar")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Paper 1" }).querySelector("svg.lucide-radar")).toBeNull();
    expect(screen.getByRole("button", { name: "Paper 1" }).querySelector("svg.lucide-folder")).not.toBeNull();
  });

  it("reads no GEO list when the module is not offered", async () => {
    renderBrowser();
    await screen.findByRole("button", { name: "心衰" });
    expect(mocks.listGeoProjects).not.toHaveBeenCalled();
    expect(document.querySelector("svg.lucide-radar")).toBeNull();
  });
});
