import { act, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { geoProject } from "./__fixtures__/geoTabs";
import { GeoWorkDetails } from "./GeoWorkDetails";
import { WEB_SESSION_STARTED_EVENT } from "@/lib/sessionLifecycle";
import { CONVERSATION_SETTLED_EVENT } from "@/lib/runtimeUiBridge";

const files = vi.hoisted(() => ({ pick: vi.fn(), upload: vi.fn() }));
vi.mock("@/lib/backend", () => ({ pickFiles: files.pick, uploadFilesToWorkspace: files.upload }));
const native = vi.hoisted(() => ({ sources: vi.fn(), scope: vi.fn(), history: vi.fn() }));
vi.mock("@/lib/geoNativeClient", () => ({ geoConversationSources: native.sources, geoConversationSourceScope: native.scope, geoConversationHistory: native.history }));
beforeEach(() => {
  vi.clearAllMocks();
  files.pick.mockResolvedValue([]); files.upload.mockResolvedValue([]);
  native.sources.mockResolvedValue([{ id: "s1", title: "说明书" }, { id: "s2", title: "研究" }]);
  native.scope.mockResolvedValue({ sourceScope: null });
  native.history.mockResolvedValue({ sessionId: "one", partial: true, capturedAt: null, messages: [{ seq: 1, role: "user", text: "先核对说明书" }] });
});

function renderDetails(project = geoProject()) {
  const onOpenRuns = vi.fn(), onOpenSettings = vi.fn();
  render(<MemoryRouter initialEntries={["/app/geo/geo_1/answers/snap?round=r1&conversation=open&session=ses1"]}><GeoWorkDetails project={project} onOpenRuns={onOpenRuns} onOpenSettings={onOpenSettings} /></MemoryRouter>);
  return { onOpenRuns, onOpenSettings };
}

it("shows real product context and no invented progress", async () => {
  renderDetails(geoProject({}, { product: { brandName: "品牌", indication: "适用人群" } }));
  expect(screen.getByText("品牌")).toBeInTheDocument();
  expect(screen.getByText("适用人群")).toBeInTheDocument();
  const disclosure = screen.getByText("任务进度");
  expect(disclosure.closest("details")).not.toHaveAttribute("open");
  await userEvent.click(disclosure);
  expect(screen.getByText("暂无任务进度。")).toBeVisible();
  expect(screen.queryByText("未请求")).toBeNull();
});

it("shows requested and failed steps with scoped destinations", async () => {
  renderDetails(geoProject({ evidence: "failed", journey: "done" }));
  await userEvent.click(screen.getByText(/任务进度/));
  const details = screen.getByText(/任务进度/).closest("details")!;
  expect(within(details).getByText(/未完成|失败/)).toBeVisible();
  const evidence = within(details).getByRole("link", { name: "证据" });
  expect(evidence.getAttribute("href")).toContain("/app/geo/geo_1/evidence");
  expect(evidence.getAttribute("href")).toContain("conversation=open");
  expect(evidence.getAttribute("href")).toContain("session=ses1");
  expect(evidence.getAttribute("href")).toContain("round=r1");
  expect(screen.getByRole("link", { name: "患者旅程" }).getAttribute("href")).toContain("view=journey");
});

it("calls the existing actions without editing project data", async () => {
  const actions = renderDetails(geoProject({}, { access: { owner: false, roles: ["viewer"], abilities: ["view"] } }));
  await userEvent.click(screen.getByRole("button", { name: "执行详情" }));
  await userEvent.click(screen.getByRole("button", { name: "项目设置" }));
  expect(actions.onOpenRuns).toHaveBeenCalledOnce();
  expect(actions.onOpenSettings).toHaveBeenCalledOnce();
});

it("keeps recent activity linked to its exact answer and current scope", async () => {
  const original = geoProject();
  renderDetails({ ...original, overview: { ...original.overview, week: [{ kind: "wrong_ours", text: "发现一条讲错", tab: "diagnosis", ref: { snapshotId: "snap_2" }, at: "2026-10-20T01:00:00Z" }] } });
  await userEvent.click(screen.getByText("本周（1）"));
  const event = screen.getByRole("link", { name: /发现一条讲错/ });
  expect(event).toHaveAttribute("href", expect.stringContaining("/app/geo/geo_1/answers/snap_2"));
  expect(event).toHaveAttribute("href", expect.stringContaining("round=r1"));
  expect(event).toHaveAttribute("href", expect.stringContaining("session=ses1"));
});


it("reads the exact session and reports selection and partial history to members", async () => {
  native.scope.mockResolvedValue({ sourceScope: ["s1"] });
  const project = geoProject({}, { access: { owner: false, roles: ["viewer"], abilities: ["view"] } });
  render(<MemoryRouter><GeoWorkDetails project={project} sessionId="one" onOpenRuns={vi.fn()} onOpenSettings={vi.fn()} /></MemoryRouter>);
  expect(await screen.findByText("当前范围：已选择 1 份资料")).toBeInTheDocument();
  expect(screen.getByText("先核对说明书")).toBeInTheDocument();
  expect(screen.getByText(/历史记录不完整/)).toBeInTheDocument();
  expect(native.sources).toHaveBeenCalledWith({ kind: "geo", geoProjectId: project.id, sessionId: "one" });
  expect(screen.queryByRole("button", { name: /上传/ })).not.toBeInTheDocument();
});

it("distinguishes explicit empty scope and retries failed reads", async () => {
  native.scope.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ sourceScope: [] });
  render(<MemoryRouter><GeoWorkDetails project={geoProject()} sessionId="one" onOpenRuns={vi.fn()} onOpenSettings={vi.fn()} /></MemoryRouter>);
  expect(await screen.findByRole("alert")).toHaveTextContent("未能读取");
  await userEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByText("当前范围：不使用资料")).toBeInTheDocument();
});

