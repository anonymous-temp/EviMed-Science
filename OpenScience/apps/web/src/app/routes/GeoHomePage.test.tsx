import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WEB_SESSION_STARTED_EVENT, WEB_SESSION_SYNC_STORAGE_KEY, WebApiError } from "@/lib/apiClient";
import { GEO_SUMMARIES } from "@/components/geo/__fixtures__/geoProjects";
import { GEO_OFF_SENTENCE } from "@/components/geo/GeoStates";
import { GeoHomePage } from "./GeoHomePage";

const client = vi.hoisted(() => ({
  useGeoFeature: vi.fn(),
  listGeoProjects: vi.fn(),
  createGeoProject: vi.fn(),
  patchGeoProject: vi.fn(),
  open: vi.fn(),
  me: vi.fn(),
}));

vi.mock("@/lib/apiClient", async (original) => ({ ...(await original<typeof import("@/lib/apiClient")>()), fetchWebMe: client.me }));

vi.mock("@/lib/geoClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/geoClient")>()),
  useGeoFeature: client.useGeoFeature,
  listGeoProjects: client.listGeoProjects,
  createGeoProject: client.createGeoProject,
  patchGeoProject: client.patchGeoProject,
}));

// Opening a GEO conversation resolves the exact module scope; that has its own
// test (useOpenGeoConversation.test.tsx). Here it is the call it makes.
vi.mock("@/components/geo/useOpenGeoConversation", () => ({ useOpenGeoConversation: () => client.open }));

/** The page's own width as `MasterDetail` measures it (jsdom has no layout): 1100 has room for the list and the preview, 600 has not. */
let width = 1100;
let rect: { mockRestore(): void };

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function renderHome(path = "/app/geo") {
  return render(<MemoryRouter initialEntries={[path]}><GeoHomePage /><Where /></MemoryRouter>);
}

const where = () => screen.getByTestId("where").textContent;
const list = () => screen.findByRole("list", { name: "循证 GEO 项目" });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  client.me.mockResolvedValue({ user: { id: "alice", name: "Alice", accountGeneration: "generation-a" }, tenant: { id: "tenant" } });
  width = 1100;
  rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return { width: this.hasAttribute("data-master-detail") ? width : 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) };
  });
  client.useGeoFeature.mockReturnValue("on");
  client.listGeoProjects.mockResolvedValue(GEO_SUMMARIES);
  client.open.mockResolvedValue(true);
});
afterEach(() => rect.mockRestore());

