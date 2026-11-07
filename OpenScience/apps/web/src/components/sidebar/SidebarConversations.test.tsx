import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, useLocation } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { WEB_SESSION_STARTED_EVENT, sessionGeneration } from "@/lib/sessionLifecycle";
import { SidebarConversations } from "./SidebarConversations";

const mocks = vi.hoisted(() => ({ listProjects: vi.fn(), list: vi.fn(), open: vi.fn(), me: vi.fn(), actor: vi.fn(), projects: vi.fn(), runs: vi.fn(), studies: vi.fn(), select: vi.fn(), currentId: "default" }));
vi.mock("@/lib/geoClient", () => ({ listGeoProjects: mocks.listProjects }));
vi.mock("@/lib/geoNativeClient", () => ({ listGeoConversations: mocks.list, openGeoConversation: mocks.open }));
vi.mock("@/lib/apiClient", async original => ({ ...await original<typeof import("@/lib/apiClient")>(), fetchWebMe: mocks.me, getVerifiedWebActor: mocks.actor, listWebProjects: mocks.projects, listWebAgentRuns: mocks.runs }));
vi.mock("@/lib/projects", () => ({ useProjectStore: Object.assign((selector: (state: { currentId: string }) => unknown) => selector({ currentId: mocks.currentId }), { getState: () => ({ select: mocks.select, currentId: mocks.currentId }) }) }));
vi.mock("@/lib/vcrClient", () => ({ getVcrHome: mocks.studies }));
vi.mock("./ProjectBrowser", () => ({ ProjectBrowser: ({ studyScope }: { studyScope?: string }) => <div>{studyScope ? `研究 ${studyScope}` : "项目管理"}</div> }));
const project = { id: "g1", projectId: "p1", name: "GEO", access: { owner: true, abilities: ["read", "run", "edit"] } };
const descriptor = { sessionId: "new1", projectId: "p1", scope: { kind: "geo", geoProjectId: "g1", sessionId: "new1" } };
const run = (id: string, title: string, at: string) => ({ id, sessionId: id, title, startedAt: at, finishedAt: at, createdAt: at });
function Probe() { const location = useLocation(); return <><output>{location.pathname}</output><Link to="/app/geo/g2">换页面</Link></>; }
function setup(initial = "/app/geo/g1/visibility", geoId: string | null = "g1", vcr = false) { return render(<MemoryRouter initialEntries={[initial]}><SidebarConversations geoId={geoId} geo vcr={vcr} onCurrentModule={() => {}} /><Probe /></MemoryRouter>); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => {
  sessionStorage.clear(); vi.clearAllMocks(); mocks.currentId = "default"; mocks.me.mockResolvedValue({ user: { id: "u" } }); mocks.actor.mockImplementation(() => ({ generation: sessionGeneration(), tenantId: "t", userId: "u", csrf: "x" }));
  mocks.listProjects.mockResolvedValue([project]); mocks.list.mockResolvedValue({ items: [{ sessionId: "s1", title: "First", createdAt: "2026-01-01T00:00:00Z" }], nextCursor: null });
  mocks.projects.mockResolvedValue([]); mocks.runs.mockResolvedValue([]); mocks.studies.mockResolvedValue({ studies: [] }); mocks.select.mockImplementation(async (_id, callback) => callback?.());
});
it("changes scope without navigation, merges and sorts all projects, searches, and exposes management", async () => {
  mocks.projects.mockResolvedValue([{ id: "p1", name: "GEO owner" }, { id: "p2", name: "Paper" }]);
  mocks.runs.mockImplementation(async ({ projectId }: { projectId: string }) => projectId === "p2" ? [run("normal", "Newer", "2026-02-01T00:00:00Z")] : []);
  setup(); const user = userEvent.setup(); await screen.findByText("First");
  await user.click(screen.getByRole("button", { name: "对话范围：本项目" })); await user.click(screen.getByRole("menuitemradio", { name: "全部最近" }));
  expect(screen.getByText("/app/geo/g1/visibility")).toBeInTheDocument();
  await screen.findByText("Newer"); await waitFor(() => expect(screen.queryByText("正在读取对话")).not.toBeInTheDocument());
  const buttons = screen.getAllByRole("button"); expect(buttons.indexOf(screen.getByText("Newer").closest("button")!)).toBeLessThan(buttons.indexOf(screen.getByText("First").closest("button")!));
  await user.type(screen.getByRole("searchbox", { name: "搜索最近对话" }), "Paper"); expect(screen.queryByText("First")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "管理项目与对话" })); expect(screen.getByText("项目管理")).toBeInTheDocument();
  expect(mocks.select).not.toHaveBeenCalled();
});
it("keeps an owner's unrelated conversation while deduplicating the associated GEO session", async () => {
  mocks.projects.mockResolvedValue([{ id: "p1", name: "Owner" }]);
  mocks.runs.mockResolvedValue([run("s1", "Duplicate", "2026-01-02"), run("personal", "Personal", "2026-01-03")]);
  setup(); const user = userEvent.setup(); await screen.findByText("First");
  await user.click(screen.getByRole("button", { name: "对话范围：本项目" })); await user.click(screen.getByRole("menuitemradio", { name: "全部最近" }));
  expect(await screen.findByText("Personal")).toBeInTheDocument(); expect(screen.queryByText("Duplicate")).not.toBeInTheDocument();
});
it("loads more pages and reports partial failures", async () => {
  mocks.listProjects.mockResolvedValue([project, { ...project, id: "g2", name: "Other" }]);
  mocks.list.mockImplementation(async (id: string, cursor?: string) => id === "g2" ? Promise.reject(new Error()) : cursor ? { items: [{ sessionId: "s2", title: "Second", createdAt: null }], nextCursor: null } : { items: [{ sessionId: "s1", title: "First", createdAt: null }], nextCursor: "cursor" });
  setup(); const user = userEvent.setup(); await screen.findByText("First");
  await user.click(screen.getByRole("button", { name: "对话范围：本项目" })); await user.click(screen.getByRole("menuitemradio", { name: "全部最近" }));
  await screen.findByText(/Other.*暂未完整显示/); await user.click(await screen.findByRole("button", { name: "加载更多：GEO" })); expect(await screen.findByText("Second")).toBeInTheDocument();
});
it("explains incomplete owner history when the GEO list fails", async () => {
  mocks.projects.mockResolvedValue([{ id: "p1", name: "Owner" }]);
  mocks.runs.mockResolvedValue([run("personal", "Personal", "2026-01-03")]);
  mocks.list.mockRejectedValue(new Error("unavailable"));
  setup(); const user = userEvent.setup(); await screen.findByText(/GEO 和个人会话暂未完整显示/);
  await user.click(screen.getByRole("button", { name: "对话范围：本项目" })); await user.click(screen.getByRole("menuitemradio", { name: "全部最近" }));
  expect(await screen.findByText(/GEO 和个人会话暂未完整显示/)).toBeInTheDocument();
  expect(screen.queryByText("Personal")).not.toBeInTheDocument(); expect(screen.getByRole("button", { name: "重试读取" })).toBeInTheDocument();
});
it("creates a real conversation and opens its exact descriptor", async () => {
  mocks.open.mockResolvedValue(descriptor); setup(); const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "新建本项目对话" })); expect(await screen.findByText("/app/geo/g1/chat/new1")).toBeInTheDocument();
  expect(mocks.open.mock.calls[0][1]).toMatchObject({ kind: "new", requestId: expect.any(String) });
});
it("reuses the request id after an unknown outcome", async () => {
  mocks.open.mockRejectedValue(new Error("unknown")); setup(); const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "新建本项目对话" })); await screen.findByRole("alert");
  await user.click(screen.getByRole("button", { name: "新建本项目对话" })); await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(2));
  expect(mocks.open.mock.calls[0][1]).toEqual(mocks.open.mock.calls[1][1]);
});
it("replays a pending request after the component is recreated", async () => {
  mocks.open.mockRejectedValue(new Error("unknown")); const first = setup(); const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "新建本项目对话" })); await screen.findByRole("alert");
  const request = mocks.open.mock.calls[0][1]; first.unmount(); setup();
  await user.click(await screen.findByRole("button", { name: "新建本项目对话" }));
  await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(2)); expect(mocks.open.mock.calls[1][1]).toEqual(request);
});
it("does not navigate on a late creation after the route changes", async () => {
  const pending = deferred<typeof descriptor>(); mocks.open.mockReturnValue(pending.promise); setup(); const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "新建本项目对话" })); await user.click(screen.getByRole("link", { name: "换页面" }));
  await act(async () => pending.resolve(descriptor)); expect(screen.getByText("/app/geo/g2")).toBeInTheDocument();
});
it("keeps an in-flight creation live across a settled refresh", async () => {
  const pending = deferred<typeof descriptor>(); mocks.open.mockReturnValue(pending.promise); setup(); const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "新建本项目对话" }));
  act(() => window.dispatchEvent(new Event("evimed:conversation-settled")));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
  await act(async () => pending.resolve(descriptor)); expect(await screen.findByText("/app/geo/g1/chat/new1")).toBeInTheDocument();
});
it("hides old account entries immediately on a session boundary", async () => {
  setup(); await screen.findByText("First"); const pending = deferred<never>(); mocks.listProjects.mockReturnValue(pending.promise);
  act(() => window.dispatchEvent(new Event(WEB_SESSION_STARTED_EVENT)));
  expect(screen.queryByText("First")).not.toBeInTheDocument(); expect(screen.getByText("正在读取对话")).toBeInTheDocument();
});
it("does not offer creation to a viewer and opens history without creating", async () => {
  mocks.listProjects.mockResolvedValue([{ ...project, access: { owner: false, abilities: ["read"] } }]); setup(); const user = userEvent.setup();
  await user.click(await screen.findByText("First")); expect(screen.getByText("/app/geo/g1/chat/s1")).toBeInTheDocument(); expect(mocks.open).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "新建本项目对话" })).not.toBeInTheDocument();
});
it("opens an ordinary entry through its own project", async () => {
  mocks.projects.mockResolvedValue([{ id: "p2", name: "Paper" }]); mocks.runs.mockResolvedValue([run("s2", "Paper chat", "2026-01-01")]);
  setup("/app/files", null); await userEvent.click(await screen.findByText("Paper chat"));
  expect(mocks.select).toHaveBeenCalledWith("p2", expect.any(Function), expect.any(AbortSignal));
  expect(within(screen.getByLabelText("对话")).queryByRole("button", { name: "对话范围：本项目" })).not.toBeInTheDocument();
});