it("discards a late response from the previous session", async () => {
  let finish!: (value: unknown) => void;
  native.history.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ sessionId: "two", partial: false, capturedAt: null, messages: [{ seq: 2, role: "user", text: "新会话" }] });
  const project = geoProject();
  const view = render(<MemoryRouter><GeoWorkDetails project={project} sessionId="one" onOpenRuns={vi.fn()} onOpenSettings={vi.fn()} /></MemoryRouter>);
  view.rerender(<MemoryRouter><GeoWorkDetails project={project} sessionId="two" onOpenRuns={vi.fn()} onOpenSettings={vi.fn()} /></MemoryRouter>);
  expect(await screen.findByText("新会话")).toBeInTheDocument();
  finish({ sessionId: "one", partial: false, messages: [{ seq: 1, role: "user", text: "旧会话" }] });
  expect(screen.queryByText("旧会话")).not.toBeInTheDocument();
});

it("does not read without a confirmed session and labels project default distinctly", async () => {
  const project = geoProject();
  const view = render(<MemoryRouter><GeoWorkDetails project={project} onOpenRuns={vi.fn()} onOpenSettings={vi.fn()} /></MemoryRouter>);
  expect(native.sources).not.toHaveBeenCalled();
  expect(screen.getByText("打开对话后查看。")).toBeInTheDocument();
  view.rerender(<MemoryRouter><GeoWorkDetails project={project} sessionId="one" onOpenRuns={vi.fn()} onOpenSettings={vi.fn()} /></MemoryRouter>);
  expect(await screen.findByText("当前范围：项目默认资料")).toBeInTheDocument();
});


const ownerProject = () => geoProject({}, { access: { owner: true, roles: ["owner"], abilities: ["view", "edit"] } });
it("refreshes only after the displayed conversation settles", async () => {
  render(<MemoryRouter><GeoWorkDetails project={ownerProject()} sessionId="one" onOpenRuns={vi.fn()} onOpenSettings={vi.fn()} /></MemoryRouter>);
  await screen.findByText("当前范围：项目默认资料");
  act(() => window.dispatchEvent(new CustomEvent(CONVERSATION_SETTLED_EVENT, { detail: { sessionId: "other" } })));
  expect(native.sources).toHaveBeenCalledTimes(1);
  act(() => window.dispatchEvent(new CustomEvent(CONVERSATION_SETTLED_EVENT, { detail: { sessionId: "one" } })));
  await waitFor(() => expect(native.sources).toHaveBeenCalledTimes(2));
});
it("discards a file selection started under a previous login even if the project and session match", async () => {
  let finish!: (picked: File[]) => void;
  files.pick.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<MemoryRouter><GeoWorkDetails project={ownerProject()} sessionId="one" onOpenRuns={vi.fn()} onOpenSettings={vi.fn()} /></MemoryRouter>);
  await userEvent.click(screen.getByRole("button", { name: "添加项目资料" }));
  act(() => window.dispatchEvent(new Event(WEB_SESSION_STARTED_EVENT)));
  await act(async () => { finish([new File(["data"], "private.txt")]); });
  expect(files.upload).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "添加项目资料" })).toBeEnabled();
});
it("uploads to the exact owner project and refreshes session sources", async () => {
  const file = new File(["data"], "input.txt");
  files.pick.mockResolvedValue([file]); files.upload.mockResolvedValue(["knowledge-base/input.txt"]);
  const project = ownerProject();
  render(<MemoryRouter><GeoWorkDetails project={project} sessionId="one" onOpenRuns={vi.fn()} onOpenSettings={vi.fn()} /></MemoryRouter>);
  await screen.findByText("当前范围：项目默认资料");
  await userEvent.click(screen.getByRole("button", { name: "添加项目资料" }));
  expect(await screen.findByText(/已上传 1 个文件，待解析/)).toBeInTheDocument();
  expect(files.upload).toHaveBeenCalledWith([file], "knowledge-base", "base", project.projectId, expect.any(Function));
  await waitFor(() => expect(native.sources).toHaveBeenCalledTimes(2));
});

