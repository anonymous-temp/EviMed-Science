import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { VcrHomePage, studyStateOf } from "./VcrHomePage";
import { fixture, installVcrServer } from "@/components/vcr/__fixtures__/serverFixtures";

const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);
const me = vi.hoisted(() => ({ fetchWebMe: vi.fn() }));
vi.mock("@/lib/apiClient", async original => ({ ...(await original<typeof import("@/lib/apiClient")>()), fetchWebMe: me.fetchWebMe }));
const store = vi.hoisted(() => ({ currentId: "geo-project", select: vi.fn(async (_id: string, land?: () => void) => land?.()) }));
vi.mock("@/lib/projects", () => ({ useProjectStore: (selector: (state: typeof store) => unknown) => selector(store) }));
function Probe() { const location = useLocation(); return <pre data-testid="location">{JSON.stringify({ path: location.pathname, state: location.state })}</pre>; }
function draw(path = "/app/virtual-research") { return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/app/virtual-research" element={<VcrHomePage />} /><Route path="*" element={<Probe />} /></Routes></MemoryRouter>); }
let server: ReturnType<typeof installVcrServer>;
/** The page's own width as `MasterDetail` measures it (jsdom has no layout): 1100 has room for the list and the preview, 0 and 600 have not. */
let width = 0;
let rect: { mockRestore(): void };
beforeEach(() => {
  width = 0;
  rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return { width: this.hasAttribute("data-master-detail") ? width : 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) };
  });
  server = installVcrServer(network.productRequest); me.fetchWebMe.mockResolvedValue({ features: { vcr: true } }); store.select.mockClear();
});
afterEach(() => { cleanup(); rect.mockRestore(); });
function Where() { const location = useLocation(); return <p data-testid="where">{`${location.pathname}${location.search}`}</p>; }
function drawHome(path = "/app/virtual-research") { return render(<MemoryRouter initialEntries={[path]}><VcrHomePage /><Where /></MemoryRouter>); }
const where = () => screen.getByTestId("where").textContent;
it.each(["患者匹配", "人群与患者", "合成对照", "虚拟试验"])("opens %s as an unsent native conversation draft without creating a study", async label => {
  draw(); await userEvent.click(await screen.findByRole("button", { name: label }));
  const location = JSON.parse(screen.getByTestId("location").textContent!);
  expect(location.path).toBe("/app/chat");
  expect(location.state.globalAssistant).toBe(true);
  expect(location.state.conversationProjectId).toBe("default");
  expect(location.state.runtimeUiIntent.projectId).toBe("default");
  expect(location.state.runtimeUiIntent.draft).toBeTruthy();
  expect(location.state.capabilityId).toBeUndefined();
  expect(server.calls.filter(call => call.method === "POST")).toEqual([]);
  expect(store.select).toHaveBeenCalledWith("default", expect.any(Function));
});
it("keeps per-task input requirements visible on an empty account", async () => {
  server = installVcrServer(network.productRequest, { "GET /vcr/studies": { studies: [], reviews: [] } }); draw();
  await screen.findByText("研究结果会保留在这里");
  expect(document.querySelectorAll("[data-vcr-data-requirement]")).toHaveLength(4);
  expect(screen.getByText(/文献驱动的合成人群无需患者数据集/)).toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "研究问题" })).toBeNull();
});
it.each(["?new=1"])("does not reopen an old creation form or method catalogue at %s", async query => {
  draw(`/app/virtual-research${query}`); await screen.findByRole("button", { name: "患者匹配" });
  expect(screen.queryByText("方法库")).toBeNull(); expect(screen.queryByRole("textbox", { name: "研究问题" })).toBeNull();
  expect(server.calls.filter(call => call.method === "POST")).toEqual([]);
});
it("keeps study search and evidence-backed attention while ignoring historical recruitment todos", async () => {
  draw(); await screen.findByRole("link", { name: /EV-201 二线/ });
  expect(document.querySelector("[data-step-rail]")).toBeNull(); expect(document.querySelector("[data-vcr-todo]")).toBeNull();
  await userEvent.type(screen.getByRole("searchbox", { name: "搜索研究" }), "GLP-1");
  expect(screen.queryByRole("link", { name: /EV-201 二线/ })).toBeNull(); expect(screen.getByRole("link", { name: /GLP-1 周制剂/ })).toBeInTheDocument();
});
it("honors the feature flag and preserves a retry for read failures", async () => {
  me.fetchWebMe.mockResolvedValueOnce({ features: { vcr: false } }); const first = draw();
  await screen.findByText("虚拟临床研究还没有在这个工作空间开放。"); expect(server.calls).toEqual([]); first.unmount();
  server = installVcrServer(network.productRequest, { "GET /vcr/studies": () => { throw new WebApiError("offline", { status: 503 }); } }); draw();
  await screen.findByRole("button", { name: "重试" }); await userEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(server.calls.length).toBeGreaterThan(1));
});
it("counts completion against requested tasks rather than all seven methods", () => {
  expect(studyStateOf({ steps: { matching: { status: "done", requested: true }, trial: { status: "none", requested: false } }, attention: [] })).toBe("done");
  expect(studyStateOf({ steps: {}, attention: [] })).toBe("other");
  expect(studyStateOf({ steps: { matching: { status: "running" } }, attention: [] })).toBe("running");
});

