import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, useLocation } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { WEB_SESSION_STARTED_EVENT, sessionGeneration } from "@/lib/sessionLifecycle";
import { SidebarConversations } from "./SidebarConversations";

const mocks = vi.hoisted(() => ({ listProjects: vi.fn(), list: vi.fn(), open: vi.fn(), me: vi.fn(), actor: vi.fn(), projects: vi.fn(), runs: vi.fn(), studies: vi.fn(), select: vi.fn() }));
vi.mock("@/lib/geoClient", () => ({ listGeoProjects: mocks.listProjects }));
vi.mock("@/lib/geoNativeClient", () => ({ listGeoConversations: mocks.list, openGeoConversation: mocks.open }));
vi.mock("@/lib/apiClient", async original => ({ ...await original<typeof import("@/lib/apiClient")>(), fetchWebMe: mocks.me, getVerifiedWebActor: mocks.actor, listWebProjects: mocks.projects, listWebAgentRuns: mocks.runs }));
vi.mock("@/lib/projects", () => ({ useProjectStore: { getState: () => ({ select: mocks.select }) } }));
vi.mock("@/lib/vcrClient", () => ({ getVcrHome: mocks.studies }));
vi.mock("./ProjectBrowser", () => ({ ProjectBrowser: ({ studyScope }: { studyScope?: string }) => <div>{studyScope ? `研究 ${studyScope}` : "项目管理"}</div> }));
const project = { id: "g1", projectId: "p1", name: "GEO", access: { owner: true, abilities: ["read", "run", "edit"] } };
const descriptor = { sessionId: "new1", projectId: "p1", scope: { kind: "geo", geoProjectId: "g1", sessionId: "new1" } };
const run = (id: string, title: string, at: string) => ({ id, sessionId: id, title, startedAt: at, finishedAt: at, createdAt: at });
function Probe() { const location = useLocation(); return <><output>{location.pathname}</output><Link to="/app/geo/g2">换页面</Link></>; }
function setup(initial = "/app/geo/g1/visibility", geoId: string | null = "g1", vcr = false) { return render(<MemoryRouter initialEntries={[initial]}><SidebarConversations geoId={geoId} geo vcr={vcr} onCurrentModule={() => {}} /><Probe /></MemoryRouter>); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => {
  sessionStorage.clear(); vi.clearAllMocks(); mocks.me.mockResolvedValue({ user: { id: "u" } }); mocks.actor.mockImplementation(() => ({ generation: sessionGeneration(), tenantId: "t", userId: "u", csrf: "x" }));
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
  setup("/app/files", null); await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3));
  mocks.listProjects.mockReturnValue(new Promise(() => {}));
  await userEvent.click(screen.getByRole("link", { name: "换页面" }));
  await act(async () => gate.resolve({ items: [], nextCursor: null }));
  expect(mocks.list).toHaveBeenCalledTimes(3);
});