it("allows cancellation without upload and reports failure without claiming success", async () => {
  const file = new File(["data"], "input.txt");
  files.pick.mockResolvedValueOnce([]).mockResolvedValueOnce([file]); files.upload.mockRejectedValue(new Error("offline"));
  render(<MemoryRouter><GeoWorkDetails project={ownerProject()} onOpenRuns={vi.fn()} onOpenSettings={vi.fn()} /></MemoryRouter>);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "添加项目资料" }));
  expect(files.upload).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "添加项目资料" }));
  expect(await screen.findByText(/上传未完成/)).toBeInTheDocument();
  expect(screen.queryByText(/已上传 1 个文件/)).not.toBeInTheDocument();
});

it("does not offer member uploads or upload a selection after switching projects", async () => {
  let finish!: (files: File[]) => void;
  files.pick.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const first = ownerProject();
  const view = render(<MemoryRouter><GeoWorkDetails project={first} sessionId="one" onOpenRuns={vi.fn()} onOpenSettings={vi.fn()} /></MemoryRouter>);
  await userEvent.click(screen.getByRole("button", { name: "添加项目资料" }));
  const member = geoProject({}, { access: { owner: false, roles: ["viewer"], abilities: ["view"] } });
  view.rerender(<MemoryRouter><GeoWorkDetails project={{ ...member, id: "geo-other", projectId: "other" }} sessionId="two" onOpenRuns={vi.fn()} onOpenSettings={vi.fn()} /></MemoryRouter>);
  finish([new File(["data"], "input.txt")]);
  await waitFor(() => expect(files.upload).not.toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "添加项目资料" })).not.toBeInTheDocument();
});

it("invalidates an in-flight upload when the session changes", async () => {
  let finish!: (names: string[]) => void;
  files.pick.mockResolvedValue([new File(["data"], "input.txt")]);
  files.upload.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const project = ownerProject();
  const view = render(<MemoryRouter><GeoWorkDetails project={project} sessionId="one" onOpenRuns={vi.fn()} onOpenSettings={vi.fn()} /></MemoryRouter>);
  await userEvent.click(screen.getByRole("button", { name: "添加项目资料" }));
  await waitFor(() => expect(files.upload).toHaveBeenCalled());
  const valid = files.upload.mock.calls[0][4] as () => boolean;
  expect(valid()).toBe(true);
  view.rerender(<MemoryRouter><GeoWorkDetails project={project} sessionId="two" onOpenRuns={vi.fn()} onOpenSettings={vi.fn()} /></MemoryRouter>);
  expect(valid()).toBe(false);
  await act(async () => { finish(["knowledge-base/input.txt"]); });
  expect(screen.queryByText(/已上传 1 个文件/)).not.toBeInTheDocument();
});

it("does not show upload to an owner without edit ability", async () => {
  const project = geoProject({}, { access: { owner: true, roles: ["owner"], abilities: ["view"] } });
  render(<MemoryRouter><GeoWorkDetails project={project} onOpenRuns={vi.fn()} onOpenSettings={vi.fn()} /></MemoryRouter>);
  expect(screen.queryByRole("button", { name: "添加项目资料" })).not.toBeInTheDocument();
});