describe("循证 GEO home — the list", () => {
  it("is one row per project: its name, one line under it and the index — no table columns", async () => {
    renderHome();
    expect(screen.getByRole("heading", { level: 1, name: "循证 GEO" })).toBeInTheDocument();
    const rows = within(await list()).getAllByRole("listitem");
    expect(rows).toHaveLength(3);

    // A project with something open says that under its name; the badge carries the red, never the sentence (F-G10).
    const masi = rows[0];
    expect(within(masi).getByRole("link", { name: "玛仕度肽注射液" })).toHaveAttribute("href", "/app/geo/geo_masi");

    expect(masi).toHaveTextContent("2 条讲错待处理");
    expect(masi.querySelector(".text-danger")).toBeNull();

    // Otherwise it says where the project is: the window and the week.
    const mitiao = rows[1];
    expect(mitiao.querySelector("[data-geo-subline]")).toHaveTextContent("等你开启自动监测");

    expect(mitiao.querySelector(".text-danger")).toBeNull();

    // A project that did one step is in the list all the same, with “—”.
    const xinli = rows[2];
    expect(xinli).toHaveTextContent("待开始：问题清单");


    // The sample and the trend are the preview's; a row is not a table.
    expect(within(await list()).queryByText("310 次里 56 次")).toBeNull();
    expect(within(await list()).queryAllByRole("button")).toHaveLength(0);
  });

  it("says a single step that ended without finishing as not finished, never as under way", async () => {
    client.listGeoProjects.mockResolvedValue([
      { ...GEO_SUMMARIES[2], steps: { evidence: { status: "done", requested: true }, diagnosis: { status: "failed", requested: true } } },
    ]);
    renderHome();
    const subline = within(await list()).getAllByRole("listitem")[0].querySelector("[data-geo-subline]");
    expect(subline).toHaveTextContent("诊断未完成");
    expect(subline).not.toHaveTextContent("正在做");
  });

  it("does not describe a queued project as already running", async () => {
    client.listGeoProjects.mockResolvedValue([{ ...GEO_SUMMARIES[2], steps: { questions: { status: "queued", requested: true } } }]);
    renderHome();
    const row = within(await list()).getByRole("listitem");
    expect(row).toHaveTextContent("排队中");
    expect(row).not.toHaveTextContent("正在做");
  });

  it("says the severe errors in its own words beside their badge — never an engine's sentence", async () => {
    client.listGeoProjects.mockResolvedValue([
      { ...GEO_SUMMARIES[0], alert: { wrongOurs: 13, severe: 11, safety: 0, severity: "S3" } },
      { ...GEO_SUMMARIES[1], alert: { wrongOurs: 3, severe: 0, safety: 0, severity: "S2" } },
      { ...GEO_SUMMARIES[2], alert: { wrongOurs: 0, severe: 0, safety: 1, severity: null } },
    ]);
    renderHome();
    const rows = await list();
    const sentence = within(rows).getByText("11 条严重讲错待处理");
    expect(sentence).not.toHaveClass("text-danger");

    expect(within(rows).getByText("3 条讲错待处理")).toBeInTheDocument();
    expect(within(rows).getByText("1 篇稿件等你放行")).toBeInTheDocument();
  });

  it("tells two projects of one name apart by the day each started, and leaves a single name alone", async () => {
    client.listGeoProjects.mockResolvedValue([
      { ...GEO_SUMMARIES[0], id: "geo_a", name: "波立维", startedAt: `${new Date().getFullYear()}-09-29` },
      { ...GEO_SUMMARIES[1], id: "geo_b", name: "波立维", startedAt: `${new Date().getFullYear()}-10-07` },
      { ...GEO_SUMMARIES[2], id: "geo_c", name: "玛仕度肽注射液" },
    ]);
    renderHome();
    const rows = await list();
    expect(within(rows).getByRole("link", { name: "波立维 · 9月29日" })).toHaveAttribute("href", "/app/geo/geo_a");
    expect(within(rows).getByRole("link", { name: "波立维 · 10月7日" })).toHaveAttribute("href", "/app/geo/geo_b");
    expect(within(rows).getByRole("link", { name: "玛仕度肽注射液" })).toBeInTheDocument();
  });

  it("orders two or more projects by their latest activity, or the ones that need the reader first, and draws no order for one", async () => {
    client.listGeoProjects.mockResolvedValue([
      { ...GEO_SUMMARIES[0], id: "geo_a", name: "安静的项目", updatedAt: "2026-10-12T00:00:00Z", alert: { wrongOurs: 0, severe: 0, safety: 0 } },
      { ...GEO_SUMMARIES[1], id: "geo_b", name: "有严重讲错的项目", updatedAt: "2026-10-01T00:00:00Z", alert: { wrongOurs: 3, severe: 2, safety: 0, severity: "S3" } },
      { ...GEO_SUMMARIES[0], id: "geo_c", name: "停了的项目", status: "paused", updatedAt: "2026-10-13T00:00:00Z", alert: { wrongOurs: 0, severe: 0, safety: 0 } },
    ]);
    const { unmount } = renderHome("/app/geo?project=geo_b");
    const names = () => within(screen.getByRole("list", { name: "循证 GEO 项目" })).getAllByRole("link").filter(link => link.textContent !== "继续工作").map((link) => link.getAttribute("aria-label"));
    await list();
    expect(names()).toEqual(["停了的项目", "安静的项目", "有严重讲错的项目"]);
    const toolbar = screen.getByRole("group", { name: "项目排序" });
    expect(toolbar).toHaveTextContent("3 个项目");
    await userEvent.click(within(toolbar).getByRole("button", { name: "需要处理的在前" }));
    expect(names()).toEqual(["有严重讲错的项目", "安静的项目", "停了的项目"]);
    // The order is written in the address beside the project that is chosen, and neither undoes the other.
    expect(where()).toBe("/app/geo?project=geo_b&sort=state");
    unmount();
    client.listGeoProjects.mockResolvedValue([GEO_SUMMARIES[0]]);
    renderHome();
    await list();
    expect(screen.getByRole("searchbox", { name: "搜索项目" })).toBeInTheDocument();
  });
});

