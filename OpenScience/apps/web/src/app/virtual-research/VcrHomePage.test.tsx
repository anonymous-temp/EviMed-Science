import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
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
function Back() { const navigate = useNavigate(); return <button onClick={() => navigate(-1)}>浏览器返回</button>; }
function Where() { const location = useLocation(); return <p data-testid="where">{`${location.pathname}${location.search}`}</p>; }
function drawHome(path = "/app/virtual-research") { return render(<MemoryRouter initialEntries={[path]}><VcrHomePage /><Where /></MemoryRouter>); }
const where = () => screen.getByTestId("where").textContent;
// The four examples, by what each button says; pressing one fills the composer of a new conversation and sends nothing.
const EXAMPLES: Array<[string, string, string]> = [
  ["匹配", "让 AI 匹配患者和试验", "帮我匹配患者和临床试验。资料是："],
  ["人群与患者", "让 AI 研究人群或个体患者", "帮我研究人群或个体患者。需求是："],
  ["对照研究", "让 AI 做对照研究", "帮我做对照研究。研究是："],
  ["试验", "让 AI 比较试验设计", "帮我比较临床试验设计。研究是："],
];
it.each(EXAMPLES)("opens %s as an unsent native conversation draft without creating a study", async (_label, example, draft) => {
  draw("/app/virtual-research?new=1");
  const button = await screen.findByRole("button", { name: example });
  // An example only fills the draft, and says so to the walk: it is a `draft` action, worded as one.
  expect(button).toHaveAttribute("data-action-kind", "draft");
  await userEvent.click(button);
  const location = JSON.parse(screen.getByTestId("location").textContent!);
  expect(location.path).toBe("/app/chat");
  expect(location.state.globalAssistant).toBe(true);
  expect(location.state.conversationProjectId).toBe("default");
  expect(location.state.runtimeUiIntent.projectId).toBe("default");
  expect(location.state.runtimeUiIntent.draft).toBe(draft);
  expect(location.state.capabilityId).toBeUndefined();
  expect(server.calls.filter(call => call.method === "POST")).toEqual([]);
  expect(store.select).toHaveBeenCalledWith("default", expect.any(Function));
});
// What is enough to begin, in the brief's four sentences (section 7); a field name or a statistic is never on the home.
const REQUIREMENTS = [
  "给一份病例就能开始。批量匹配需要患者数据表。",
  "说清目标人群就能开始，AI 从文献取基线。用真实队列需要患者数据表。",
  "说清研究就能先做可行性判断。估计治疗效果需要两组的结局数据。",
  "说清研究问题和终点就能开始，参数 AI 先从文献找，你可以随时改。",
];
const expectFourExamples = (scope: HTMLElement | Document = document) => {
  for (const [, example] of EXAMPLES) expect(within(scope as HTMLElement).getByRole("button", { name: example })).toBeInTheDocument();
  for (const sentence of REQUIREMENTS) expect(within(scope as HTMLElement).getByText(sentence)).toBeVisible();
  expect(scope.querySelectorAll("[data-vcr-data-requirement]")).toHaveLength(4);
  // No input box of its own, no task selector and no statistic named at the door: the conversation's composer is the only input.
  expect(within(scope as HTMLElement).queryByRole("textbox")).toBeNull();
  expect(within(scope as HTMLElement).queryByRole("radiogroup")).toBeNull();
  expect((scope instanceof Document ? scope.body : scope).textContent).not.toMatch(/显著性水平|效应与变异度|数据要求/);
};
it("keeps the empty list concise and says in four sentences what is enough to begin", async () => {
  server = installVcrServer(network.productRequest, { "GET /vcr/studies": { studies: [], reviews: [] } }); draw();
  await screen.findByText("暂无研究");
  // An empty state is a recipe: with no button of its own, it says why the list is empty and what fills it.
  expect(screen.getByText("暂无研究").closest("[data-empty]")).toHaveAttribute("data-reason");
  await userEvent.click(screen.getByRole("button", { name: "新研究" }));
  expectFourExamples();
  expect(screen.queryByRole("textbox", { name: "研究问题" })).toBeNull();
});
it("opens ?new=1 without creating a form or a study", async () => {
  draw("/app/virtual-research?new=1"); await screen.findByRole("button", { name: "让 AI 匹配患者和试验" });
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
it("keeps the existing research list and search when a refresh fails, then retries", async () => {
  const home = fixture("ev201/home.json"); let requests = 0;
  server = installVcrServer(network.productRequest, { "GET /vcr/studies": () => { if (++requests === 2) throw new WebApiError("offline", { status: 503 }); return home; } });
  draw(); await screen.findByRole("link", { name: /GLP-1 周制剂/ });
  await userEvent.type(screen.getByRole("searchbox", { name: "搜索研究" }), "GLP-1");
  await userEvent.click(screen.getByRole("button", { name: "刷新研究列表" }));
  expect(await screen.findByRole("button", { name: "重试" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /GLP-1 周制剂/ })).toBeInTheDocument();
  expect(screen.getByRole("searchbox", { name: "搜索研究" })).toHaveValue("GLP-1");
  await userEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "重试" })).toBeNull());
  expect(requests).toBe(3);
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
  expect(screen.queryByRole("radio", { name: "匹配" })).toBeNull();
  expect(document.querySelector("[data-vcr-method-catalogue]")).toBeNull();
});
it("keeps the list visible while searching, and the four examples stay in the new-study pane", async () => {
  draw(); await screen.findByRole("link", { name: /EV-201 二线/ });
  await userEvent.type(screen.getByRole("searchbox", { name: "搜索研究" }), "none");
  expect(screen.queryByRole("list", { name: "研究示例" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "新研究" }));
  expectFourExamples();
});

