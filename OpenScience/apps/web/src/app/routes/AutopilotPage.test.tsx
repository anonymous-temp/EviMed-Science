import { act, cleanup, fireEvent, render as renderView, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, useLocation } from "react-router";
import { RouterProvider } from "react-router/dom";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { useTaskPane } from "@/lib/taskPane";
import { RECOMMENDATIONS } from "@/components/autopilot/taskPresentation";
import { AutopilotPage } from "./AutopilotPage";

// A data router builds a `Request` with an abort signal, and jsdom's signal is not the one the platform's `Request` accepts.
const NativeRequest = globalThis.Request;
class SignalCompatibleRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) { super(input, init ? { ...init, signal: undefined } : init); }
}

const identity = vi.hoisted(() => ({ projectId: "project-one", viewerZone: "Asia/Shanghai", width: 1280 }));
const mocks = vi.hoisted(() => ({ listAgendas: vi.fn(), getAgenda: vi.fn(), createAgenda: vi.fn(), updateAgenda: vi.fn(), archiveAgenda: vi.fn(), startAgenda: vi.fn(), stopAgenda: vi.fn(), runAgendaNow: vi.fn(), cancelEpisode: vi.fn(), listEpisodes: vi.fn(), getDigest: vi.fn(), markDigestOpened: vi.fn(),
  getResearchState: vi.fn(), addAgendaMaterials: vi.fn(), removeAgendaMaterial: vi.fn(), listWebAgentRuns: vi.fn() }));
const files = vi.hoisted(() => ({ pickFiles: vi.fn(), uploadFilesToWorkspace: vi.fn(), sha256Hex: vi.fn(), listSources: vi.fn() }));
vi.mock("@/lib/autopilotClient", () => mocks);
vi.mock("@/lib/backend", async (original) => ({ ...(await original<object>()), pickFiles: files.pickFiles, uploadFilesToWorkspace: files.uploadFilesToWorkspace }));
vi.mock("@/lib/fileDigest", () => ({ sha256Hex: files.sha256Hex }));
vi.mock("@/lib/sourceClient", async (original) => ({ ...(await original<object>()), listSources: files.listSources }));
vi.mock("@/lib/apiClient", async (original) => ({ ...(await original<object>()), getWebProjectId: () => identity.projectId, listWebAgentRuns: mocks.listWebAgentRuns }));