describe("循证 GEO home — creating, empty, and failing", () => {
  it("creates a project and lands in its conversation — no form", async () => {
    client.createGeoProject.mockResolvedValue({ id: "geo_new", projectId: "p-new", sessionId: "ses_new" });
    renderHome();
    await list();
    await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
    await waitFor(() => expect(client.open).toHaveBeenCalledWith({ geoId: "geo_new", projectId: "p-new", sessionId: "ses_new" }));
    expect(client.createGeoProject).toHaveBeenCalledWith({ requestKey: expect.any(String), accountGeneration: "generation-a" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("creates the first project from the empty state and lands in its conversation", async () => {
    client.listGeoProjects.mockResolvedValue([]);
    client.createGeoProject.mockResolvedValue({ id: "geo_new", projectId: "p-new", sessionId: "ses_new" });
    renderHome();
    await screen.findByText("还没有循证 GEO 项目");
    await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
    await waitFor(() => expect(client.open).toHaveBeenCalledWith({ geoId: "geo_new", projectId: "p-new", sessionId: "ses_new" }));
    expect(client.createGeoProject).toHaveBeenCalledWith({ requestKey: expect.any(String), accountGeneration: "generation-a" });
  });

  it("keeps the header's 新建项目, not yet pressable, while the list is read — and has no second one in the page", async () => {
    client.listGeoProjects.mockReturnValue(new Promise(() => undefined));
    const { container } = renderHome();
    const header = within(container.querySelector<HTMLElement>("[data-page-header]")!).getByRole("button", { name: "新建项目" });
    expect(header).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "新建项目" })).toHaveLength(1);
  });

  it("offers a retry in the pane when the list cannot be read", async () => {
    client.listGeoProjects.mockRejectedValueOnce(new WebApiError("down", { status: 503, code: "geo_unavailable" }));
    renderHome();
    const retry = await screen.findByRole("button", { name: "重试" });
    await userEvent.click(retry);
    expect(await list()).toBeInTheDocument();
  });

  it("is one sentence where the module is off for this account", async () => {
    client.useGeoFeature.mockReturnValue("off");
    renderHome();
    expect(screen.getByText(GEO_OFF_SENTENCE)).toBeInTheDocument();
    expect(client.listGeoProjects).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "新建项目" })).not.toBeInTheDocument();
  });

  it("believes the route over the account read: geo_not_enabled is the off page too", async () => {
    client.useGeoFeature.mockReturnValue("error");
    client.listGeoProjects.mockRejectedValue(new WebApiError("off", { status: 404, code: "geo_not_enabled" }));
    renderHome();
    expect(await screen.findByText(GEO_OFF_SENTENCE)).toBeInTheDocument();
  });
});


it("opens a selected project card directly and preserves old selection links", async () => {
  renderHome("/app/geo?project=geo_mitiao"); await list();
  const card = screen.getByRole("link", { name: "米曲菌胰酶片" });
  expect(card).toHaveAttribute("aria-current", "true");
  await userEvent.click(card);
  expect(where()).toBe("/app/geo/geo_mitiao");
});

it.each([false, "reject"])("recovers the created project when opening fails: %s", async (result) => {
  client.createGeoProject.mockResolvedValue({ id: "geo_new", projectId: "p-new", sessionId: "ses_new" });
  if (result === "reject") client.open.mockRejectedValue(new Error("unavailable")); else client.open.mockResolvedValue(false);
  renderHome(); await list(); await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
  const recovery = await screen.findByRole("link", { name: "打开已创建的项目" });
  expect(recovery).toHaveAttribute("href", "/app/geo/geo_new");
  expect(screen.getByRole("button", { name: "新建项目" })).toBeDisabled();
  expect(client.createGeoProject).toHaveBeenCalledTimes(1);
});