// What a study's row and preview say, from the fixture's two studies: GLP-1 (nothing started) and EV-201 (three lines waiting for the reader).
const GLP = "GLP-1 周制剂 III 期：样本量与脱落情景";
const EV = "EV-201 二线 NSCLC：单臂 II 期还是随机";

it("says nothing starts at the home and promises a study only once its first result is saved", async () => {
  server = installVcrServer(network.productRequest, { "GET /vcr/studies": { studies: [], reviews: [] } }); draw();
  await screen.findByText("暂无研究");
  // The empty list says what is true: a study is listed once the assistant has saved its first result, not once a sentence is sent.
  const empty = screen.getByText("暂无研究").closest("[data-empty]")!;
  expect(empty.textContent).toContain("在对话里说明要研究什么，AI 保存第一项结果后，研究会列在这里。");
  expect(empty.textContent).not.toMatch(/选一项任务开始|发送后研究会列在这里/);
  await userEvent.click(screen.getByRole("button", { name: "新研究" }));
  // What an example does is declared: it fills the composer, and the walk holds it to that.
  expect(screen.getByRole("button", { name: "让 AI 匹配患者和试验" })).toHaveAttribute("data-action-kind", "draft");
  await userEvent.click(screen.getByRole("button", { name: "让 AI 匹配患者和试验" }));
  expect(server.calls.filter(call => call.method === "POST")).toEqual([]);
});

it("reads a paused study as 已暂停 in the list whatever its steps say, and lets the reader narrow to it", async () => {
  const home = fixture("ev201/home.json");
  const [glp, ev] = home.studies;
  home.studies = [
    { ...glp, id: "std_paused", name: "暂停中的研究", status: "paused", steps: { ...glp.steps, trial: { status: "running", requested: true } }, attention: [] },
    { ...glp, id: "std_run", name: "进行中的研究", steps: { ...glp.steps, trial: { status: "running", requested: true } }, attention: [] },
    ev,
  ];
  server = installVcrServer(network.productRequest, { "GET /vcr/studies": home });
  drawHome();
  const list = await screen.findByRole("list", { name: "研究" });
  const rows = within(list).getAllByRole("listitem");
  const line = (row: HTMLElement) => row.querySelector("[data-vcr-status]")!.textContent;
  expect(line(rows[0])).toBe("已暂停");
  expect(line(rows[1])).toBe("进行中 · 正在模拟试验方案");
  expect(studyStateOf({ ...home.studies[0] })).toBe("paused");
  await userEvent.click(screen.getByRole("button", { name: /已暂停/ }));
  expect(within(screen.getByRole("list", { name: "研究" })).getAllByRole("listitem")).toHaveLength(1);
});