it("does not treat an explicit null VCR primary as the oldest session", async () => {
  mocks.projects.mockResolvedValue([{ id: "p2", name: "Study" }]);
  mocks.studies.mockResolvedValue({ studies: [{ id: "study1", projectId: "p2", originatingSessionId: null }] });
  mocks.runs.mockResolvedValue([run("oldest", "Old session", "2026-01-01")]);
  setup("/app/files", null, true); await userEvent.click(await screen.findByText("Old session"));
  expect(screen.getByText("/app/chat/oldest")).toBeInTheDocument();
});
it("refreshes history when the conversation settles", async () => {
  setup(); await screen.findByText("First");
  mocks.list.mockResolvedValue({ items: [{ sessionId: "s1", title: "Renamed", createdAt: null }], nextCursor: null });
  act(() => window.dispatchEvent(new Event("evimed:conversation-settled")));
  expect(await screen.findByText("Renamed")).toBeInTheDocument();
});

it("opens the selected ordinary session when a settled refresh arrives during project selection", async () => {
  const gate = deferred<void>();
  mocks.projects.mockResolvedValue([{ id: "p2", name: "Paper" }]);
  mocks.runs.mockResolvedValue([run("s2", "Paper chat", "2026-01-01")]);
  mocks.select.mockImplementation(async (_id, callback, signal: AbortSignal) => { await gate.promise; if (!signal.aborted) callback(); });
  setup("/app/files", null); await userEvent.click(await screen.findByText("Paper chat"));
  act(() => window.dispatchEvent(new Event("evimed:conversation-settled")));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
  await act(async () => gate.resolve());
  expect(await screen.findByText("/app/chat/s2")).toBeInTheDocument();
});