it("does not expose mutation controls for a viewer", async () => {
  client.listGeoProjects.mockResolvedValue([{ ...GEO_SUMMARIES[0], status: "paused", access: { owner: false, roles: ["viewer"], abilities: ["view"] } }]);
  renderHome(); const cards = await list();
  expect(cards).toHaveTextContent("已暂停");
  expect(within(cards).queryByRole("button")).toBeNull();
});

it("filters the collection by product and reports no matches", async () => {
  renderHome(); await list();
  const search = screen.getByRole("searchbox", { name: "搜索项目" });
  await userEvent.type(search, "米曲菌");
  expect(within(await list()).getAllByRole("listitem")).toHaveLength(1);
  await userEvent.clear(search);
  await userEvent.type(search, "没有这个项目");
  expect(screen.getByText("没有符合的项目。")).toBeInTheDocument();
});


it("retains an unknown outcome across reload and never retries POST without an explicit reset", async () => {
  client.createGeoProject.mockRejectedValue(new TypeError("connection lost"));
  const view = renderHome(); await list();
  await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
  expect(await screen.findByText(/项目创建结果未知/)).toBeVisible();
  await waitFor(() => expect(client.listGeoProjects).toHaveBeenCalledTimes(2));
  view.unmount();
  renderHome();
  expect(await screen.findByText(/项目创建结果未知/)).toBeVisible();
  await list();
  expect(screen.getByRole("button", { name: "新建项目" })).toBeDisabled();
  expect(client.createGeoProject).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/再次新建可能产生重复项目/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "已检查列表，仍要新建" }));
  expect(screen.getByRole("button", { name: "新建项目" })).toBeEnabled();
});

it("isolates pending markers across accounts", async () => {
  client.createGeoProject.mockRejectedValue(new Error("timeout"));
  const first = renderHome(); await list(); await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
  await screen.findByText(/项目创建结果未知/); first.unmount();
  client.me.mockResolvedValue({ user: { id: "bob", name: "Bob", accountGeneration: "generation-b" }, tenant: { id: "tenant" } });
  renderHome(); await list();
  expect(screen.queryByText(/项目创建结果未知/)).toBeNull();
  expect(screen.getByRole("button", { name: "新建项目" })).toBeEnabled();
});

it("keeps an unknown outcome when list refresh fails and retries only the read", async () => {
  client.createGeoProject.mockRejectedValue(new Error("timeout"));
  client.listGeoProjects.mockResolvedValueOnce(GEO_SUMMARIES).mockRejectedValueOnce(new Error("list unavailable")).mockResolvedValueOnce(GEO_SUMMARIES);
  renderHome(); await list(); await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
  const retry = await screen.findByRole("button", { name: "重试" });
  expect(screen.getByText(/项目创建结果未知/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "已检查列表，仍要新建" })).toBeNull();
  await userEvent.click(retry); await list();
  expect(screen.getByText(/项目创建结果未知/)).toBeVisible();
  expect(client.createGeoProject).toHaveBeenCalledTimes(1);
});

it("clears the marker for a confirmed pre-creation limit refusal", async () => {
  client.createGeoProject.mockRejectedValue(new WebApiError("limit", { status: 409, code: "project_limit_reached" }));
  renderHome(); await list(); await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "新建项目" })).toBeEnabled());
  expect(screen.queryByText(/项目创建结果未知/)).toBeNull();
});


it("persists the marker before a request resolves and restores a known created ID", async () => {
  let finish: (value: { id: string; projectId: string; sessionId: null }) => void = () => {};
  client.createGeoProject.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const first = renderHome(); await list(); await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
  first.unmount();
  finish({ id: "geo_exact", projectId: "p-exact", sessionId: null });
  await waitFor(() => expect(localStorage.getItem("evimed.geo.create.v1:tenant:alice:generation-a")).toContain("geo_exact"));
  renderHome();
  expect(await screen.findByRole("link", { name: "打开已创建的项目" })).toHaveAttribute("href", "/app/geo/geo_exact");
  expect(client.open).not.toHaveBeenCalled();
});