it("keeps the applied state filter after a refresh took its count to zero", async () => {
  const running = fixture("ev201/home.json");
  const [glp] = running.studies;
  running.studies = [{ ...glp, id: "std_run", name: "进行中的研究", steps: { ...glp.steps, trial: { status: "running", requested: true } }, attention: [] },
    { ...glp, id: "std_idle", name: "没动的研究", attention: [] }];
  const finished = structuredClone(running);
  finished.studies[0].steps = { ...glp.steps, trial: { status: "done", requested: true } };
  let answer: unknown = running;
  server = installVcrServer(network.productRequest, { "GET /vcr/studies": () => answer });
  drawHome();
  await screen.findByRole("list", { name: "研究" });
  await userEvent.click(screen.getByRole("button", { name: /进行中/ }));
  expect(screen.getByRole("button", { name: /进行中/ })).toHaveAttribute("aria-pressed", "true");
  answer = finished;
  await userEvent.click(screen.getByRole("button", { name: "刷新研究列表" }));
  // Nothing is running now. The chip the reader chose stays, saying 0, so the empty list can be read and cleared.
  await waitFor(() => expect(screen.getByText("没有匹配的研究")).toBeInTheDocument());
  expect(screen.getByRole("button", { name: /进行中/ })).toHaveAttribute("aria-pressed", "true");
});

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
  expect(line(rows[0])).toBe("待开始");
  expect(line(rows[1])).toBe("等你 · 真实外部对照不可估计，缺 3 项数据");
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

  it("splits at desktop width: the toolbar and the list on the left, the four examples on the right, and nothing chosen for the reader", async () => {
    const { container } = drawHome();
    const rows = await screen.findByRole("list", { name: "研究" });
    expect(container.querySelector("[data-master-detail]")).toHaveAttribute("data-master-detail", "split");
    const listPane = screen.getByRole("region", { name: "研究列表" });
    const pane = screen.getByRole("region", { name: "研究预览" });
    expect(listPane).toContainElement(rows);
    expect(listPane).toContainElement(container.querySelector<HTMLElement>("[data-toolbar]"));
    expect(listPane).toContainElement(screen.getByRole("searchbox", { name: "搜索研究" }));
    // The pane is the recipe: the four examples and what each needs, and no study's preview.
    expect(within(pane).getByRole("heading", { level: 2, name: "新研究" })).toBeInTheDocument();
    expectFourExamples(pane);
    expect(container.querySelector("[data-vcr-preview]")).toBeNull();
    expect(container.querySelector("[data-page-introduction]")).toBeNull();
    expect(rows.querySelector("[aria-current]")).toBeNull();
    // With nothing chosen the pane is the new study: the page has no solid button (the examples are secondary, and 新研究 would only open the pane that is open).
    expect(within(container.querySelector<HTMLElement>("[data-page-header]")!).queryByRole("button", { name: "新研究" })).toBeNull();
    expect(container.querySelectorAll(".bg-accent")).toHaveLength(0);
    expect(where()).toBe("/app/virtual-research");
  });

  it("starts a task from the pane: an unsent draft in the native conversation", async () => {
    drawHome();
    await screen.findByRole("list", { name: "研究" });
    await userEvent.click(within(screen.getByRole("region", { name: "研究预览" })).getByRole("button", { name: "让 AI 做对照研究" }));
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
      "真实外部对照不可估计，缺 3 项数据查看缺口",
      "1 项计算在等你确认计算预算去处理",
      "「患者」这一步未完成，已算出的部分保留去处理",
    ]);
    expect(within(notes[0]).getByRole("link", { name: "查看缺口" })).toHaveAttribute("href", "/app/virtual-research/std_1/comparator");
    expect(within(notes[1]).getByRole("link", { name: "去处理" })).toHaveAttribute("href", "/app/virtual-research/std_1");
    // The seven steps, each with where it is; the grey line about an outdated result is not a thing to do.
    const steps = within(pane).getByRole("list", { name: "研究进度" });
    expect(within(steps).getAllByRole("listitem").length).toBeGreaterThan(0);
    expect(steps.querySelector("[data-vcr-step=definition]")).toHaveTextContent("已完成");
    expect(steps.querySelector("[data-vcr-step=patients]")).toHaveTextContent("未完成");
    expect(pane).not.toHaveTextContent("1 个结果已过期");
    // Its way into the study is secondary, and the four ways to start are gone from the pane while the page's button stays.
    expect(within(pane).getByRole("link", { name: "打开研究" })).toHaveAttribute("href", "/app/virtual-research/std_1");
    expect(within(pane).queryByRole("radio", { name: "匹配" })).toBeNull();
    expect(screen.getByRole("button", { name: "新研究" })).toBeInTheDocument();
    expect(within(pane).queryByRole("link", { name: "原研究对话" })).toBeNull();
  });

  it("gives the pane back to the four examples: 关闭预览 and Escape both clear the chosen study, and the address with it", async () => {
    drawHome("/app/virtual-research?study=std_1");
    const pane = await screen.findByRole("region", { name: "研究预览" });
    expect(await within(pane).findByRole("heading", { level: 2, name: EV })).toBeInTheDocument();
    expect(within(pane).queryByRole("button", { name: "让 AI 匹配患者和试验" })).toBeNull();
    await userEvent.click(within(pane).getByRole("button", { name: "关闭预览" }));
    expect(where()).toBe("/app/virtual-research");
    expect(within(pane).getByRole("heading", { level: 2, name: "新研究" })).toBeInTheDocument();
    expect(within(pane).getByRole("button", { name: "让 AI 匹配患者和试验" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: EV })).not.toHaveAttribute("aria-current");
    expect(within(pane).queryByRole("button", { name: "关闭预览" })).toBeNull();
    // A study can be chosen again, and Escape does what the button does.
    await userEvent.click(screen.getByRole("link", { name: GLP }));
    expect(where()).toBe("/app/virtual-research?study=std_2");
    expect(within(pane).getByRole("heading", { level: 2, name: GLP })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(where()).toBe("/app/virtual-research");
    expect(within(pane).getByRole("heading", { level: 2, name: "新研究" })).toBeInTheDocument();
    // With nothing chosen Escape is nobody's: the page stays as it is.
    await userEvent.keyboard("{Escape}");
    expect(where()).toBe("/app/virtual-research");
  });

  /** The page after another one: the history the browser has before the list is opened. */
  const afterAnotherPage = (path = "/app/virtual-research") =>
    render(<MemoryRouter initialEntries={["/elsewhere", path]} initialIndex={1}><VcrHomePage /><Where /><Back /></MemoryRouter>);
  const back = () => userEvent.click(screen.getByRole("button", { name: "浏览器返回" }));

  it("closes a preview the list pushed by going back to the list's own entry: one Back from the list then leaves the page", async () => {
    afterAnotherPage();
    await userEvent.click(await screen.findByRole("link", { name: EV }));
    expect(where()).toBe("/app/virtual-research?study=std_1");
    const pane = screen.getByRole("region", { name: "研究预览" });
    await userEvent.click(within(pane).getByRole("button", { name: "关闭预览" }));
    expect(where()).toBe("/app/virtual-research");
    // The entry that chose the study is gone, not copied: the entry under it was the list, and it is the current one.
    await back();
    expect(where()).toBe("/elsewhere");
  });

  it("Escape closes a pushed preview the same way", async () => {
    afterAnotherPage();
    await userEvent.click(await screen.findByRole("link", { name: EV }));
    await userEvent.keyboard("{Escape}");
    expect(where()).toBe("/app/virtual-research");
    await back();
    expect(where()).toBe("/elsewhere");
  });

  it("switching from one study to another is one preview, not a trail of them: Back from either reaches the list", async () => {
    afterAnotherPage();
    await userEvent.click(await screen.findByRole("link", { name: EV }));
    await userEvent.click(screen.getByRole("link", { name: GLP }));
    expect(where()).toBe("/app/virtual-research?study=std_2");
    // Back without closing: the list, not the study that was looked at first.
    await back();
    expect(where()).toBe("/app/virtual-research");
    await userEvent.click(screen.getByRole("link", { name: GLP }));
    await userEvent.click(screen.getByRole("link", { name: EV }));
    await userEvent.click(within(screen.getByRole("region", { name: "研究预览" })).getByRole("button", { name: "关闭预览" }));
    expect(where()).toBe("/app/virtual-research");
    await back();
    expect(where()).toBe("/elsewhere");
  });

  it("closes a preview an address opened in place: there is no list entry under it to go back to", async () => {
    afterAnotherPage("/app/virtual-research?study=std_1");
    const pane = await screen.findByRole("region", { name: "研究预览" });
    await within(pane).findByRole("heading", { level: 2, name: EV });
    await userEvent.click(within(pane).getByRole("button", { name: "关闭预览" }));
    expect(where()).toBe("/app/virtual-research");
    await back();
    expect(where()).toBe("/elsewhere");
  });

  it("a study chosen from under a deep-linked preview replaces it, and closing leaves the page in one Back", async () => {
    afterAnotherPage("/app/virtual-research?study=std_1");
    await screen.findByRole("region", { name: "研究预览" });
    await userEvent.click(await screen.findByRole("link", { name: GLP }));
    expect(where()).toBe("/app/virtual-research?study=std_2");
    await userEvent.click(within(screen.getByRole("region", { name: "研究预览" })).getByRole("button", { name: "关闭预览" }));
    await back();
    expect(where()).toBe("/elsewhere");
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
    expect(within(screen.getByRole("region", { name: "研究预览" })).getByRole("heading", { level: 2, name: "新研究" })).toBeInTheDocument();
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

  it("says the empty account's list in its own column, and keeps the four examples in the pane", async () => {
    server = installVcrServer(network.productRequest, { "GET /vcr/studies": { studies: [], reviews: [] } });
    drawHome();
    const empty = await screen.findByText("暂无研究");
    expect(screen.getByRole("region", { name: "研究列表" })).toContainElement(empty);
    expect(within(screen.getByRole("region", { name: "研究预览" })).getByRole("button", { name: "让 AI 匹配患者和试验" })).toBeInTheDocument();
    // Nothing to search or filter.
    expect(screen.queryByRole("searchbox", { name: "搜索研究" })).toBeNull();
  });

  it("opens a library at its old address on the page's own band, with no split and no view switch", async () => {
    const { container } = drawHome("/app/virtual-research?tab=models&study=std_1");
    expect(await screen.findByRole("list", { name: "保存的模型与参数" })).toBeInTheDocument();
    expect(container.querySelector("[data-master-detail]")).toBeNull();
    expect(container.querySelector("[data-page-body]")).not.toBeNull();
    expect(container.querySelector("[data-page-chrome] [data-toolbar]")).not.toBeNull();
    expect(screen.getByRole("link", { name: "回到研究列表" })).toHaveAttribute("href", "/app/virtual-research");
    expect(screen.queryByRole("button", { name: "新研究" })).toBeNull();
  });

  it("has no view switch: the libraries are reached from a study's 依据, and their old addresses open them", async () => {
    drawHome("/app/virtual-research?study=std_1");
    await screen.findByRole("list", { name: "研究" });
    expect(screen.queryByRole("button", { name: /^查看/ })).toBeNull();
    for (const label of ["参考试验", "人群定义", "模型与参数"]) expect(screen.queryByRole("menuitemradio", { name: label })).toBeNull();
    cleanup();
    for (const [tab, list] of [["precedents", "试验先例"], ["definitions", "人群定义"], ["models", "保存的模型与参数"]]) {
      const { container, unmount } = drawHome(`/app/virtual-research?tab=${tab}`);
      expect(await screen.findByRole("link", { name: "回到研究列表" })).toHaveAttribute("href", "/app/virtual-research");
      expect(container.querySelector("[data-master-detail]")).toBeNull();
      expect(container.textContent, list).toBeTruthy();
      unmount();
    }
  });
});

describe("the 研究 view below the room for both", () => {
  beforeEach(() => { width = 600; });
  it("shows the research list first and swaps to the examples without stacking them", async () => {
    const { container } = drawHome();
    await screen.findByRole("list", { name: "研究" });
    expect(container.querySelector("[data-master-detail]")).toHaveAttribute("data-master-detail", "single");
    expect(screen.queryByRole("list", { name: "研究示例" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "新研究" }));
    expect(where()).toBe("/app/virtual-research?new=1");
    expect(screen.queryByRole("list", { name: "研究" })).toBeNull();
    expect(screen.getByRole("list", { name: "研究示例" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "研究预览" }).contains(document.activeElement)).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "研究列表" }));
    expect(where()).toBe("/app/virtual-research");
    expect(screen.getByRole("list", { name: "研究" })).toBeInTheDocument();
  });
  it("reaches the examples by keyboard and returns to the focused list on browser back", async () => {
    render(<MemoryRouter initialEntries={["/app/virtual-research"]}><VcrHomePage /><Where /><Back /></MemoryRouter>);
    await screen.findByRole("list", { name: "研究" });
    await userEvent.click(screen.getByRole("button", { name: "新研究" }));
    const first = screen.getByRole("button", { name: "让 AI 匹配患者和试验" }); first.focus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "让 AI 研究人群或个体患者" })).toHaveFocus();
    expect(screen.getByText("说清目标人群就能开始，AI 从文献取基线。用真实队列需要患者数据表。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "浏览器返回" }));
    expect(where()).toBe("/app/virtual-research");
    await waitFor(() => expect(screen.getByRole("region", { name: "研究列表" }).contains(document.activeElement)).toBe(true));
  });
  it("closes the new-study pane the button pushed by going back to the list entry", async () => {
    render(<MemoryRouter initialEntries={["/elsewhere", "/app/virtual-research"]} initialIndex={1}><VcrHomePage /><Where /><Back /></MemoryRouter>);
    await screen.findByRole("list", { name: "研究" });
    await userEvent.click(screen.getByRole("button", { name: "新研究" }));
    expect(where()).toBe("/app/virtual-research?new=1");
    await userEvent.click(screen.getByRole("button", { name: "研究列表" }));
    expect(where()).toBe("/app/virtual-research");
    await userEvent.click(screen.getByRole("button", { name: "浏览器返回" }));
    expect(where()).toBe("/elsewhere");
  });
  it("preserves the search when returning from a selected study", async () => {
    drawHome(); await screen.findByRole("list", { name: "研究" });
    const search = screen.getByRole("searchbox", { name: "搜索研究" });
    await userEvent.type(search, "GLP-1"); await userEvent.click(screen.getByRole("link", { name: GLP }));
    await userEvent.click(screen.getByRole("button", { name: "研究列表" }));
    expect(screen.getByRole("searchbox", { name: "搜索研究" })).toHaveValue("GLP-1");
    expect(screen.queryByRole("link", { name: EV })).toBeNull();
  });
  it("shows only requested or active tasks in the study preview", async () => {
    const home = fixture("ev201/home.json");
    home.studies[1].steps = { definition: { status: "done", requested: true }, trial: { status: "none", requested: false }, comparator: { status: "running", requested: false } };
    installVcrServer(network.productRequest, { "GET /vcr/studies": home });
    drawHome("/app/virtual-research?study=std_1");
    const steps = await screen.findByRole("list", { name: "研究进度" });
    expect(steps.querySelector("[data-vcr-step=definition]")).toBeInTheDocument();
    expect(steps.querySelector("[data-vcr-step=comparator]")).toBeInTheDocument();
    expect(steps.querySelector("[data-vcr-step=trial]")).toBeNull();
    expect(screen.queryByText("数据层级")).toBeNull();
  });
  it("swaps to a selected study and returns to the retained list", async () => {
    drawHome(); await userEvent.click(await screen.findByRole("link", { name: EV }));
    expect(where()).toBe("/app/virtual-research?study=std_1");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { name: EV })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开研究" })).toHaveAttribute("href", "/app/virtual-research/std_1");
    expect(screen.queryByRole("list", { name: "研究" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "研究列表" }));
    expect(screen.getByRole("list", { name: "研究" })).toBeInTheDocument();
  });
  it("opens the study named by a deep link", async () => {
    drawHome("/app/virtual-research?study=std_2");
    expect(await screen.findByRole("heading", { name: GLP })).toBeInTheDocument();
  });
});