it("does not schedule later project reads after leaving the page", async () => {
  const gate = deferred<{ items: []; nextCursor: null }>();
  mocks.listProjects.mockResolvedValue(Array.from({ length: 6 }, (_, i) => ({ ...project, id: `g${i}`, name: `G${i}` })));
  mocks.list.mockReturnValue(gate.promise);
  const view = setup("/app/files", null); await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3));
  view.unmount();
  await act(async () => gate.resolve({ items: [], nextCursor: null }));
  expect(mocks.list).toHaveBeenCalledTimes(3);
});
it("keeps the loaded list during a result tab navigation without another fetch", async () => {
  render(<MemoryRouter initialEntries={["/app/geo/g1/visibility"]}><SidebarConversations geoId="g1" geo vcr={false} onCurrentModule={() => {}} /><Link to="/app/geo/g1/accuracy?view=latest">结果页</Link></MemoryRouter>);
  await screen.findByText("First");
  const calls = mocks.list.mock.calls.length;
  await userEvent.click(screen.getByRole("link", { name: "结果页" }));
  expect(screen.getByText("First")).toBeInTheDocument();
  expect(screen.queryByText("正在读取对话")).not.toBeInTheDocument();
  expect(mocks.list).toHaveBeenCalledTimes(calls);
});
it("keeps the loaded list visible until a settled refresh finishes", async () => {
  setup(); await screen.findByText("First");
  const pending = deferred<{ items: { sessionId: string; title: string; createdAt: null }[]; nextCursor: null }>();
  mocks.list.mockReturnValue(pending.promise);
  act(() => window.dispatchEvent(new Event("evimed:conversation-settled")));
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
  expect(screen.getByText("First")).toBeInTheDocument();
  expect(screen.queryByText("正在读取对话")).not.toBeInTheDocument();
  await act(async () => pending.resolve({ items: [{ sessionId: "s2", title: "Updated", createdAt: null }], nextCursor: null }));
  await screen.findByText("Updated");
  expect(screen.queryByText("First")).not.toBeInTheDocument();
});