it("unblocks later creation after the person opens the known recovered project", async () => {
  localStorage.setItem("evimed.geo.create.v1:tenant:alice:generation-a", JSON.stringify({ kind: "created", id: "geo_exact" }));
  const view = renderHome();
  await userEvent.click(await screen.findByRole("link", { name: "打开已创建的项目" }));
  expect(where()).toBe("/app/geo/geo_exact");
  expect(localStorage.getItem("evimed.geo.create.v1:tenant:alice:generation-a")).toBeNull();
  view.unmount();
  renderHome(); await list();
  expect(screen.getByRole("button", { name: "新建项目" })).toBeEnabled();
});

it("does not allow creation if identity cannot be verified", async () => {
  client.me.mockRejectedValue(new Error("offline"));
  renderHome();
  expect(await screen.findByText(/无法确认账号或保存创建状态/)).toBeVisible();
  expect(await list()).toHaveTextContent("玛仕度肽注射液");
  expect(screen.getByRole("button", { name: "新建项目" })).toBeDisabled();
  expect(client.createGeoProject).not.toHaveBeenCalled();
});

it("keeps existing projects readable when the creation marker is unavailable", async () => {
  const original = Storage.prototype.getItem;
  const storage = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) { if (key.startsWith("evimed.geo.create.v1:")) throw new Error("storage disabled"); return original.call(this, key); });
  try {
    renderHome();
    expect(await screen.findByText(/无法确认账号或保存创建状态/)).toBeVisible();
    expect(await list()).toHaveTextContent("玛仕度肽注射液");
    expect(screen.getByRole("button", { name: "新建项目" })).toBeDisabled();
  } finally { storage.mockRestore(); }
});

it.each([WEB_SESSION_SYNC_STORAGE_KEY, null])("drops a delayed former-account response on cross-tab session boundary %s", async (key) => {
  let finishOld: (rows: typeof GEO_SUMMARIES) => void = () => {};
  client.listGeoProjects.mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; })).mockResolvedValueOnce([GEO_SUMMARIES[1]]);
  renderHome();
  await waitFor(() => expect(client.listGeoProjects).toHaveBeenCalledTimes(1));
  client.me.mockResolvedValue({ user: { id: "bob", name: "Bob", accountGeneration: "generation-b" }, tenant: { id: "tenant" } });
  await act(async () => {
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: key ? '{"kind":"started"}' : null }));
    finishOld(GEO_SUMMARIES);
    await Promise.resolve();
  });
  expect(await list()).toHaveTextContent("米曲菌胰酶片");
  expect(screen.queryByText("玛仕度肽注射液")).toBeNull();
});

it("discards the former account's delayed project list after a session switch", async () => {
  let finishOld: (rows: typeof GEO_SUMMARIES) => void = () => {};
  client.listGeoProjects.mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; })).mockResolvedValueOnce([GEO_SUMMARIES[1]]);
  renderHome();
  await waitFor(() => expect(client.listGeoProjects).toHaveBeenCalledTimes(1));
  client.me.mockResolvedValue({ user: { id: "bob", name: "Bob", accountGeneration: "generation-b" }, tenant: { id: "tenant" } });
  act(() => window.dispatchEvent(new Event(WEB_SESSION_STARTED_EVENT)));
  expect(await list()).toHaveTextContent("米曲菌胰酶片");
  await act(async () => { finishOld(GEO_SUMMARIES); await Promise.resolve(); });
  expect(screen.queryByText("玛仕度肽注射液")).toBeNull();
});