/** A weekly task: Monday and Friday at 07:30 Beijing time, next on Saturday 3 October (the clock below is Thursday 1 October). */
const agenda = { id: "agenda-one", projectId: "project-one", revision: 2, createdAt: "2026-09-28T00:00:00Z", payload: {
  title: "心衰证据追踪", prompt: "完整跟进心衰与肾病\n保留原始指令", topics: ["heart failure"], taskTypes: ["evidence-update"],
  dailyBudgetCny: 20, weeklyBudgetCny: 80, maxEpisodeCny: 8, scheduleHour: 7, timeZone: "Asia/Shanghai",
  schedule: { kind: "weekly", timeZone: "Asia/Shanghai", time: "07:30", weekdays: [1, 5] }, nextRunAt: "2026-10-02T23:30:00Z", scheduleState: "scheduled",
  enabled: true, status: "active", pauseReason: null, outcomes: [],
} };
const paused = (extra: Record<string, unknown> = {}, id = agenda.id) => ({ ...agenda, id, payload: { ...agenda.payload, enabled: false, status: "paused", scheduleState: "paused", nextRunAt: null, ...extra } });
const episode = { id: "ep-one", projectId: "project-one", revision: 1, payload: { agendaId: agenda.id, taskType: "evidence-update", date: "2026-09-29", status: "merged", runId: "run-one", sessionId: "ses-one", digestId: "digest-one", createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T01:00:00Z", trigger: "scheduled", instruction: "Previous frozen instruction", claims: [{ id: "c1", statement: "已有研究结果" }] } };
const running = (extra: Record<string, unknown> = {}) => ({ ...episode, id: "ep-run", payload: { ...episode.payload, status: "running", runId: "run-live", sessionId: "ses-live", digestId: null, claims: [], createdAt: "2026-10-01T01:00:00Z", scheduledAt: "2026-10-01T01:00:00Z", ...extra } });
const digest = { id: "digest-one", projectId: "project-one", payload: { agendaId: agenda.id, episodeIds: ["ep-one"] } };
const state = (extra: Record<string, unknown>) => ({ agendaId: "agenda-one", asOf: "2026-10-04T00:00:00Z", truncated: false, found: [], unresolved: [], materials: [], ...extra });
const ref = (path: string) => ({ projectId: "project-one", runId: "run-one", sessionId: "ses-one", path });

function Location() { const loc = useLocation(); return <p data-testid="location">{loc.pathname}{loc.search}</p>; }
/** What the page has asked the shell's frame host for: the conversation it wants over its pane, or nothing. */
function Pane() { const pane = useTaskPane(); return <p data-testid="pane">{pane ? `${pane.projectId}:${pane.sessionId}` : "none"}</p>; }
function render(path = "/app/autopilot/agenda-one") {
  const router = createMemoryRouter([
    { path: "/app/autopilot/:taskId?", element: <><AutopilotPage /><Location /><Pane /></> },
    { path: "/app/chat/:sessionId", element: <Location /> }, { path: "/app/runs", element: <Location /> },
    { path: "/app/runs/:runId/files/*", element: <Location /> },
  ], { initialEntries: [path] });
  return { router, ...renderView(<RouterProvider router={router} />) };
}
const here = () => screen.getByTestId("location").textContent;
const task = () => document.querySelector<HTMLElement>("[data-task-main]")!;
const bar = () => document.querySelector<HTMLElement>("[data-task-bar]")!;
/** The task bar once the page has drawn it: a task page reads its task before it has one. */
const barElement = async () => { await waitFor(() => { if (!document.querySelector("[data-task-bar]")) throw new Error("the task bar is not drawn yet"); }); return bar(); };
const list = () => document.querySelector<HTMLElement>("[data-task-list]")!;
const choose = async (trigger: HTMLElement, name: string) => {
  await userEvent.click(trigger);
  await userEvent.click(await screen.findByRole("menuitem", { name }));
};
/** The bar's own 「⋯」 (the list's rows have one each, named for their task). */
const barMenu = async () => within(await barElement()).getByRole("button", { name: "更多" });
const rowOf = (title: string) => screen.getByRole("link", { name: title }).closest("li")!;
const rowMenu = (title: string) => within(rowOf(title)).getByRole("button", { name: `“${title}”的更多操作` });

/** Every timer faked, the clock where the others have it: `useFakeTimers` called again keeps the first call's choice of what to fake. */
const NOW = new Date("2026-10-01T02:00:00Z");
const fakeClock = () => { vi.useRealTimers(); vi.useFakeTimers(); vi.setSystemTime(NOW); };

// The page measures its own width: the list column and the conversation pane beside it need room, and a window is not the measure.
let observers: Array<(entries: Array<{ contentRect: { width: number } }>) => void> = [];
const resize = (width: number) => act(() => { identity.width = width; observers.forEach(callback => callback([{ contentRect: { width } }])); });

describe("scheduled tasks", () => {
  beforeEach(() => {
    vi.useRealTimers(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
    identity.projectId = "project-one"; identity.viewerZone = "Asia/Shanghai"; identity.width = 1280; observers = [];
    Object.values(mocks).forEach(fn => fn.mockReset());
    vi.stubGlobal("Request", SignalCompatibleRequest);
    vi.stubGlobal("ResizeObserver", class { constructor(private callback: (entries: Array<{ contentRect: { width: number } }>) => void) { observers.push(callback); } observe() {} unobserve() {} disconnect() { observers = observers.filter(each => each !== this.callback); } });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const width = this.hasAttribute("data-autopilot-layout") ? identity.width : 0;
      return { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    const resolved = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) { return { ...resolved.call(this), timeZone: identity.viewerZone }; });
    mocks.listAgendas.mockResolvedValue({ items: [agenda] }); mocks.getAgenda.mockResolvedValue(agenda);
    mocks.listEpisodes.mockResolvedValue({ items: [episode] }); mocks.createAgenda.mockResolvedValue(agenda);
    mocks.startAgenda.mockResolvedValue(agenda); mocks.stopAgenda.mockResolvedValue(agenda); mocks.updateAgenda.mockResolvedValue(agenda);
    mocks.archiveAgenda.mockResolvedValue(agenda); mocks.runAgendaNow.mockResolvedValue({ episode: { ...episode, id: "manual-one", payload: { ...episode.payload, status: "queued", runId: null, sessionId: null, createdAt: "2026-10-01T02:00:00Z" } } });
    mocks.cancelEpisode.mockResolvedValue({ ...running(), payload: { ...running().payload, status: "canceled" } });
    mocks.getDigest.mockResolvedValue(digest); mocks.markDigestOpened.mockResolvedValue(digest); mocks.listWebAgentRuns.mockResolvedValue([]);
    Object.values(files).forEach(fn => fn.mockReset());
    mocks.getResearchState.mockResolvedValue(state({})); mocks.addAgendaMaterials.mockResolvedValue(agenda); mocks.removeAgendaMaterial.mockResolvedValue(agenda);
    files.listSources.mockResolvedValue({ items: [], nextCursor: null });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  describe("addresses", () => {
    it("moves the old ?task= address to the task's page", async () => {
      render("/app/autopilot?task=agenda-one");
      await waitFor(() => expect(here()).toBe("/app/autopilot/agenda-one"));
      expect(await within(await barElement()).findByRole("heading", { name: "心衰证据追踪" })).toBeInTheDocument();
    });
    it("moves a briefing's address to its task with that execution chosen, and marks the briefing read", async () => {
      render("/app/autopilot?digest=digest-one");
      await waitFor(() => expect(here()).toBe("/app/autopilot/agenda-one?execution=ep-one"));
      expect(mocks.markDigestOpened).toHaveBeenCalledWith("digest-one");
      expect(mocks.listEpisodes).toHaveBeenCalledWith("project-one", "agenda-one");
    });
    it("opens a briefing of another project's execution in its conversation there, as it always has", async () => {
      mocks.getDigest.mockResolvedValue({ ...digest, projectId: "another-project" }); render("/app/autopilot?digest=digest-one");
      await waitFor(() => expect(here()).toBe("/app/runs?run=run-one")); expect(mocks.markDigestOpened).toHaveBeenCalledWith("digest-one");
    });
    it("falls back to the list for a briefing address that no longer resolves", async () => {
      mocks.getDigest.mockRejectedValue(new Error("gone")); render("/app/autopilot?digest=obsolete");
      await waitFor(() => expect(here()).toBe("/app/autopilot")); expect(mocks.markDigestOpened).not.toHaveBeenCalled();
    });
    it("ignores an old project's deferred briefing redirect after switching projects", async () => {
      let resolveDigest!: (value: unknown) => void;
      mocks.getDigest.mockImplementationOnce(() => new Promise(resolve => { resolveDigest = resolve; })).mockResolvedValue({ ...digest, payload: { episodeIds: [] } });
      render("/app/autopilot?digest=digest-one"); await screen.findByRole("link", { name: "心衰证据追踪" });
      mocks.listEpisodes.mockResolvedValue({ items: [] });
      await act(async () => { identity.projectId = "project-two"; useProjectStore.setState({ currentId: "project-two" }); });
      await act(async () => { resolveDigest(digest); });
      expect(mocks.markDigestOpened).not.toHaveBeenCalled(); expect(here()).not.toContain("/app/autopilot/agenda-one");
    });
    it("says so, with the list still beside it, when the task in the address is not there", async () => {
      render("/app/autopilot/gone");
      expect(await screen.findByText("未找到这个任务")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "心衰证据追踪" })).toBeInTheDocument();
      expect(screen.getByTestId("pane")).toHaveTextContent("none");
    });
  });

  describe("the list column", () => {
    it("is the page's heading and one quiet 新建 icon button, with the project named in plain text", async () => {
      useProjectStore.setState({ projects: [{ id: "project-one", name: "我的研究" } as never] });
      try {
        render("/app/autopilot");
        const header = screen.getByRole("heading", { name: "定时任务", level: 1 }).closest("header")!;
        expect(within(header).getByText("我的研究")).toBeInTheDocument();
        // One button, an icon: no solid 新建任务 button, no second action.
        expect(within(header).getAllByRole("button").map(button => button.getAttribute("aria-label"))).toEqual(["新建"]);
        expect(within(header).queryByText("新建任务")).not.toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "返回工作台" })).not.toBeInTheDocument();
      } finally { useProjectStore.setState({ projects: [] }); }
    });
    it("tells the page's project from a namesake the way the sidebar does", async () => {
      const year = new Date().getFullYear();
      useProjectStore.setState({ projects: [
        { id: "project-one", name: "波立维", createdAt: new Date(year, 8, 29, 14, 2).toISOString() } as never,
        { id: "project-two", name: "波立维", createdAt: new Date(year, 9, 1, 9, 30).toISOString() } as never,
      ] });
      try {
        render("/app/autopilot");
        const header = screen.getByRole("heading", { name: "定时任务", level: 1 }).closest("header")!;
        expect(within(header).getByText("波立维 · 9月29日")).toBeInTheDocument();
      } finally { useProjectStore.setState({ projects: [] }); }
    });
    it("groups the tasks as 即将执行 / 已暂停 / 已完成 and draws only the groups that have rows, with no templates or opportunities on the page", async () => {
      const done = { ...agenda, id: "done", payload: { ...agenda.payload, title: "做完的任务", scheduleState: "completed", nextRunAt: null, schedule: { kind: "once", date: "2026-09-29", time: "07:30", timeZone: "Asia/Shanghai" } } };
      mocks.listAgendas.mockResolvedValue({ items: [done, paused({ title: "已停的任务" }, "paused"), agenda] });
      render("/app/autopilot");
      const upcoming = await screen.findByRole("region", { name: "即将执行" });
      expect(within(upcoming).getByRole("link", { name: "心衰证据追踪" })).toBeInTheDocument();
      expect(within(screen.getByRole("region", { name: "已暂停" })).getByRole("link", { name: "已停的任务" })).toBeInTheDocument();
      expect(within(screen.getByRole("region", { name: "已完成" })).getByRole("link", { name: "做完的任务" })).toBeInTheDocument();
      expect([...list().querySelectorAll("section h2")].map(each => each.textContent)).toEqual(["即将执行", "已暂停", "已完成"]);
      // The list holds tasks and nothing else (page structure rule 1): the starting points are in the new-task dialog.
      expect(screen.queryByRole("region", { name: "推荐" })).not.toBeInTheDocument(); expect(screen.queryByRole("region", { name: "研究机会" })).not.toBeInTheDocument();
      cleanup(); mocks.listAgendas.mockResolvedValue({ items: [agenda] }); render("/app/autopilot");
      await screen.findByRole("region", { name: "即将执行" });
      expect(screen.queryByRole("region", { name: "已暂停" })).not.toBeInTheDocument(); expect(screen.queryByRole("region", { name: "已完成" })).not.toBeInTheDocument();
    });
    it("says in each row only when it runs next and how often, that it is running, why it stopped, or that it is done", async () => {
      const runner = { ...agenda, id: "runner", payload: { ...agenda.payload, title: "正在跑的任务", schedule: { kind: "weekly", timeZone: "Asia/Shanghai", time: "08:00", weekdays: [1] } } };
      const asking = paused({ title: "等你补充的任务", plannerStop: { kind: "needs_input", reason: "要监测的药品名单", at: "2026-10-01T00:00:00Z" } }, "asking");
      const stopped = paused({ title: "你停了的任务" }, "stopped");
      const done = { ...agenda, id: "done", payload: { ...agenda.payload, title: "做完的任务", scheduleState: "completed", nextRunAt: null, schedule: { kind: "once", date: "2026-09-29", time: "07:30", timeZone: "Asia/Shanghai" } } };
      const daily = { ...agenda, id: "daily", payload: { ...agenda.payload, title: "每天的任务", nextRunAt: "2026-10-01T23:00:00Z", schedule: { kind: "daily", timeZone: "Asia/Shanghai", time: "07:00" } } };
      mocks.listAgendas.mockResolvedValue({ items: [agenda, runner, asking, stopped, done, daily] });
      mocks.listEpisodes.mockResolvedValue({ items: [running({ agendaId: "runner" }), episode] });
      render("/app/autopilot");
      await screen.findByRole("link", { name: "心衰证据追踪" });
      // The viewer's own zone is Beijing time here, so no row names it.
      expect(rowOf("心衰证据追踪")).toHaveTextContent("下次 周六 07:30 · 每周");
      expect(rowOf("每天的任务")).toHaveTextContent("下次 明天 07:00 · 每天");
      expect(rowOf("正在跑的任务")).toHaveTextContent("进行中 · 每周一 08:00");
      expect(rowOf("等你补充的任务")).toHaveTextContent("需要你补充：要监测的药品名单");
      expect(rowOf("你停了的任务")).toHaveTextContent("已暂停");
      expect(rowOf("做完的任务")).toHaveTextContent("已完成 · 9月29日");
      // Nothing of the engine and no second line about the last run.
      for (const each of list().querySelectorAll("li")) expect(each.textContent).not.toMatch(/Asia\/|merged|failed|running|上次/);
      // The running task carries the in-progress dot; every row has the gutter, so the names start on one left edge.
      expect(rowOf("正在跑的任务").querySelector('[data-run-state="running"]')).not.toBeNull();
      expect(rowOf("心衰证据追踪").querySelector('[data-run-state]')).toBeNull();
    });
    it("names a task's zone in its row only when it is not the reader's own", async () => {
      identity.viewerZone = "America/New_York";
      render("/app/autopilot");
      expect(await screen.findByRole("link", { name: "心衰证据追踪" })).toBeInTheDocument();
      expect(rowOf("心衰证据追踪")).toHaveTextContent("下次 周六 07:30 中国标准时间 · 每周");
    });
    it("gives every row its 「⋯」: 立即运行, 暂停 or 启用, 编辑, and 删除 after a separator", async () => {
      mocks.listAgendas.mockResolvedValue({ items: [agenda, paused({ title: "已停的任务" }, "paused")] });
      render("/app/autopilot"); await screen.findByRole("link", { name: "心衰证据追踪" });
      await userEvent.click(rowMenu("心衰证据追踪"));
      expect((await screen.findAllByRole("menuitem")).map(item => item.textContent)).toEqual(["立即运行", "暂停", "编辑", "删除"]);
      expect(screen.getByRole("separator")).toBeInTheDocument(); expect(screen.getByRole("menuitem", { name: "删除" })).toHaveClass("text-danger");
      await userEvent.keyboard("{Escape}");
      await userEvent.click(rowMenu("已停的任务"));
      expect((await screen.findAllByRole("menuitem")).map(item => item.textContent)).toEqual(["立即运行", "启用", "编辑", "删除"]);
      // A paused task is started again, never run; the menu says so rather than hiding the item.
      expect(screen.getByRole("menuitem", { name: "立即运行" })).toBeDisabled();
    });
    it("runs from a row at once, with no confirmation and no budget said, and opens that task", async () => {
      mocks.listAgendas.mockResolvedValue({ items: [agenda, { ...agenda, id: "second", payload: { ...agenda.payload, title: "第二个任务" } }] });
      render("/app/autopilot/second"); await screen.findByRole("link", { name: "心衰证据追踪" });
      await choose(rowMenu("心衰证据追踪"), "立即运行");
      await waitFor(() => expect(mocks.runAgendaNow).toHaveBeenCalledWith("agenda-one", expect.any(String)));
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(); expect(screen.queryByText(/本次最多花费|单次上限|¥/)).not.toBeInTheDocument();
      await waitFor(() => expect(here()).toBe("/app/autopilot/agenda-one"));
    });
    it("confirms pausing with what it cancels, starts a paused task without asking, and confirms a delete that keeps the results", async () => {
      mocks.listAgendas.mockResolvedValue({ items: [agenda, paused({ title: "已停的任务" }, "paused")] });
      render("/app/autopilot"); await screen.findByRole("link", { name: "心衰证据追踪" });
      await choose(rowMenu("心衰证据追踪"), "暂停");
      const pause = screen.getByRole("alertdialog"); expect(pause).toHaveTextContent("取消正在进行和排队中的研究");
      expect(mocks.stopAgenda).not.toHaveBeenCalled(); await userEvent.click(within(pause).getByRole("button", { name: "暂停任务" }));
      await waitFor(() => expect(mocks.stopAgenda).toHaveBeenCalledWith(agenda.id, 2));
      await choose(rowMenu("已停的任务"), "启用");
      await waitFor(() => expect(mocks.startAgenda).toHaveBeenCalledWith("paused", 2)); expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      await choose(rowMenu("心衰证据追踪"), "删除");
      const archive = screen.getByRole("alertdialog"); expect(archive).toHaveTextContent("保留历史研究结果");
      await userEvent.click(within(archive).getByRole("button", { name: "删除任务" }));
      await waitFor(() => expect(mocks.archiveAgenda).toHaveBeenCalledWith(agenda.id, 2));
    });
    it("opens the editor from a row, and the editor is the same dialog as 新建", async () => {
      render("/app/autopilot"); await screen.findByRole("link", { name: "心衰证据追踪" });
      await choose(rowMenu("心衰证据追踪"), "编辑");
      const form = await screen.findByRole("dialog", { name: "编辑任务" });
      expect(within(form).getByLabelText("任务指令")).toHaveValue("完整跟进心衰与肾病\n保留原始指令");
      expect(within(form).queryByRole("region", { name: "从推荐开始" })).not.toBeInTheDocument();
    });
    it("marks the open task's row and no other", async () => {
      mocks.listAgendas.mockResolvedValue({ items: [agenda, { ...agenda, id: "second", payload: { ...agenda.payload, title: "第二个任务" } }] });
      render("/app/autopilot/second");
      await screen.findByRole("link", { name: "第二个任务" });
      expect(screen.getByRole("link", { name: "第二个任务" })).toHaveAttribute("aria-current", "page");
      expect(screen.getByRole("link", { name: "心衰证据追踪" })).not.toHaveAttribute("aria-current");
      expect(rowOf("第二个任务")).toHaveClass("bg-accent-soft");
    });
    it("opens a task by its row, carrying the search with it", async () => {
      render("/app/autopilot?q=%E5%BF%83"); await userEvent.click(await screen.findByRole("link", { name: "心衰证据追踪" }));
      expect(here()).toBe("/app/autopilot/agenda-one?q=%E5%BF%83");
    });
    it("offers retry on a list failure", async () => {
      mocks.listAgendas.mockRejectedValueOnce(new Error("offline")); render("/app/autopilot");
      expect(await screen.findByRole("alert")).toHaveTextContent("定时任务暂不可用"); await userEvent.click(screen.getByRole("button", { name: /重试/ }));
      expect(await screen.findByText("心衰证据追踪")).toBeInTheDocument();
    });
    it("draws no search box over nothing, and says there are no tasks", async () => {
      mocks.listAgendas.mockResolvedValue({ items: [] }); render("/app/autopilot");
      expect(await screen.findByText("还没有定时任务")).toBeInTheDocument();
      expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    });
  });

  describe("search and the address", () => {
    it("keeps the search in the address, clears it by its button and by Escape, and Back brings it back", async () => {
      const { router } = render("/app/autopilot/agenda-one"); await screen.findByRole("link", { name: "心衰证据追踪" });
      const box = screen.getByRole("searchbox", { name: "搜索任务" });
      await userEvent.type(box, "missing");
      expect(here()).toBe("/app/autopilot/agenda-one?q=missing");
      expect(screen.queryByRole("link", { name: "心衰证据追踪" })).not.toBeInTheDocument(); expect(screen.getByText("没有匹配的任务")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "清除搜索" }));
      expect(box).toHaveValue(""); expect(here()).toBe("/app/autopilot/agenda-one");
      await userEvent.type(box, "心衰{Escape}");
      expect(box).toHaveValue(""); expect(screen.getByRole("link", { name: "心衰证据追踪" })).toBeInTheDocument();
      // History: opening another address and going back restores the search text from the address.
      await act(async () => { await router.navigate("/app/autopilot/agenda-one?q=%E8%82%BE"); });
      expect(box).toHaveValue("肾");
      await act(async () => { await router.navigate(-1); });
      await waitFor(() => expect(box).toHaveValue(""));
    });
    it("restores the task and the chosen execution from the address", async () => {
      const older = { ...episode, id: "ep-old", payload: { ...episode.payload, sessionId: "ses-old", runId: "run-old", createdAt: "2026-09-22T00:00:00Z", digestId: null } };
      mocks.listEpisodes.mockResolvedValue({ items: [episode, older] });
      render("/app/autopilot/agenda-one?execution=ep-old");
      await waitFor(() => expect(screen.getByTestId("pane")).toHaveTextContent("project-one:ses-old"));
      expect(within(bar()).getByRole("button", { name: /第 1 次/ })).toBeInTheDocument();
    });
  });

  describe("a task's page", () => {
    it("shows, for a task that has never run, its instruction and when it will, and nothing else: no card, no input box", async () => {
      mocks.listEpisodes.mockResolvedValue({ items: [] });
      render("/app/autopilot/agenda-one");
      const pane = await screen.findByRole("region", { name: "任务对话" });
      expect(pane).toHaveAttribute("data-task-pane", "never-run");
      expect(pane).toHaveTextContent("完整跟进心衰与肾病"); expect(pane).toHaveTextContent("保留原始指令");
      expect(pane).toHaveTextContent("还没有执行过，下次 10月3日 07:30 中国标准时间");
      expect(within(task()).queryByRole("textbox")).not.toBeInTheDocument(); expect(within(task()).queryByRole("searchbox")).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(within(bar()).getByRole("button", { name: "立即运行" })).toBeEnabled();
      expect(within(bar()).queryByRole("link", { name: "最新结果" })).not.toBeInTheDocument();
      expect(screen.getByTestId("pane")).toHaveTextContent("none");
    });
    it("draws the task bar: name, how often with the zone, next time, 最新结果 and the one primary button, and says no budget", async () => {
      mocks.listEpisodes.mockResolvedValue({ items: [{ ...episode, payload: { ...episode.payload, artifactRefs: [
        ref("work/build_final.py"), ref("deliverables/x/clinical-evidence-matrix.json"), ref("deliverables/x/clinical-evidence-report.md"),
        { ...ref("private.csv"), projectId: "other" }, ref("../secret.csv"),
      ] } }] });
      render();
      const heading = await within(await barElement()).findByRole("heading", { name: "心衰证据追踪" });
      expect(heading.tagName).toBe("H2");
      expect(bar()).toHaveTextContent("每周一、周五 07:30 · 中国标准时间 · 下次 10月3日 07:30");
      expect(bar()).not.toHaveTextContent(/单次上限|¥|灵豆|Asia\//);
      // The newest readable file, the report first, opened in the shell's reader: no runtime is needed to read it.
      const latest = within(bar()).getByRole("link", { name: "最新结果" });
      expect(latest).toHaveAttribute("href", "/app/runs/run-one/files/deliverables/x/clinical-evidence-report.md");
      await userEvent.click(latest);
      expect(mocks.markDigestOpened).toHaveBeenCalledWith("digest-one"); expect(here()).toBe("/app/runs/run-one/files/deliverables/x/clinical-evidence-report.md");
    });
    it("opens the latest ended execution's conversation in the shell's frame pane, with no second input box and no drawer", async () => {
      render();
      await waitFor(() => expect(screen.getByTestId("pane")).toHaveTextContent("project-one:ses-one"));
      const pane = screen.getByRole("region", { name: "任务对话" });
      expect(pane).toHaveAttribute("data-task-pane", "conversation"); expect(pane).toBeEmptyDOMElement();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("针对任务追问")).not.toBeInTheDocument();
      expect(within(task()).queryByRole("textbox")).not.toBeInTheDocument(); expect(within(task()).queryByRole("button", { name: "发送追问" })).not.toBeInTheDocument();
      // The old blue instruction bubble and the header budget are gone with the drawer.
      expect(task()).not.toHaveTextContent("完整跟进心衰与肾病"); expect(task()).not.toHaveTextContent("单次上限");
    });
    it("withdraws its request for the frame when the page goes", async () => {
      const { router } = render();
      await waitFor(() => expect(screen.getByTestId("pane")).toHaveTextContent("ses-one"));
      await act(async () => { await router.navigate("/app/chat/ses-one"); });
      expect(screen.getByTestId("location")).toHaveTextContent("/app/chat/ses-one");
    });
    it("shows an execution that runs in the researcher's own runtime live, in the frame, and offers to stop only that execution", async () => {
      mocks.listEpisodes.mockResolvedValue({ items: [episode, running({ interactive: true })] });
      render();
      await waitFor(() => expect(screen.getByTestId("pane")).toHaveTextContent("project-one:ses-live"));
      expect(within(bar()).queryByRole("button", { name: "立即运行" })).not.toBeInTheDocument();
      const stop = within(bar()).getByRole("button", { name: "停止本次" });
      await userEvent.click(stop);
      await waitFor(() => expect(mocks.cancelEpisode).toHaveBeenCalledWith("agenda-one", "ep-run", expect.any(String)));
      // Pausing the task is another control, behind 「⋯」, with its honest confirmation: stopping one run is not it.
      expect(mocks.stopAgenda).not.toHaveBeenCalled(); expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
    it("shows an execution in a bounded runtime as its progress from the run ledger, never the frame, and moves to its conversation when it ends", async () => {
      mocks.listEpisodes.mockResolvedValue({ items: [episode, running({ interactive: false })] });
      mocks.listWebAgentRuns.mockResolvedValue([{ id: "run-live", progress: { deliverables: [{ id: "d1", title: "证据综合报告", status: "delegated", attempts: 1 }], phaseCounts: { search: 6, screen: 0, fulltext: 0, claims: 0, write: 0, deliver: 0 }, currentPhase: "search", sources: { searched: 40, included: 9, fullText: 0 }, claims: { total: 0, verified: 0 }, children: [], startedAt: null, updatedAt: "2026-10-01T01:30:00Z" } }]);
      fakeClock(); render(); await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      const pane = screen.getByRole("region", { name: "任务对话" });
      expect(pane).toHaveAttribute("data-task-pane", "progress");
      expect(within(pane).getByText("正在检索")).toBeInTheDocument();
      expect(pane).toHaveTextContent("检索 6 次 · 纳入 9 篇"); expect(pane).toHaveTextContent("证据综合报告"); expect(pane).toHaveTextContent("进行中");
      expect(pane).toHaveTextContent("执行结束后可以在这里继续");
      expect(pane).not.toHaveTextContent(/已交付|核验/);
      expect(screen.getByTestId("pane")).toHaveTextContent("none");
      expect(within(bar()).getByRole("button", { name: "停止本次" })).toBeInTheDocument();
      // The execution ends: the pane asks for its conversation, and the progress is gone.
      mocks.listEpisodes.mockResolvedValue({ items: [episode, running({ interactive: false, status: "merged" })] });
      await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
      expect(screen.getByTestId("pane")).toHaveTextContent("project-one:ses-live");
      expect(screen.getByRole("region", { name: "任务对话" })).toHaveAttribute("data-task-pane", "conversation");
    });
    it("holds every conversation of the project while another task's bounded execution runs, and says so", async () => {
      mocks.listAgendas.mockResolvedValue({ items: [agenda, { ...agenda, id: "second", payload: { ...agenda.payload, title: "第二个任务" } }] });
      mocks.listEpisodes.mockImplementation((_project: string, id?: string) => Promise.resolve({ items: id === "second" ? [{ ...episode, id: "ep-second", payload: { ...episode.payload, agendaId: "second" } }]
        : [running({ agendaId: "agenda-one", interactive: false })] }));
      render("/app/autopilot/second");
      const pane = await screen.findByRole("region", { name: "任务对话" });
      expect(pane).toHaveAttribute("data-task-pane", "progress");
      expect(pane).toHaveTextContent("这个项目里另一项任务正在执行"); expect(pane).toHaveTextContent("执行结束后可以在这里继续");
      expect(screen.getByTestId("pane")).toHaveTextContent("none");
    });
    it("says a queued execution's state and when it will be tried again, in the task's zone", async () => {
      mocks.listEpisodes.mockResolvedValue({ items: [episode, running({ status: "queued", runId: null, sessionId: null, resourceDeferrals: { episode: { code: "runtime_busy", status: "waiting", retryAt: "2026-10-01T03:00:00Z" } } })] });
      render();
      const pane = await screen.findByRole("region", { name: "任务对话" });
      await waitFor(() => expect(pane).toHaveAttribute("data-task-pane", "waiting"));
      expect(pane).toHaveTextContent("等待运行资源"); expect(pane).toHaveTextContent("预计重试 10月1日 11:00");
    });
    it("says an execution that left no conversation did, and does not ask for a frame", async () => {
      mocks.listEpisodes.mockResolvedValue({ items: [{ ...episode, payload: { ...episode.payload, status: "failed", runId: null, sessionId: null, digestId: null } }] });
      render();
      const pane = await screen.findByRole("region", { name: "任务对话" });
      expect(pane).toHaveAttribute("data-task-pane", "no-conversation"); expect(pane).toHaveTextContent("这次执行没有留下对话"); expect(pane).toHaveTextContent("未完成");
      expect(screen.getByTestId("pane")).toHaveTextContent("none");
    });
    it("says a stage as the research it is: no 核验 anywhere on the page", async () => {
      mocks.listEpisodes.mockResolvedValue({ items: [episode, running({ status: "verifying", interactive: true })] });
      render();
      await waitFor(() => expect(screen.getByTestId("pane")).toHaveTextContent("ses-live"));
      await userEvent.click(within(bar()).getByRole("button", { name: /第 2 次/ }));
      expect(await screen.findByRole("menuitemradio", { name: /研究进行中/ })).toBeInTheDocument();
      expect(document.body).not.toHaveTextContent("核验");
    });
    it("lets the researcher choose which execution's conversation the frame shows, newest first, and keeps the choice in the address", async () => {
      const older = { ...episode, id: "ep-old", payload: { ...episode.payload, sessionId: "ses-old", runId: "run-old", createdAt: "2026-09-22T00:00:00Z", digestId: null } };
      mocks.listEpisodes.mockResolvedValue({ items: [episode, older] });
      render();
      await waitFor(() => expect(screen.getByTestId("pane")).toHaveTextContent("ses-one"));
      await userEvent.click(within(bar()).getByRole("button", { name: /第 2 次 · 9月29日/ }));
      const options = await screen.findAllByRole("menuitemradio");
      expect(options.map(option => option.textContent)).toEqual(["第 2 次 · 9月29日 · 研究结果", "第 1 次 · 9月22日 · 研究结果"]);
      expect(options[0]).toHaveAttribute("aria-checked", "true");
      await userEvent.click(options[1]);
      await waitFor(() => expect(screen.getByTestId("pane")).toHaveTextContent("project-one:ses-old")); expect(here()).toBe("/app/autopilot/agenda-one?execution=ep-old");
      await userEvent.click(within(bar()).getByRole("button", { name: /第 1 次/ }));
      await userEvent.click((await screen.findAllByRole("menuitemradio"))[0]);
      await waitFor(() => expect(screen.getByTestId("pane")).toHaveTextContent("ses-one")); expect(here()).toBe("/app/autopilot/agenda-one");
    });
    it("runs at once from the bar: no confirmation, no budget, the same request on a retry and a new one for a new run", async () => {
      // Each run ends at once here, so the button is a run again after it: what is asked is the request's identity.
      const ended = (id: string) => ({ episode: { ...episode, id, payload: { ...episode.payload, createdAt: "2026-10-01T02:00:00Z" } } });
      mocks.runAgendaNow.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(ended("manual-a")).mockResolvedValueOnce(ended("manual-b"));
      render(); await within(await barElement()).findByRole("button", { name: "立即运行" });
      await userEvent.click(within(bar()).getByRole("button", { name: "立即运行" }));
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      await userEvent.click(await screen.findByRole("button", { name: "重试操作" }));
      await waitFor(() => expect(mocks.runAgendaNow).toHaveBeenCalledTimes(2));
      expect(mocks.runAgendaNow.mock.calls[0]).toEqual(mocks.runAgendaNow.mock.calls[1]);
      await userEvent.click(within(bar()).getByRole("button", { name: "立即运行" }));
      await waitFor(() => expect(mocks.runAgendaNow).toHaveBeenCalledTimes(3));
      expect(mocks.runAgendaNow.mock.calls[2][1]).not.toEqual(mocks.runAgendaNow.mock.calls[0][1]);
    });
    it("goes to the new execution when a run is asked for: no earlier execution stays chosen", async () => {
      const older = { ...episode, id: "ep-old", payload: { ...episode.payload, sessionId: "ses-old", createdAt: "2026-09-22T00:00:00Z", digestId: null } };
      mocks.listEpisodes.mockResolvedValue({ items: [episode, older] });
      render("/app/autopilot/agenda-one?execution=ep-old"); await waitFor(() => expect(screen.getByTestId("pane")).toHaveTextContent("ses-old"));
      await userEvent.click(within(bar()).getByRole("button", { name: "立即运行" }));
      await waitFor(() => expect(here()).toBe("/app/autopilot/agenda-one"));
      expect(await screen.findByRole("region", { name: "任务对话" })).toHaveAttribute("data-task-pane", "waiting");
    });
    it("retries a refused stop with the same request", async () => {
      mocks.listEpisodes.mockResolvedValue({ items: [episode, running({ interactive: true })] });
      mocks.cancelEpisode.mockRejectedValueOnce(new Error("offline")); render(); await within(await barElement()).findByRole("button", { name: "停止本次" });
      await userEvent.click(within(bar()).getByRole("button", { name: "停止本次" }));
      await userEvent.click(await screen.findByRole("button", { name: "重试操作" }));
      await waitFor(() => expect(mocks.cancelEpisode).toHaveBeenCalledTimes(2)); expect(mocks.cancelEpisode.mock.calls[0]).toEqual(mocks.cancelEpisode.mock.calls[1]);
    });
    it("never starts a paused task on read, and a run is not offered for it", async () => {
      mocks.listAgendas.mockResolvedValue({ items: [paused()] });
      render(); expect(await within(await barElement()).findByRole("button", { name: "立即运行" })).toBeDisabled();
      expect(mocks.startAgenda).not.toHaveBeenCalled(); await choose(await barMenu(), "启用");
      await waitFor(() => expect(mocks.startAgenda).toHaveBeenCalledWith(agenda.id, 2));
    });
    it("keeps the bar's 「⋯」 to 研究进展, 编辑, 暂停 or 启用 and 删除 last and red", async () => {
      render(); await within(await barElement()).findByRole("button", { name: "更多" });
      await userEvent.click(await barMenu());
      expect((await screen.findAllByRole("menuitem")).map(item => item.textContent)).toEqual(["研究进展", "编辑", "暂停", "删除"]);
      expect(screen.getByRole("menuitem", { name: "删除" })).toHaveClass("text-danger");
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
    it("offers a finished one-time task a run and an edit, but not a pause it has no use for", async () => {
      mocks.listAgendas.mockResolvedValue({ items: [{ ...agenda, payload: { ...agenda.payload, scheduleState: "completed", nextRunAt: null, schedule: { kind: "once", date: "2026-09-29", time: "07:30", timeZone: "Asia/Shanghai" } } }] });
      render(); expect(await within(await barElement()).findByRole("button", { name: "立即运行" })).toBeEnabled();
      await userEvent.click(await barMenu());
      expect((await screen.findAllByRole("menuitem")).map(item => item.textContent)).toEqual(["研究进展", "编辑", "删除"]);
      expect(mocks.startAgenda).not.toHaveBeenCalled();
    });
    it("says in the bar what the task waits for, and gives the way to give it", async () => {
      const stopped = paused({ pauseReason: "问题已经回答", plannerStop: { kind: "needs_input", reason: "请补充原始数据表", at: "2026-10-01T00:00:00Z" },
        taskTypeState: { "evidence-update": { consecutiveFailures: 2, pausedAt: "2026-10-01T00:00:00Z" }, "literature-sentinel": { consecutiveFailures: 1 } } });
      mocks.listAgendas.mockResolvedValue({ items: [stopped] });
      render(); expect(await within(await barElement()).findByText("需要你补充：请补充原始数据表", { exact: false })).toBeInTheDocument();
      expect(bar()).toHaveTextContent("证据更新连续未能运行，已暂停"); expect(bar()).not.toHaveTextContent("文献追踪连续未能运行");
      expect(within(bar()).getByRole("button", { name: "补充材料并继续" })).toBeEnabled();
      // The planner's other stops are said without the button: nothing is asked of the researcher.
      cleanup(); mocks.listAgendas.mockResolvedValue({ items: [paused({ plannerStop: { kind: "answered", reason: "问题已经回答", at: "2026-10-01T00:00:00Z" } })] });
      render(); expect(await within(await barElement()).findByText("已暂停：问题已经回答")).toBeInTheDocument();
      expect(within(bar()).queryByRole("button", { name: "补充材料并继续" })).not.toBeInTheDocument();
    });
    it("continues a task that stopped for material when the material is added from the bar, without choosing anything again", async () => {
      const waiting = paused({ plannerStop: { kind: "needs_input", reason: "请补充原始数据表", at: "2026-10-01T00:00:00Z" } });
      mocks.listAgendas.mockResolvedValue({ items: [waiting] }); mocks.addAgendaMaterials.mockResolvedValue(waiting); mocks.startAgenda.mockResolvedValue(agenda);
      const file = new File(["x"], "data.csv", { type: "text/csv" }); files.pickFiles.mockResolvedValue([file]); files.uploadFilesToWorkspace.mockResolvedValue(["data.csv"]); files.sha256Hex.mockResolvedValue("a".repeat(64));
      render(); await userEvent.click(await within(await barElement()).findByRole("button", { name: "补充材料并继续" }));
      await waitFor(() => expect(mocks.addAgendaMaterials).toHaveBeenCalledWith("agenda-one", { sha256: ["a".repeat(64)] }));
      await waitFor(() => expect(mocks.startAgenda).toHaveBeenCalledWith("agenda-one", 2));
    });
    it("says a spent task budget is the task's own, that raising it is editing the task, and offers the caps there in 灵豆 and nowhere else", async () => {
      mocks.runAgendaNow.mockRejectedValueOnce(new WebApiError("This task's own daily budget is spent.", { status: 402, code: "autopilot_daily_budget_spent", retryAfterSeconds: 19 * 3600 + 60 }));
      render(); await userEvent.click(await within(await barElement()).findByRole("button", { name: "立即运行" }));
      const alert = await within(await barElement()).findByRole("alert");
      expect(alert).toHaveTextContent("这个任务近 24 小时的花费已达它自己设定的“每日上限”");
      expect(alert).toHaveTextContent("在“编辑任务”里调高每日上限"); expect(alert).toHaveTextContent(/请在约 19 小时 1 分后重试/);
      expect(alert).not.toHaveTextContent(/账户设定的用量上限|近 24 小时额度|额度开始释放/);
      await choose(await barMenu(), "编辑");
      const form = await screen.findByRole("dialog", { name: "编辑任务" });
      expect(within(form).getByLabelText("单次上限（灵豆）")).toHaveValue(8); expect(within(form).getByLabelText("每日上限（灵豆）")).toHaveValue(20);
      expect(form).not.toHaveTextContent("¥");
    });
    it("shows a task a budget refused as that, in the bar and not as an unexplained failure", async () => {
      mocks.listEpisodes.mockResolvedValue({ items: [{ ...episode, payload: { ...episode.payload, status: "failed", digestId: null, runId: null, sessionId: null, error: { code: "autopilot_daily_budget_spent" } } }] });
      render();
      const pane = await screen.findByRole("region", { name: "任务对话" });
      expect(pane).toHaveTextContent("任务预算已用完"); expect(pane).not.toHaveTextContent("未完成");
      await choose(await barMenu(), "编辑");
      expect(within(await screen.findByRole("dialog", { name: "编辑任务" })).getByLabelText("单次上限（灵豆）")).toBeVisible();
    });
    it("lays out the task for a narrow page with a way back to the list, and the list alone with no task", async () => {
      identity.width = 800;
      render("/app/autopilot/agenda-one?q=%E5%BF%83");
      expect(await within(await barElement()).findByRole("heading", { name: "心衰证据追踪", level: 1 })).toBeInTheDocument();
      expect(document.querySelector("[data-autopilot-layout]")).toHaveAttribute("data-autopilot-layout", "single");
      expect(document.querySelector("[data-task-list]")).toBeNull();
      expect(within(bar()).getByRole("link", { name: "定时任务" })).toHaveAttribute("href", "/app/autopilot?q=%E5%BF%83");
      cleanup(); identity.width = 800; render("/app/autopilot");
      expect(await screen.findByRole("link", { name: "心衰证据追踪" })).toBeInTheDocument();
      expect(document.querySelector("[data-task-main]")).toBeNull();
    });
    it("decides by the page's own width, again whenever it changes: list beside the conversation from 940, the list or the task alone below", async () => {
      render("/app/autopilot/agenda-one");
      const layout = () => document.querySelector("[data-autopilot-layout]")!.getAttribute("data-autopilot-layout");
      await within(await barElement()).findByRole("heading", { name: "心衰证据追踪" });
      expect(layout()).toBe("split"); expect(document.querySelector("[data-task-list]")).not.toBeNull();
      await resize(939); expect(layout()).toBe("single"); expect(document.querySelector("[data-task-list]")).toBeNull();
      expect(within(bar()).getByRole("heading", { name: "心衰证据追踪", level: 1 })).toBeInTheDocument();
      await resize(940); expect(layout()).toBe("split"); expect(document.querySelector("[data-task-list]")).not.toBeNull();
      // The pane keeps its place through the change: the frame is not asked for twice.
      expect(screen.getByTestId("pane")).toHaveTextContent("project-one:ses-one");
    });
    it("shows an empty main area beside the list when no task is open", async () => {
      render("/app/autopilot");
      expect(await screen.findByText("选择一项任务")).toBeInTheDocument();
    });
  });

  describe("研究进展", () => {
    it("is a record in a right drawer: what was found, what is unresolved and the material added", async () => {
      mocks.getResearchState.mockResolvedValue(state({ found: [{ statement: "替尔泊肽降低体重", check: "reproduced", sources: 3, date: "2026-10-01" }],
        unresolved: [{ kind: "unchecked", text: "年龄亚组" }, { kind: "not_rechecked", reason: "agenda_stopped", text: "肾病结局" }], materials: [{ sourceId: "src_a", name: "试验方案.pdf", addedAt: "2026-10-01T00:00:00Z", state: "reading" }] }));
      render(); await within(await barElement()).findByRole("button", { name: "更多" });
      expect(mocks.getResearchState).not.toHaveBeenCalled();
      await choose(await barMenu(), "研究进展");
      const drawer = await screen.findByRole("dialog", { name: "研究进展" });
      expect(await within(drawer).findByText("已复现：替尔泊肽降低体重")).toBeInTheDocument();
      expect(within(drawer).getByRole("region", { name: "已发现" })).toBeInTheDocument(); expect(within(drawer).getByRole("region", { name: "尚未解决" })).toHaveTextContent("尚未独立复核：年龄亚组");
      expect(within(drawer).getByRole("region", { name: "补充材料" })).toHaveTextContent("试验方案.pdf"); expect(within(drawer).getByText("正在读取")).toBeInTheDocument();
      expect(within(drawer).getByRole("button", { name: "添加材料" })).toBeInTheDocument(); expect(within(drawer).getByRole("button", { name: "从知识库选择" })).toBeInTheDocument();
      expect(within(drawer).queryByRole("textbox")).not.toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog", { name: "研究进展" })).not.toBeInTheDocument();
    });
    it("takes a document out of the question's material without touching the knowledge base", async () => {
      mocks.getResearchState.mockResolvedValue(state({ materials: [{ sourceId: "src_a", name: "试验方案.pdf", addedAt: "2026-10-01T00:00:00Z", state: "ready" }] }));
      render(); await choose(await within(await barElement()).findByRole("button", { name: "更多" }), "研究进展");
      await userEvent.click(await screen.findByRole("button", { name: "移除 试验方案.pdf" }));
      await waitFor(() => expect(mocks.removeAgendaMaterial).toHaveBeenCalledWith("agenda-one", "src_a"));
    });
    it("adds documents already in the knowledge base, and offers only those not yet added", async () => {
      files.listSources.mockResolvedValue({ items: [
        { id: "src_a", projectId: "project-one", revision: 1, payload: { paths: ["knowledge-base/已添加.pdf"], status: "complete" } },
        { id: "src_b", projectId: "project-one", revision: 1, payload: { paths: ["knowledge-base/新的.pdf"], status: "complete" } }], nextCursor: null });
      const withMaterial = { ...agenda, payload: { ...agenda.payload, materials: [{ sourceId: "src_a", addedAt: "2026-10-04T01:00:00Z" }] } };
      mocks.listAgendas.mockResolvedValue({ items: [withMaterial] });
      render(); await choose(await within(await barElement()).findByRole("button", { name: "更多" }), "研究进展");
      await userEvent.click(await screen.findByRole("button", { name: "从知识库选择" }));
      const dialog = await screen.findByRole("dialog", { name: "从知识库添加资料" });
      expect(files.listSources).toHaveBeenCalledWith("project-one", expect.objectContaining({ state: "ready" }));
      expect(await within(dialog).findByText("新的.pdf")).toBeInTheDocument(); expect(within(dialog).queryByText("已添加.pdf")).not.toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "添加到这个任务" })).toBeDisabled();
      await userEvent.click(within(dialog).getByRole("checkbox")); await userEvent.click(within(dialog).getByRole("button", { name: "添加到这个任务" }));
      await waitFor(() => expect(mocks.addAgendaMaterials).toHaveBeenCalledWith(agenda.id, { sourceIds: ["src_b"] }));
      expect(screen.queryByRole("dialog", { name: "从知识库添加资料" })).not.toBeInTheDocument();
    });
    it("says above the sections how the last execution came out, and that the task needs material when it does", async () => {
      const stopped = paused({ plannerStop: { kind: "needs_input", reason: "请补充原始数据表", at: "2026-10-01T00:00:00Z" } });
      mocks.listAgendas.mockResolvedValue({ items: [stopped] });
      mocks.getResearchState.mockResolvedValue(state({ found: [{ statement: "获益一致", check: "stands", sources: 2, date: "2026-09-28" }] }));
      render(); await choose(await within(await barElement()).findByRole("button", { name: "更多" }), "研究进展");
      const drawer = await screen.findByRole("dialog", { name: "研究进展" });
      expect(await within(drawer).findByText(/上次 9月29日 \d{2}:\d{2} · 研究结果 · 需要你补充/)).toBeInTheDocument();
    });
    it("holds a long unresolved conclusion to three lines with 展开", async () => {
      const long = "这是一条很长的待复核结论。".repeat(40);
      mocks.getResearchState.mockResolvedValue(state({ unresolved: [{ kind: "check_unavailable", text: long }] }));
      const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight"); const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get() { return this.classList.contains("line-clamp-3") ? 300 : 0; } });
      Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return this.classList.contains("line-clamp-3") ? 72 : 0; } });
      try {
        render(); await choose(await within(await barElement()).findByRole("button", { name: "更多" }), "研究进展");
        const drawer = await screen.findByRole("dialog", { name: "研究进展" });
        const item = await within(drawer).findByText(new RegExp(`^复核未能进行：${long.slice(0, 8)}`));
        expect(item).toHaveClass("line-clamp-3");
        await userEvent.click(within(drawer).getByRole("button", { name: "展开" }));
        expect(item).not.toHaveClass("line-clamp-3");
      } finally {
        if (scroll) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scroll); else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
        if (client) Object.defineProperty(HTMLElement.prototype, "clientHeight", client); else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
      }
    });
    it("reads each finding by its own check, and what is unresolved by its own kind", async () => {
      mocks.getResearchState.mockResolvedValue(state({
        found: [{ statement: "获益在亚组中一致", check: "stands", sources: 2, date: "2026-09-28" }, { statement: "死亡率下降 30%", check: "refuted", sources: 2, date: "2026-09-27" }, { statement: "已重算的结论", check: "reproduced", sources: 1, date: "2026-09-27" }],
        unresolved: [{ kind: "question", text: "亚组 B 的结果呢？" }, { kind: "not_run", date: "2026-09-29" }, { kind: "unchecked", text: "无酮症酸中毒增加" }, { kind: "check_unavailable", text: "住院减少" }, { kind: "weakened", text: "HFpEF 获益更大" },
          { kind: "not_rechecked", reason: "agenda_stopped", text: "停止时尚未开始" }, { kind: "not_rechecked", reason: "verification_budget_unavailable", text: "单次上限太小" }, { kind: "not_rechecked", reason: "verification_cap", text: "超出条数" }, { kind: "not_rechecked", reason: "agenda_paused", text: "暂停时没做" }] }));
      render(); await choose(await within(await barElement()).findByRole("button", { name: "更多" }), "研究进展");
      const drawer = await screen.findByRole("dialog", { name: "研究进展" });
      const found = await within(drawer).findByRole("region", { name: "已发现" });
      expect(found).toHaveTextContent("独立复核后仍成立：获益在亚组中一致"); expect(found).toHaveTextContent("已被推翻：死亡率下降 30%"); expect(found).toHaveTextContent("已复现：已重算的结论");
      const open = within(drawer).getByRole("region", { name: "尚未解决" });
      expect(open).toHaveTextContent("你的问题：亚组 B 的结果呢？"); expect(open).toHaveTextContent("最近一次研究没有完成，结果未知。");
      expect(open).toHaveTextContent("尚未独立复核：无酮症酸中毒增加"); expect(open).toHaveTextContent("复核未能进行：住院减少"); expect(open).toHaveTextContent("被复核削弱：HFpEF 获益更大");
      expect(open).toHaveTextContent("任务已停止，未做独立复核：停止时尚未开始"); expect(open).toHaveTextContent("任务已暂停，未做独立复核：暂停时没做");
      expect(open).toHaveTextContent("单次上限不够再支付一次复核，未安排独立复核：单次上限太小"); expect(open).toHaveTextContent("超出每次研究复核的条数，未安排独立复核：超出条数");
      expect(drawer).not.toHaveTextContent("运行记录"); expect(drawer).not.toHaveTextContent("agenda_stopped");
      expect(mocks.getResearchState).toHaveBeenCalledWith(agenda.id);
    });
    it("shows no findings section for a question that has found nothing, and still offers to add material", async () => {
      render(); await choose(await within(await barElement()).findByRole("button", { name: "更多" }), "研究进展");
      const drawer = await screen.findByRole("dialog", { name: "研究进展" });
      await within(drawer).findByRole("region", { name: "补充材料" });
      expect(within(drawer).queryByRole("region", { name: "已发现" })).not.toBeInTheDocument(); expect(within(drawer).queryByRole("region", { name: "尚未解决" })).not.toBeInTheDocument();
      expect(within(drawer).getByRole("button", { name: "添加材料" })).toBeEnabled();
    });
    it("offers a retry when the question's progress cannot be read, and the rest of the task still shows", async () => {
      mocks.getResearchState.mockRejectedValueOnce(new Error("offline")); render();
      await choose(await within(await barElement()).findByRole("button", { name: "更多" }), "研究进展");
      const drawer = await screen.findByRole("dialog", { name: "研究进展" });
      expect(await within(drawer).findByText(/研究进展暂不可用/)).toBeInTheDocument(); expect(screen.getByTestId("pane")).toHaveTextContent("ses-one");
      await userEvent.click(within(drawer).getByRole("button", { name: /重试/ }));
      expect(await within(drawer).findByRole("region", { name: "补充材料" })).toBeInTheDocument();
    });
    it("adds an upload as material by the digest of what was uploaded: through the knowledge base, never a plan to approve", async () => {
      const file = new File(["age,n"], "年龄分布.csv", { type: "text/csv" });
      files.pickFiles.mockResolvedValue([file]); files.uploadFilesToWorkspace.mockResolvedValue(["knowledge-base/年龄分布.csv"]); files.sha256Hex.mockResolvedValue("a".repeat(64));
      mocks.addAgendaMaterials.mockResolvedValue({ ...agenda, revision: 3, payload: { ...agenda.payload, materials: [{ sourceId: "src_a", addedAt: "2026-10-04T01:00:00Z" }] } });
      render(); await choose(await within(await barElement()).findByRole("button", { name: "更多" }), "研究进展");
      await userEvent.click(await within(await screen.findByRole("dialog", { name: "研究进展" })).findByRole("button", { name: "添加材料" }));
      await waitFor(() => expect(mocks.addAgendaMaterials).toHaveBeenCalledWith(agenda.id, { sha256: ["a".repeat(64)] }));
      expect(files.uploadFilesToWorkspace).toHaveBeenCalledWith([file], "knowledge-base", "base");
      expect(mocks.startAgenda).not.toHaveBeenCalled(); expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      await waitFor(() => expect(mocks.getResearchState.mock.calls.length).toBeGreaterThan(1));
    });
    it("says a format the knowledge base cannot read is not added, and adds nothing", async () => {
      files.pickFiles.mockResolvedValue([new File(["x"], "talk.mp4", { type: "video/mp4" })]);
      render(); await choose(await within(await barElement()).findByRole("button", { name: "更多" }), "研究进展");
      await userEvent.click(await within(await screen.findByRole("dialog", { name: "研究进展" })).findByRole("button", { name: "添加材料" }));
      expect(await within(bar()).findByRole("alert")).toHaveTextContent("没有添加：talk.mp4");
      expect(files.uploadFilesToWorkspace).not.toHaveBeenCalled(); expect(mocks.addAgendaMaterials).not.toHaveBeenCalled();
    });
  });

  describe("what the researcher is told of a task that did not simply run", () => {
    it("says why a task whose cap cannot fund a run was paused, in the sentence the edit form gives, with its amounts in 灵豆", async () => {
      const tooSmall = paused({ maxEpisodeCny: 0.5, pauseReason: "x", pauseCode: "autopilot_episode_budget_too_small" });
      mocks.listAgendas.mockResolvedValue({ items: [tooSmall] });
      render(); const header = await barElement();
      expect(header).toHaveTextContent(/已暂停：“单次上限”不能低于 \d+\.\d{2} 灵豆/); expect(header).toHaveTextContent("在“编辑任务”里调高单次上限即可");
      expect(header).not.toHaveTextContent("¥"); expect(header).not.toHaveTextContent("autopilot_episode_budget_too_small");
      // That cap is the reason, so the edit dialog asks for it, below its floor, in 灵豆.
      await choose(await barMenu(), "编辑");
      const form = await screen.findByRole("dialog", { name: "编辑任务" });
      expect(within(form).getByLabelText("单次上限（灵豆）")).toBeVisible(); expect(within(form).getByText(/单次上限不能低于 \d+\.?\d* 灵豆/)).toBeInTheDocument();
      expect(within(form).getByRole("button", { name: "保存修改" })).toBeDisabled(); expect(form).not.toHaveTextContent("¥");
    });
    it("says the weekly cap as the week's, as it says the daily one", async () => {
      mocks.runAgendaNow.mockRejectedValueOnce(new WebApiError("This task's own weekly budget is spent.", { status: 402, code: "autopilot_weekly_budget_spent", retryAfterSeconds: 3 * 86400 }));
      render(); await userEvent.click(await within(await barElement()).findByRole("button", { name: "立即运行" }));
      const alert = await within(bar()).findByRole("alert");
      expect(alert).toHaveTextContent("这个任务近 7 天的花费已达它自己设定的“每周上限”"); expect(alert).toHaveTextContent("在“编辑任务”里调高每周上限"); expect(alert).toHaveTextContent(/请在约 3 天后重试/);
      expect(alert).not.toHaveTextContent(/账户设定的用量上限|近 7 天额度|额度开始释放/);
    });
    // A simulated wallet refuses under its own code, and a run it holds back waits, and reads, exactly as one a real wallet holds back.
    it.each([
      ["credits_exhausted", "waiting", "等待余额"], ["simulated_credits_exhausted", "waiting", "等待余额"],
      ["credits_exhausted", "exhausted", "余额不足"], ["simulated_credits_exhausted", "exhausted", "余额不足"],
      ["runtime_busy", "waiting", "等待运行资源"], ["runtime_busy", "exhausted", "运行资源暂不可用"],
    ])("says a run held back by %s (%s) is “%s”", async (code, status, label) => {
      mocks.listEpisodes.mockResolvedValue({ items: [episode, running({ id: "held", status: "queued", runId: null, sessionId: null, resourceDeferrals: { episode: { code, status } } })] });
      render(); const pane = await screen.findByRole("region", { name: "任务对话" });
      await waitFor(() => expect(pane).toHaveTextContent(label));
      for (const other of ["等待余额", "余额不足", "等待运行资源", "运行资源暂不可用"].filter(each => each !== label)) expect(screen.queryByText(other)).not.toBeInTheDocument();
    });
  });

  describe("reading for as long as the page is open", () => {
    it("keeps reading past five minutes, every thirty seconds when nothing runs and every five while an execution is on its way", async () => {
      fakeClock(); render(); await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const reads = () => mocks.listAgendas.mock.calls.length;
      const idle = reads();
      await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
      expect(reads() - idle).toBeGreaterThanOrEqual(19); expect(reads() - idle).toBeLessThanOrEqual(21);
      // An execution appears: from the next read on, the page looks every five seconds, for far longer than five minutes.
      mocks.listEpisodes.mockResolvedValue({ items: [episode, running({ interactive: true })] });
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      const before = reads();
      await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
      expect(reads() - before).toBeGreaterThanOrEqual(115);
    });
    it("does not read while the document is hidden, and reads at once when it is back", async () => {
      fakeClock(); render(); await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      const before = mocks.listAgendas.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
      expect(mocks.listAgendas.mock.calls.length).toBe(before);
      hidden.mockReturnValue(false);
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(0); });
      expect(mocks.listAgendas.mock.calls.length).toBeGreaterThan(before);
    });
    it("reads an older task's own history outside the project-wide newest 100", async () => {
      const others = Array.from({ length: 100 }, (_, index) => ({ ...episode, id: `other-${index}`, payload: { ...episode.payload, agendaId: "other-task" } }));
      mocks.listEpisodes.mockImplementation((_project: string, id?: string) => Promise.resolve({ items: id === agenda.id ? [episode] : others }));
      render(); await waitFor(() => expect(screen.getByTestId("pane")).toHaveTextContent("ses-one"));
      expect(mocks.listEpisodes).toHaveBeenCalledWith("project-one", agenda.id);
    });
    it("does not replace a newly selected task's history with a late response of the previous one", async () => {
      let finish!: (value: unknown) => void;
      mocks.listAgendas.mockResolvedValue({ items: [agenda, { ...agenda, id: "second", payload: { ...agenda.payload, title: "第二个任务" } }] });
      mocks.listEpisodes.mockImplementation((_project: string, id?: string) => id === agenda.id ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ items: [] }));
      render("/app/autopilot/agenda-one"); await screen.findByRole("link", { name: "第二个任务" });
      await userEvent.click(screen.getByRole("link", { name: "第二个任务" }));
      await act(async () => { finish({ items: [episode] }); });
      expect(await screen.findByRole("region", { name: "任务对话" })).toHaveAttribute("data-task-pane", "never-run"); expect(screen.getByTestId("pane")).toHaveTextContent("none");
    });
  });

  describe("新建 and 编辑", () => {
    it("is a short dialog: what to keep doing and how often, with no budget to fill in", async () => {
      render("/app/autopilot"); await userEvent.click(await screen.findByRole("button", { name: "新建" }));
      const dialog = await screen.findByRole("dialog", { name: "新建任务" });
      expect(within(dialog).getByLabelText("任务指令")).toBeVisible(); expect(within(dialog).getByLabelText("重复")).toBeVisible(); expect(within(dialog).getByLabelText("时间")).toBeVisible();
      expect(within(dialog).queryByLabelText(/上限/)).not.toBeInTheDocument(); expect(dialog).not.toHaveTextContent(/¥|上限/);
      // The zone, the name and the task types stay under one fold; the zone is said beside it.
      const advanced = within(dialog).getByText("高级设置").closest("details")!; expect(advanced).not.toHaveAttribute("open");
      await userEvent.click(within(dialog).getByText("高级设置")); expect(within(dialog).getByLabelText("时区")).toBeVisible();
    });
    it("offers 从推荐开始 under the form: six templates that fill it, creating nothing", async () => {
      render("/app/autopilot"); await userEvent.click(await screen.findByRole("button", { name: "新建" }));
      const dialog = await screen.findByRole("dialog", { name: "新建任务" });
      const section = within(dialog).getByRole("region", { name: "从推荐开始" });
      expect(within(section).getAllByRole("button")).toHaveLength(RECOMMENDATIONS.length);
      await userEvent.click(within(section).getByRole("button", { name: "指南更新周报" }));
      await waitFor(() => expect((within(dialog).getByLabelText("任务指令") as HTMLTextAreaElement).value).toContain("指南"));
      expect(within(dialog).getByLabelText("重复")).toHaveValue("weekly"); expect(mocks.createAgenda).not.toHaveBeenCalled();
      expect(within(dialog).getByLabelText("任务指令")).toHaveFocus();
    });
    it("creates and enables a weekly task without altering its raw prompt, then opens it", async () => {
      render("/app/autopilot"); await userEvent.click(await screen.findByRole("button", { name: "新建" }));
      const form = await screen.findByRole("dialog", { name: "新建任务" });
      const raw = "  肾病与心衰\n保留换行与全部指令  ";
      fireEvent.change(within(form).getByLabelText("任务指令"), { target: { value: raw } });
      await userEvent.selectOptions(within(form).getByLabelText("重复"), "weekly");
      fireEvent.change(within(form).getByLabelText("时间"), { target: { value: "09:45" } });
      await userEvent.click(within(form).getByText("高级设置"));
      fireEvent.change(within(form).getByLabelText("时区"), { target: { value: "America/New_York" } });
      await userEvent.click(within(form).getByRole("button", { name: "创建并启用" }));
      await waitFor(() => expect(mocks.createAgenda).toHaveBeenCalledWith(expect.objectContaining({ prompt: raw, schedule: { kind: "weekly", weekdays: [1], time: "09:45", timeZone: "America/New_York" } })));
      expect(mocks.startAgenda).toHaveBeenCalledWith(agenda.id, 2);
      await waitFor(() => expect(here()).toBe("/app/autopilot/agenda-one")); expect(screen.queryByRole("dialog", { name: "新建任务" })).not.toBeInTheDocument();
    });
    it("keeps a successfully created task when enabling fails and retries only enabling", async () => {
      mocks.startAgenda.mockRejectedValueOnce(new Error("offline")); render("/app/autopilot");
      await userEvent.click(await screen.findByRole("button", { name: "新建" }));
      await userEvent.type(await screen.findByLabelText("任务指令"), "保留这个任务");
      await userEvent.click(screen.getByRole("button", { name: "创建并启用" }));
      expect(await screen.findByText(/任务已创建，启用未成功/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "重试启用" }));
      await waitFor(() => expect(mocks.startAgenda).toHaveBeenCalledTimes(2)); expect(mocks.createAgenda).toHaveBeenCalledTimes(1);
    });
    it("edits a one-time schedule from the bar and handles revision conflicts visibly", async () => {
      mocks.updateAgenda.mockRejectedValueOnce({ status: 409 }); render();
      await choose(await within(await barElement()).findByRole("button", { name: "更多" }), "编辑");
      const form = await screen.findByRole("dialog", { name: "编辑任务" });
      await userEvent.selectOptions(within(form).getByLabelText("重复"), "once");
      fireEvent.change(within(form).getByLabelText("日期"), { target: { value: "2026-12-01" } });
      await userEvent.click(within(form).getByRole("button", { name: "保存修改" }));
      await waitFor(() => expect(mocks.updateAgenda).toHaveBeenCalledWith(agenda.id, expect.objectContaining({ expectedRevision: 2, schedule: { kind: "once", date: "2026-12-01", time: "07:30", timeZone: "Asia/Shanghai" } })));
      expect(await screen.findByText(/任务已被更新/)).toBeInTheDocument(); expect(mocks.getAgenda).toHaveBeenCalledWith(agenda.id);
    });
    it("keeps the dialog open through create and enable despite close or Escape", async () => {
      let finish!: (value: unknown) => void;
      mocks.createAgenda.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); render("/app/autopilot");
      await userEvent.click(await screen.findByRole("button", { name: "新建" })); await userEvent.type(await screen.findByLabelText("任务指令"), "继续完成创建并启用");
      await userEvent.click(screen.getByRole("button", { name: "创建并启用" }));
      await userEvent.click(screen.getByRole("button", { name: "关闭" })); await userEvent.keyboard("{Escape}");
      expect(screen.getByRole("dialog", { name: "新建任务" })).toBeInTheDocument();
      await act(async () => { finish(agenda); });
      await waitFor(() => expect(mocks.startAgenda).toHaveBeenCalledWith(agenda.id, 2)); expect(screen.queryByRole("dialog", { name: "新建任务" })).not.toBeInTheDocument();
      await waitFor(() => expect(here()).toBe("/app/autopilot/agenda-one"));
    });
    it("ignores late task creation after the project is switched", async () => {
      let finish!: (value: unknown) => void;
      mocks.createAgenda.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); render("/app/autopilot");
      await userEvent.click(await screen.findByRole("button", { name: "新建" })); await userEvent.type(await screen.findByLabelText("任务指令"), "创建后切换项目");
      await userEvent.click(screen.getByRole("button", { name: "创建并启用" }));
      await act(async () => { identity.projectId = "project-three"; useProjectStore.setState({ currentId: "project-three" }); });
      await act(async () => { finish(agenda); });
      expect(mocks.startAgenda).not.toHaveBeenCalled(); expect(screen.queryByRole("dialog", { name: "新建任务" })).not.toBeInTheDocument();
    });
  });
});