async function refreshConversations() {
  act(() => window.dispatchEvent(new Event("evimed:conversation-settled")));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
}
it("retains a failed source on refresh after verifying the same actor and readable project", async () => {
  setup(); await screen.findByText("First");
  mocks.list.mockRejectedValue(new Error("Temporary outage"));
  await refreshConversations();
  expect(await screen.findByRole("alert")).toHaveTextContent("暂未完整显示");
  expect(screen.getByText("First")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "重试读取" })).toBeInTheDocument();
});
it("retains failed ordinary project rows while replacing successful source rows", async () => {
  mocks.projects.mockResolvedValue([{ id: "p2", name: "Paper" }, { id: "p3", name: "Other" }]);
  mocks.runs.mockImplementation(async ({ projectId }: { projectId: string }) => [run(projectId, projectId === "p2" ? "Saved paper" : "Old other", "2026-01-01")]);
  setup("/app/files", null); await screen.findByText("Saved paper"); await screen.findByText("Old other");
  mocks.runs.mockImplementation(async ({ projectId }: { projectId: string }) => {
    if (projectId === "p2") throw new Error("Temporary outage");
    return [run(projectId, "Fresh other", "2026-02-01")];
  });
  await refreshConversations();
  await screen.findByText("Fresh other");
  expect(screen.getByText("Saved paper")).toBeInTheDocument();
  expect(screen.queryByText("Old other")).not.toBeInTheDocument();
});
it.each([401, 403, 404])("does not retain source rows after a %i response", async status => {
  setup(); await screen.findByText("First");
  mocks.list.mockRejectedValue(Object.assign(new Error("Access lost"), { status }));
  await refreshConversations(); await screen.findByRole("alert");
  expect(screen.queryByText("First")).not.toBeInTheDocument();
});
it("does not retain rows after the project disappears from the authorized listing", async () => {
  setup(); await screen.findByText("First");
  mocks.listProjects.mockResolvedValue([]);
  await refreshConversations();
  await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());
});
it("does not retain rows after explicit read permission is removed", async () => {
  setup(); await screen.findByText("First");
  mocks.listProjects.mockResolvedValue([{ ...project, access: { owner: false, abilities: [] } }]);
  await refreshConversations();
  await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());
});
it("does not treat a cached actor as authorization when account verification fails", async () => {
  setup(); await screen.findByText("First");
  mocks.me.mockRejectedValue(new Error("Account unavailable"));
  await refreshConversations();
  await screen.findByText("账号状态未能验证");
  expect(screen.queryByText("First")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "新建本项目对话" })).not.toBeInTheDocument();
});
it("does not retain a previous actor's rows when identity changes without a generation event", async () => {
  setup(); await screen.findByText("First");
  mocks.actor.mockImplementation(() => ({ generation: sessionGeneration(), tenantId: "different", userId: "u", csrf: "x" }));
  mocks.list.mockRejectedValue(new Error("Temporary outage"));
  await refreshConversations(); await screen.findByRole("alert");
  expect(screen.queryByText("First")).not.toBeInTheDocument();
});
it("recomputes module ownership when the selected project changes without refetching", async () => {
  mocks.currentId = "p1";
  const onCurrentModule = vi.fn();
  const contents = () => <MemoryRouter initialEntries={["/app/files"]}><SidebarConversations geoId={null} geo vcr={false} onCurrentModule={onCurrentModule} /></MemoryRouter>;
  const view = render(contents());
  await screen.findByText("First");
  await waitFor(() => expect(onCurrentModule).toHaveBeenLastCalledWith("geo"));
  const reads = mocks.listProjects.mock.calls.length;
  mocks.currentId = "default";
  view.rerender(contents());
  await waitFor(() => expect(onCurrentModule).toHaveBeenLastCalledWith(null));
  expect(mocks.listProjects).toHaveBeenCalledTimes(reads);
});