describe("the studies a conversation made (VCR remediation F1)", () => {
  beforeEach(() => { width = 1100; });
  const made = (over: Record<string, unknown> = {}) => ({ id: "std_conv", projectId: "default", name: "帮我匹配患者和临床试验", question: null, status: "active", originatingSessionId: "sess_1", tabs: ["matching", "data"], updatedAt: "今天 10:12", createdAt: "2026-11-01T02:12:00.000Z", ...over });
  const serve = (home: Record<string, unknown>) => installVcrServer(network.productRequest, { "GET /vcr/studies": home });

  it("lists each in a list of its own with what it holds, and a press opens its page where it holds something", async () => {
    const home = fixture("ev201/home.json");
    serve({ ...home, conversationStudies: [made(), made({ id: "std_pop", name: "生成一个虚拟人群", tabs: ["population"], updatedAt: "昨天 09:00" })] });
    drawHome();
    const rows = await screen.findByRole("list", { name: "对话里的研究" });
    const first = within(rows).getByRole("link", { name: "帮我匹配患者和临床试验" });
    expect(first).toHaveAttribute("href", "/app/virtual-research/std_conv/matching");
    expect(first.closest("li")!.textContent).toContain("匹配 · 依据");
    expect(first.closest("li")!.textContent).toContain("今天 10:12");
    expect(within(rows).getByRole("link", { name: "生成一个虚拟人群" })).toHaveAttribute("href", "/app/virtual-research/std_pop/population");
    // The module's own studies are still their own list, and a press on one of them still previews it.
    expect(within(await screen.findByRole("list", { name: "研究" })).getByRole("link", { name: EV })).toHaveAttribute("href", "/app/virtual-research?study=std_1");
    expect(within(await screen.findByRole("list", { name: "研究" })).queryByRole("link", { name: "帮我匹配患者和临床试验" })).toBeNull();
  });

  it("is the list when the module has no study of its own: the empty state is not drawn, and the examples stay in the pane", async () => {
    serve({ studies: [], reviews: [], draftProjectIds: [], conversationStudies: [made()] });
    drawHome();
    const rows = await screen.findByRole("list", { name: "对话里的研究" });
    expect(within(rows).getByRole("link", { name: "帮我匹配患者和临床试验" })).toBeInTheDocument();
    expect(screen.queryByText("暂无研究")).toBeNull();
    expect(screen.queryByRole("list", { name: "研究" })).toBeNull();
    expect(within(screen.getByRole("region", { name: "研究预览" })).getByRole("button", { name: "让 AI 匹配患者和试验" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "搜索研究" })).toBeInTheDocument();
  });

  it("says the list is empty only when both lists are, and says when it could not read the conversations' studies", async () => {
    serve({ studies: [], reviews: [], draftProjectIds: [], conversationStudies: [] });
    drawHome();
    expect(await screen.findByText("暂无研究")).toBeInTheDocument();
    cleanup();
    serve({ studies: [], reviews: [], draftProjectIds: [], conversationStudiesUnreadable: true });
    drawHome();
    expect(await screen.findByText("对话里的研究暂时无法读取。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("is searched with the rest, and has no state, so a chosen state leaves it out", async () => {
    serve({ ...fixture("ev201/home.json"), conversationStudies: [made(), made({ id: "std_pop", name: "生成一个虚拟人群", tabs: ["population"] })] });
    drawHome();
    await screen.findByRole("list", { name: "对话里的研究" });
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索研究" }), "虚拟人群");
    const rows = screen.getByRole("list", { name: "对话里的研究" });
    expect(within(rows).queryByRole("link", { name: "帮我匹配患者和临床试验" })).toBeNull();
    expect(within(rows).getByRole("link", { name: "生成一个虚拟人群" })).toBeInTheDocument();
    await userEvent.clear(screen.getByRole("searchbox", { name: "搜索研究" }));
    await userEvent.click(screen.getByRole("button", { name: /等你/ }));
    expect(screen.queryByRole("list", { name: "对话里的研究" })).toBeNull();
  });

  it("is never taken for a study the page can preview: no preview, no study address", async () => {
    serve({ ...fixture("ev201/home.json"), conversationStudies: [made()] });
    drawHome("/app/virtual-research?study=std_conv");
    await screen.findByRole("list", { name: "对话里的研究" });
    expect(document.querySelector("[data-vcr-preview]")).toBeNull();
    expect(within(screen.getByRole("region", { name: "研究预览" })).getByRole("heading", { level: 2, name: "新研究" })).toBeInTheDocument();
  });
});