it("retries an uncertain creation after reload with the original key and account generation", async () => {
  client.createGeoProject.mockRejectedValueOnce(new Error("lost response")).mockResolvedValueOnce({ id: "geo_retry", projectId: "p-retry", sessionId: null });
  client.open.mockResolvedValue(false);
  const first = renderHome(); await list();
  await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
  await screen.findByRole("button", { name: "重试同一创建请求" });
  first.unmount();

  renderHome(); await list();
  expect(client.createGeoProject).toHaveBeenCalledTimes(1);
  await userEvent.click(await screen.findByRole("button", { name: "重试同一创建请求" }));
  expect(await screen.findByRole("link", { name: "打开已创建的项目" })).toHaveAttribute("href", "/app/geo/geo_retry");
  const original = client.createGeoProject.mock.calls[0][0];
  expect(original).toEqual({ requestKey: expect.any(String), accountGeneration: "generation-a" });
  expect(client.createGeoProject.mock.calls[1][0]).toEqual(original);
});

it("does not invent a retry key for an old unknown marker", async () => {
  localStorage.setItem("evimed.geo.create.v1:tenant:alice", JSON.stringify({ kind: "unknown" }));
  renderHome(); await list();
  expect(await screen.findByText(/项目创建结果未知/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "重试同一创建请求" })).toBeNull();
  expect(client.createGeoProject).not.toHaveBeenCalled();
});

it("keeps the original key after a retry receives an old-server 400", async () => {
  client.createGeoProject.mockRejectedValueOnce(new Error("lost response"))
    .mockRejectedValueOnce(new WebApiError("unsupported field", { status: 400, code: "geo_payload_invalid" }));
  renderHome(); await list();
  await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
  await userEvent.click(await screen.findByRole("button", { name: "重试同一创建请求" }));
  await waitFor(() => expect(client.listGeoProjects).toHaveBeenCalledTimes(3));
  expect(client.createGeoProject.mock.calls[1][0]).toEqual(client.createGeoProject.mock.calls[0][0]);
  expect(screen.getByRole("button", { name: "重试同一创建请求" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "新建项目" })).toBeDisabled();
});

it("reports a deleted receipt as terminal and starts the next project with another key", async () => {
  client.createGeoProject.mockRejectedValueOnce(new Error("lost response"))
    .mockRejectedValueOnce(new WebApiError("deleted", { status: 410, code: "geo_project_deleted" }))
    .mockResolvedValueOnce({ id: "geo_next", projectId: "p-next", sessionId: null });
  renderHome(); await list();
  await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
  await userEvent.click(await screen.findByRole("button", { name: "重试同一创建请求" }));
  expect(await screen.findByText("该创建请求对应的项目已删除。")).toBeVisible();
  expect(screen.queryByRole("button", { name: "重试同一创建请求" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "开始另一个项目" }));
  await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
  expect(client.createGeoProject.mock.calls[2][0].requestKey).not.toBe(client.createGeoProject.mock.calls[0][0].requestKey);
});

it.each(["success", "refusal"])("preserves another tab's newer marker after a delayed %s", async (outcome) => {
  const delayed = deferred<{ id: string; projectId: string; sessionId: null }>();
  client.createGeoProject.mockReturnValueOnce(delayed.promise);
  renderHome(); await list();
  await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
  const key = "evimed.geo.create.v1:tenant:alice:generation-a";
  const next = JSON.stringify({ kind: "unknown", requestKey: "another-request-key" });
  await act(async () => {
    localStorage.setItem(key, next);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: next }));
    if (outcome === "success") delayed.resolve({ id: "geo_first", projectId: "p-first", sessionId: null });
    else delayed.reject(new WebApiError("limit", { status: 409, code: "project_limit_reached" }));
  });
  expect(localStorage.getItem(key)).toBe(next);
  expect(screen.getByRole("button", { name: "重试同一创建请求" })).toBeEnabled();
  expect(client.open).not.toHaveBeenCalled();
});