const study = (id: string, projectId: string, name: string, extra = {}) => ({ id, projectId, name, originatingSessionId: undefined, purpose: "programme", createdAt: "2026-03-01T00:00:00Z", ...extra });
it("groups conversations by research, keeps two sessions of one research as two rows and leaves other conversations flat", async () => {
  mocks.projects.mockResolvedValue([{ id: "p2", name: "Project of A" }, { id: "p3", name: "Paper" }]);
  mocks.studies.mockResolvedValue({ studies: [study("std_a", "p2", "Research A")] });
  mocks.runs.mockImplementation(async ({ projectId }: { projectId: string }) => projectId === "p2" ? [run("a1", "First question", "2026-02-01"), run("a2", "Second question", "2026-02-02")] : [run("c1", "Plain chat", "2026-02-03")]);
  setup("/app/files", null, true);
  const group = await screen.findByRole("group", { name: "研究：Research A" });
  expect(within(group).getAllByRole("button").map(button => button.textContent)).toEqual(["Second question", "First question"]);
  expect(screen.getAllByRole("group")).toHaveLength(1);
  expect(screen.getByText("Plain chat").closest("[role=group]")).toBeNull();
  expect(screen.queryByText("已保存的结果")).toBeNull();
});
it("keeps a research with no surviving conversation reachable through one saved-result row, and invents nothing", async () => {
  mocks.projects.mockResolvedValue([{ id: "p2", name: "Project of A" }]);
  mocks.studies.mockResolvedValue({ studies: [study("std_a", "p2", "Research A")], conversationStudies: [{ id: "std_a", projectId: "p2", name: "Research A", tabs: ["population"], originatingSessionId: null, question: null, status: "draft", updatedAt: "" }] });
  mocks.runs.mockResolvedValue([]);
  setup("/app/files", null, true);
  const group = await screen.findByRole("group", { name: "研究：Research A" });
  const rows = within(group).getAllByRole("button"); expect(rows).toHaveLength(1);
  expect(rows[0]).toHaveTextContent("已保存的结果");
  await userEvent.click(rows[0]);
  expect(mocks.select).toHaveBeenCalledWith("p2", expect.any(Function), expect.any(AbortSignal));
  expect(await screen.findByText("/app/virtual-research/std_a/population")).toBeInTheDocument();
  expect(screen.queryByText("没有对话")).toBeNull();
});
it("shows no research group for a project that is not a study", async () => {
  mocks.projects.mockResolvedValue([{ id: "p3", name: "Paper" }]);
  mocks.studies.mockResolvedValue({ studies: [] }); mocks.runs.mockResolvedValue([run("c1", "Plain chat", "2026-02-03")]);
  setup("/app/files", null, true); await screen.findByText("Plain chat");
  expect(screen.queryByRole("group")).toBeNull(); expect(screen.queryByText("已保存的结果")).toBeNull();
});
it("searches research names and conversation titles within the scope it listed", async () => {
  mocks.projects.mockResolvedValue([{ id: "p2", name: "Project A" }, { id: "p4", name: "Project B" }]);
  mocks.studies.mockResolvedValue({ studies: [study("std_a", "p2", "Hypertension cohort"), study("std_b", "p4", "Diabetes lab")] });
  mocks.runs.mockImplementation(async ({ projectId }: { projectId: string }) => projectId === "p2" ? [run("a1", "Alpha", "2026-02-01"), run("a2", "Beta", "2026-02-02")] : [run("b1", "Gamma", "2026-02-03")]);
  setup("/app/files", null, true); await screen.findByText("Alpha"); const user = userEvent.setup();
  const search = screen.getByRole("searchbox", { name: "搜索最近对话" });
  await user.type(search, "hypertension");
  expect(screen.getByText("Alpha")).toBeInTheDocument(); expect(screen.getByText("Beta")).toBeInTheDocument(); expect(screen.queryByText("Gamma")).toBeNull();
  await user.clear(search); await user.type(search, "gamma");
  expect(screen.getByRole("group", { name: "研究：Diabetes lab" })).toBeInTheDocument(); expect(screen.queryByText("Alpha")).toBeNull();
  await user.clear(search); await user.type(search, "nothing-matches");
  expect(screen.queryByRole("group")).toBeNull();
});
it("keeps only still-authorized history when one research's runs fail to refresh", async () => {
  mocks.projects.mockResolvedValue([{ id: "p2", name: "Project A" }, { id: "p4", name: "Project B" }]);
  mocks.studies.mockResolvedValue({ studies: [study("std_a", "p2", "Research A"), study("std_b", "p4", "Research B")] });
  mocks.runs.mockResolvedValue([]);
  mocks.runs.mockImplementation(async ({ projectId }: { projectId: string }) => [run(projectId === "p2" ? "a1" : "b1", projectId === "p2" ? "Alpha" : "Beta", "2026-02-01")]);
  setup("/app/files", null, true); await screen.findByText("Alpha"); await screen.findByText("Beta");
  mocks.runs.mockImplementation(async ({ projectId }: { projectId: string }) => { throw Object.assign(new Error("x"), { status: projectId === "p2" ? 500 : 403 }); });
  act(() => window.dispatchEvent(new Event("evimed:conversation-settled")));
  await screen.findAllByText(/暂未完整显示/);
  expect(screen.getByText("Alpha")).toBeInTheDocument();   // transient failure: kept
  expect(screen.queryByText("Beta")).toBeNull();          // access lost: dropped
  expect(screen.getByRole("group", { name: "研究：Research A" })).toBeInTheDocument();
});