it("keeps legacy calculations in a disclosure and preserves their addressed history link", async () => {
  const home = fixture("ev201/home.json");
  home.studies.push({ ...home.studies[0], id: "legacy_calc", name: "Saved calculation", purpose: "calculation" });
  installVcrServer(network.productRequest, { "GET /vcr/studies": home });
  draw();
  await screen.findByRole("list", { name: "研究" });
  expect(screen.getByRole("link", { name: "Saved calculation" }).closest("details")).not.toHaveAttribute("open");
  await userEvent.click(screen.getByText("历史独立计算 · 1"));
  expect(screen.getByRole("link", { name: "Saved calculation" })).toHaveAttribute("href", "/app/capabilities/calculations/legacy_calc");
  expect(screen.getByRole("searchbox", { name: "搜索研究" })).toBeInTheDocument();
});

it("opens saved models at the compatible address without a calculator catalogue", async () => {
  draw("/app/virtual-research?tab=models");
  expect(await screen.findByRole("list", { name: "保存的模型与参数" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "患者匹配" })).toBeNull();
  expect(document.querySelector("[data-vcr-method-catalogue]")).toBeNull();
});
it("keeps task entry above list filters when search changes and opens minimum fields by keyboard", async () => {
  draw(); await screen.findByRole("link", { name: /EV-201 二线/ });
  const introduction = document.querySelector("[data-page-introduction]")!;
  const toolbar = document.querySelector("[data-toolbar]")!;
  expect(introduction.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await userEvent.type(screen.getByRole("searchbox", { name: "搜索研究" }), "none");
  expect(screen.getByRole("button", { name: "患者匹配" })).toBeInTheDocument();
  await userEvent.click(screen.getAllByRole("button", { name: "查看最低字段与材料形式" })[0]);
  expect(screen.getByRole("dialog", { name: "患者匹配需要的材料" })).toHaveTextContent("记忆胶囊");
});

// What a study's row and preview say, from the fixture's two studies: GLP-1 (nothing started) and EV-201 (three lines waiting for the reader).
const GLP = "GLP-1 周制剂 III 期：样本量与脱落情景";
const EV = "EV-201 二线 NSCLC：单臂 II 期还是随机";

it("says in each row what asks for the reader, what is being done or how far it has come — one line, no table", async () => {
  server = installVcrServer(network.productRequest, { "GET /vcr/studies": (() => {
    const home = fixture("ev201/home.json");
    const [glp, ev] = home.studies;
    home.studies = [
      glp,
      ev,
      { ...glp, id: "std_run", name: "进行中的研究", steps: { ...glp.steps, trial: { status: "running", requested: true } }, attention: [] },
      { ...glp, id: "std_half", name: "做了一半的研究", steps: { ...glp.steps, definition: { status: "done", requested: true }, population: { status: "done", requested: true } }, attention: [] },
      { ...glp, id: "std_done", name: "做完的研究", steps: { definition: { status: "done", requested: true } }, attention: [] },
    ];
    return home;
  })() });
  drawHome();
  const rows = within(await screen.findByRole("list", { name: "研究" })).getAllByRole("listitem");
  const line = (row: HTMLElement) => row.querySelector("[data-vcr-status]")!.textContent;
  expect(line(rows[0])).toBe("还没开始");
  expect(line(rows[1])).toBe("需要你 · 真实外部对照不可估计，缺 3 项数据");
  expect(line(rows[2])).toBe("进行中 · 正在模拟试验方案");
  expect(line(rows[3])).toBe("已完成 2 / 5 步");
  expect(line(rows[4])).toBe("已完成");
  // The row is the name, the line and when it moved: the date stands at its end, and nothing in it is a button.
  expect(rows[1]).toHaveTextContent("今天 09:09");
  expect(within(rows[1]).queryAllByRole("button")).toHaveLength(0);
  expect(within(rows[1]).getByRole("link", { name: EV })).toHaveAttribute("href", "/app/virtual-research?study=std_1");
});

describe("the 研究 view beside its preview", () => {
  beforeEach(() => { width = 1100; });

  it("splits at desktop width: the toolbar and the list on the left, the four ways to start on the right, and nothing chosen for the reader", async () => {
    const { container } = drawHome();
    const rows = await screen.findByRole("list", { name: "研究" });
    expect(container.querySelector("[data-master-detail]")).toHaveAttribute("data-master-detail", "split");
    const listPane = screen.getByRole("region", { name: "研究列表" });
    const pane = screen.getByRole("region", { name: "研究预览" });
    expect(listPane).toContainElement(rows);
    expect(listPane).toContainElement(container.querySelector<HTMLElement>("[data-toolbar]"));
    expect(listPane).toContainElement(screen.getByRole("searchbox", { name: "搜索研究" }));
    // The pane is the recipe: the four ways in and what each needs, and no study's preview.
    expect(within(pane).getByRole("heading", { level: 2, name: "开始研究任务" })).toBeInTheDocument();
    for (const label of ["患者匹配", "人群与患者", "合成对照", "虚拟试验"]) expect(within(pane).getByRole("button", { name: label })).toBeInTheDocument();
    expect(container.querySelectorAll("[data-vcr-data-requirement]")).toHaveLength(4);
    expect(container.querySelector("[data-vcr-preview]")).toBeNull();
    expect(container.querySelector("[data-page-introduction]")).toBeNull();
    expect(rows.querySelector("[aria-current]")).toBeNull();
    // One solid button on the page, in the list's header, whatever is chosen.
    expect(container.querySelectorAll(".bg-accent")).toHaveLength(1);
    expect(within(container.querySelector<HTMLElement>("[data-page-header]")!).getByRole("button", { name: "开始研究对话" })).toBeInTheDocument();
    expect(where()).toBe("/app/virtual-research");
  });

  it("starts a task from the pane exactly as it did from the page: an unsent draft in the native conversation", async () => {
    drawHome();
    await screen.findByRole("list", { name: "研究" });
    await userEvent.click(within(screen.getByRole("region", { name: "研究预览" })).getByRole("button", { name: "合成对照" }));
    expect(where()).toBe("/app/chat?project=default");
    expect(server.calls.filter(call => call.method === "POST")).toEqual([]);
  });

  it("chooses a study by a press on its row — the address says which — and shows its preview in the pane", async () => {
    drawHome();
    await userEvent.click(await screen.findByRole("link", { name: EV }));
    expect(where()).toBe("/app/virtual-research?study=std_1");
    const pane = screen.getByRole("region", { name: "研究预览" });
    expect(within(pane).getByRole("heading", { level: 2, name: EV })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: EV })).toHaveAttribute("aria-current", "true");
    // The question and the finding are the study's own words; what waits for the reader is a note each, with its way on.
    expect(within(pane).getByText("单臂 II 期加外部对照行不行，还是必须做随机？")).toBeInTheDocument();
    expect(pane.querySelector("[data-vcr-latest]")).toHaveTextContent("已模拟 3 个方案");
    const notes = [...pane.querySelectorAll<HTMLElement>("[data-note]")];
    expect(notes.map((note) => note.textContent)).toEqual([
      "需要你 · 真实外部对照不可估计，缺 3 项数据查看缺口",
      "需要你 · 1 项计算在等你确认计算预算去处理",
      "需要你 · 「患者」这一步没有做完，已算出的部分保留去处理",
    ]);
    expect(within(notes[0]).getByRole("link", { name: "查看缺口" })).toHaveAttribute("href", "/app/virtual-research/std_1/comparator");
    expect(within(notes[1]).getByRole("link", { name: "去处理" })).toHaveAttribute("href", "/app/virtual-research/std_1");
    // The seven steps, each with where it is; the grey line about an outdated result is not a thing to do.
    const steps = within(pane).getByRole("list", { name: "七步进度" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(7);
    expect(steps.querySelector("[data-vcr-step=definition]")).toHaveTextContent("已完成");
    expect(steps.querySelector("[data-vcr-step=patients]")).toHaveTextContent("未完成");
    expect(pane).not.toHaveTextContent("1 个结果已过期");
    // Its way into the study is secondary, and the four ways to start are gone from the pane while the page's button stays.
    expect(within(pane).getByRole("link", { name: "打开研究" })).toHaveAttribute("href", "/app/virtual-research/std_1");
    expect(within(pane).queryByRole("button", { name: "患者匹配" })).toBeNull();
    expect(screen.getByRole("button", { name: "开始研究对话" })).toBeInTheDocument();
    expect(within(pane).queryByRole("link", { name: "原研究对话" })).toBeNull();
  });

  it("gives the pane back to the four ways to start: 关闭预览 and Escape both clear the chosen study, and the address with it", async () => {
    drawHome("/app/virtual-research?study=std_1");
    const pane = await screen.findByRole("region", { name: "研究预览" });
    expect(await within(pane).findByRole("heading", { level: 2, name: EV })).toBeInTheDocument();
    expect(within(pane).queryByRole("button", { name: "患者匹配" })).toBeNull();
    await userEvent.click(within(pane).getByRole("button", { name: "关闭预览" }));
    expect(where()).toBe("/app/virtual-research");
    expect(within(pane).getByRole("heading", { level: 2, name: "开始研究任务" })).toBeInTheDocument();
    expect(within(pane).getByRole("button", { name: "患者匹配" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: EV })).not.toHaveAttribute("aria-current");
    expect(within(pane).queryByRole("button", { name: "关闭预览" })).toBeNull();
    // A study can be chosen again, and Escape does what the button does.
    await userEvent.click(screen.getByRole("link", { name: GLP }));
    expect(where()).toBe("/app/virtual-research?study=std_2");
    expect(within(pane).getByRole("heading", { level: 2, name: GLP })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(where()).toBe("/app/virtual-research");
    expect(within(pane).getByRole("heading", { level: 2, name: "开始研究任务" })).toBeInTheDocument();
    // With nothing chosen Escape is nobody's: the page stays as it is.
    await userEvent.keyboard("{Escape}");
    expect(where()).toBe("/app/virtual-research");
  });

  it("leaves Escape to a field that has a use for it: the search box clears its words and the study stays chosen", async () => {
    drawHome("/app/virtual-research?study=std_1");
    const pane = await screen.findByRole("region", { name: "研究预览" });
    await within(pane).findByRole("heading", { level: 2, name: EV });
    const search = screen.getByRole("searchbox", { name: "搜索研究" });
    await userEvent.type(search, "EV");
    await userEvent.keyboard("{Escape}");
    expect(search).toHaveValue("");
    expect(where()).toBe("/app/virtual-research?study=std_1");
    expect(within(pane).getByRole("heading", { level: 2, name: EV })).toBeInTheDocument();
  });

  it("opens the study the address names as it loads, and reads one it does not know as none chosen", async () => {
    const first = drawHome("/app/virtual-research?study=std_2");
    await screen.findByRole("list", { name: "研究" });
    expect(within(screen.getByRole("region", { name: "研究预览" })).getByRole("heading", { level: 2, name: GLP })).toBeInTheDocument();
    first.unmount();
    drawHome("/app/virtual-research?study=gone");
    await screen.findByRole("list", { name: "研究" });
    expect(within(screen.getByRole("region", { name: "研究预览" })).getByRole("heading", { level: 2, name: "开始研究任务" })).toBeInTheDocument();
  });

  it("links the study's original conversation, or its unsent question, when there is one", async () => {
    server = installVcrServer(network.productRequest, { "GET /vcr/studies": (() => {
      const home = fixture("ev201/home.json");
      home.studies[0] = { ...home.studies[0], originatingSessionId: "ses_1", draftText: "先问" };
      home.studies[1] = { ...home.studies[1], originatingSessionId: "ses_2" };
      return home;
    })() });
    drawHome("/app/virtual-research?study=std_2");
    const pane = await screen.findByRole("region", { name: "研究预览" });
    expect(await within(pane).findByRole("link", { name: "继续未发送的研究问题" })).toHaveAttribute("href", "/app/virtual-research/std_2/chat");
    await userEvent.click(screen.getByRole("link", { name: EV }));
    expect(within(pane).getByRole("link", { name: "原研究对话" })).toHaveAttribute("href", "/app/virtual-research/std_1/chat");
  });

  it("keeps the search and the state chips in the list's column, and the legacy history below the list", async () => {
    const home = fixture("ev201/home.json");
    home.studies.push({ ...home.studies[0], id: "legacy_calc", name: "Saved calculation", purpose: "calculation" });
    installVcrServer(network.productRequest, { "GET /vcr/studies": home });
    drawHome();
    const listPane = screen.getByRole("region", { name: "研究列表" });
    await within(listPane).findByRole("link", { name: EV });
    await userEvent.type(within(listPane).getByRole("searchbox", { name: "搜索研究" }), "GLP-1");
    expect(within(listPane).queryByRole("link", { name: EV })).toBeNull();
    expect(within(listPane).getByRole("link", { name: GLP })).toBeInTheDocument();
    // A calculation is a link to its own page, never a preview.
    await userEvent.click(within(listPane).getByText("历史独立计算 · 1"));
    expect(within(listPane).getByRole("link", { name: "Saved calculation" })).toHaveAttribute("href", "/app/capabilities/calculations/legacy_calc");
  });

  it("says the empty account's list in its own column, and keeps the four ways to start in the pane", async () => {
    server = installVcrServer(network.productRequest, { "GET /vcr/studies": { studies: [], reviews: [] } });
    drawHome();
    const empty = await screen.findByText("研究结果会保留在这里");
    expect(screen.getByRole("region", { name: "研究列表" })).toContainElement(empty);
    expect(within(screen.getByRole("region", { name: "研究预览" })).getByRole("button", { name: "患者匹配" })).toBeInTheDocument();
    // Nothing to search or filter: the toolbar is the view switch alone.
    expect(screen.queryByRole("searchbox", { name: "搜索研究" })).toBeNull();
  });

  it("keeps the other three views exactly as they were: the page's own band, no split", async () => {
    const { container } = drawHome("/app/virtual-research?tab=models&study=std_1");
    expect(await screen.findByRole("list", { name: "保存的模型与参数" })).toBeInTheDocument();
    expect(container.querySelector("[data-master-detail]")).toBeNull();
    expect(container.querySelector("[data-page-body]")).not.toBeNull();
    expect(container.querySelector("[data-page-chrome] [data-toolbar]")).not.toBeNull();
    expect(screen.getByRole("link", { name: "回到研究列表" })).toHaveAttribute("href", "/app/virtual-research");
    expect(screen.queryByRole("button", { name: "开始研究对话" })).toBeNull();
  });

  it("lets go of the study that was open when the view is changed", async () => {
    drawHome("/app/virtual-research?study=std_1");
    await screen.findByRole("list", { name: "研究" });
    await userEvent.click(screen.getByRole("button", { name: /^查看/ }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "参考试验" }));
    expect(where()).toBe("/app/virtual-research?tab=precedents");
  });
});

describe("the 研究 view below the room for both", () => {
  beforeEach(() => { width = 600; });

  it("is the list alone with the four ways to start over its toolbar, and nothing chosen", async () => {
    const { container } = drawHome();
    await screen.findByRole("list", { name: "研究" });
    expect(container.querySelector("[data-master-detail]")).toHaveAttribute("data-master-detail", "single");
    expect(screen.queryByRole("region", { name: "研究预览" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "患者匹配" })).toBeInTheDocument();
    expect(container.querySelector("[data-page-introduction]")!.compareDocumentPosition(container.querySelector("[data-toolbar]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("opens the preview in the drawer over the list on a press, and closing it is the address's", async () => {
    drawHome();
    await userEvent.click(await screen.findByRole("link", { name: EV }));
    expect(where()).toBe("/app/virtual-research?study=std_1");
    const drawer = await screen.findByRole("dialog", { name: EV });
    expect(within(drawer).getAllByRole("heading", { name: EV })).toHaveLength(1);
    expect(within(drawer).getByRole("link", { name: "打开研究" })).toHaveAttribute("href", "/app/virtual-research/std_1");
    expect(within(drawer).getByRole("list", { name: "七步进度" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "研究" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(where()).toBe("/app/virtual-research");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the drawer for the study the address names, as it loads", async () => {
    drawHome("/app/virtual-research?study=std_2");
    expect(await screen.findByRole("dialog", { name: GLP })).toBeInTheDocument();
  });
});