it("never replays an earlier generation of the same username", async () => {
  localStorage.setItem("evimed.geo.create.v1:tenant:alice:generation-a", JSON.stringify({ kind: "unknown", requestKey: "previous-request-key" }));
  client.me.mockResolvedValue({ user: { id: "alice", name: "Alice", accountGeneration: "generation-b" }, tenant: { id: "tenant" } });
  client.createGeoProject.mockResolvedValueOnce({ id: "geo_next", projectId: "p-next", sessionId: null });
  renderHome(); await list();
  expect(screen.queryByRole("button", { name: "重试同一创建请求" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
  expect(client.createGeoProject).toHaveBeenCalledWith({ requestKey: expect.not.stringMatching(/^previous-request-key$/), accountGeneration: "generation-b" });
});

it("refreshes identity after a generation conflict without replaying the old marker", async () => {
  client.me.mockResolvedValueOnce({ user: { id: "alice", name: "Alice", accountGeneration: "generation-a" }, tenant: { id: "tenant" } })
    .mockResolvedValue({ user: { id: "alice", name: "Alice", accountGeneration: "generation-b" }, tenant: { id: "tenant" } });
  client.createGeoProject.mockRejectedValueOnce(new WebApiError("account changed", { status: 409, code: "geo_account_changed" }));
  renderHome(); await list();
  await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
  await waitFor(() => expect(client.me).toHaveBeenCalledTimes(2));
  expect(await screen.findByRole("button", { name: "新建项目" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "重试同一创建请求" })).toBeNull();
  expect(client.createGeoProject).toHaveBeenCalledTimes(1);
});

it("keeps a same-key retry recoverable when another tab's initial request receives an old-server 400", async () => {
  const delayed = deferred<never>();
  client.createGeoProject.mockReturnValueOnce(delayed.promise);
  renderHome(); await list();
  await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
  const key = "evimed.geo.create.v1:tenant:alice:generation-a";
  const inOtherTab = JSON.stringify({ kind: "unknown", requestKey: client.createGeoProject.mock.calls[0][0].requestKey, retried: true });
  await act(async () => {
    localStorage.setItem(key, inOtherTab);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: inOtherTab }));
    delayed.reject(new WebApiError("unsupported field", { status: 400, code: "geo_payload_invalid" }));
  });
  expect(localStorage.getItem(key)).toBe(inOtherTab);
  expect(screen.getByRole("button", { name: "重试同一创建请求" })).toBeEnabled();
});

it("blocks new creation when an old tab publishes a legacy marker after identity loaded", async () => {
  renderHome(); await list();
  const key = "evimed.geo.create.v1:tenant:alice";
  const marker = JSON.stringify({ kind: "unknown" });
  await act(async () => {
    localStorage.setItem(key, marker);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: marker }));
  });
  expect(await screen.findByText(/项目创建结果未知/)).toBeVisible();
  expect(screen.getByRole("button", { name: "新建项目" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "重试同一创建请求" })).toBeNull();
  expect(client.createGeoProject).not.toHaveBeenCalled();
});

it("keeps the project list available when an old server omits account generation", async () => {
  client.me.mockResolvedValue({ user: { id: "alice", name: "Alice" }, tenant: { id: "tenant" } });
  renderHome();
  expect(await list()).toHaveTextContent("玛仕度肽注射液");
  expect(await screen.findByRole("alert")).toHaveTextContent("服务器未返回确认新建请求所需的账号信息，暂时无法新建项目。");
  expect(screen.getByRole("button", { name: "新建项目" })).toBeDisabled();
  expect(client.createGeoProject).not.toHaveBeenCalled();
});

it("keeps a key conflict terminal across reload and lets the user start another request", async () => {
  client.createGeoProject.mockRejectedValueOnce(new Error("lost response"))
    .mockRejectedValueOnce(new WebApiError("key conflict", { status: 409, code: "geo_request_key_conflict" }))
    .mockResolvedValueOnce({ id: "geo_next", projectId: "p-next", sessionId: null });
  const first = renderHome(); await list();
  await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
  await userEvent.click(await screen.findByRole("button", { name: "重试同一创建请求" }));
  await screen.findByText(/此请求编号已用于另一项创建/);
  first.unmount();

  renderHome(); await list();
  expect(await screen.findByText(/此请求编号已用于另一项创建/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "重试同一创建请求" })).toBeNull();
  expect(client.createGeoProject).toHaveBeenCalledTimes(2);
  await userEvent.click(screen.getByRole("button", { name: "开始另一个项目" }));
  await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
  expect(client.createGeoProject.mock.calls[2][0].requestKey).not.toBe(client.createGeoProject.mock.calls[0][0].requestKey);
});