const made = (id: string, projectId: string, name: string, originatingSessionId: string | null, createdAt = "2026-03-01T00:00:00Z") => ({ id, projectId, name, tabs: ["population"], originatingSessionId, question: null, status: "draft", updatedAt: createdAt, createdAt });
it("files each conversation-made research under its own conversation and keeps an ordinary chat of the same project flat", async () => {
  mocks.projects.mockResolvedValue([{ id: "default", name: "Default" }]);
  mocks.studies.mockResolvedValue({ studies: [], conversationStudies: [made("std_x", "default", "Predict 100 patients", "x1"), made("std_y", "default", "Compare two designs", "y1")] });
  mocks.runs.mockResolvedValue([run("w1", "Write weekly report", "2026-02-01"), run("x1", "Predict 100 patients", "2026-02-02"), run("y1", "Compare two designs", "2026-02-03")]);
  setup("/app/files", null, true);
  const groupX = await screen.findByRole("group", { name: "研究：Predict 100 patients" });
  const groupY = screen.getByRole("group", { name: "研究：Compare two designs" });
  expect(within(groupX).getAllByRole("button").map(b => b.textContent)).toEqual(["Predict 100 patients"]);
  expect(within(groupY).getAllByRole("button").map(b => b.textContent)).toEqual(["Compare two designs"]);
  expect(screen.getByText("Write weekly report").closest("[role=group]")).toBeNull();
});
it("gives a conversation-made research whose conversation is gone one saved-result row and lists research and chats newest first", async () => {
  mocks.projects.mockResolvedValue([{ id: "default", name: "Default" }]);
  mocks.studies.mockResolvedValue({ studies: [], conversationStudies: [made("std_old", "default", "Old research", "gone", "2026-01-01T00:00:00Z")] });
  mocks.runs.mockResolvedValue([run("w1", "Today chat", "2026-02-05")]);
  setup("/app/files", null, true);
  const group = await screen.findByRole("group", { name: "研究：Old research" });
  expect(within(group).getAllByRole("button").map(b => b.textContent)).toEqual(["已保存的结果"]);
  const chat = screen.getByText("Today chat");
  expect(chat.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
