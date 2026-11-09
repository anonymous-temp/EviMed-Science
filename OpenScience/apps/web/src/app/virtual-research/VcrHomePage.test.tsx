import { expectOpaqueRuntimeUiIntent } from "@/test/runtimeUiIntentAssertions";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WEB_SESSION_ENDED_EVENT } from "@/lib/sessionLifecycle";
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
function draw(path = "/app/virtual-research?area=records") { return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/app/virtual-research" element={<VcrHomePage />} /><Route path="*" element={<Probe />} /></Routes></MemoryRouter>); }
let server: ReturnType<typeof installVcrServer>;
beforeEach(() => {
  window.dispatchEvent(new Event(WEB_SESSION_ENDED_EVENT));
  server = installVcrServer(network.productRequest); me.fetchWebMe.mockResolvedValue({ features: { vcr: true } }); store.select.mockClear();
});
afterEach(() => cleanup());
function Back() { const navigate = useNavigate(); return <button onClick={() => navigate(-1)}>浏览器返回</button>; }
function Where() { const location = useLocation(); return <p data-testid="where">{`${location.pathname}${location.search}`}</p>; }
function drawHome(path = "/app/virtual-research?area=records") { return render(<MemoryRouter initialEntries={[path]}><VcrHomePage /><Where /></MemoryRouter>); }
const where = () => screen.getByTestId("where").textContent;
const AREAS = [
  ["virtual-population", "虚拟人群", "文献可先开始"],
  ["patient-trajectory", "患者轨迹预测", "需每位患者带时间的观测和适用模型"],
  ["virtual-lab", "虚拟实验室", "设计比较可先用文献"],
  ["synthetic-control", "合成对照臂", "效果分析需结局数据"],
  ["patient-matching", "患者匹配", "需患者资料"],
];
it.each(AREAS)("opens only the addressed %s directory and forwards the exact question as an unsent draft", async (area, label, badge) => {
  draw(`/app/virtual-research?area=${area}`);
  await screen.findByRole("heading", { level: 1, name: label });
  expect(screen.getByText(badge)).toBeVisible();
  expect(screen.queryByRole("list", { name: "研究" })).toBeNull();
  expect(screen.queryByRole("button", { name: "管理专业插件" })).toBeNull();
  const submit = screen.getByRole("button", { name: "进入研究对话" });
  expect(submit).toBeDisabled();
  const question = "研究这批患者的结局。\n保留原始条件及所有未知项。";
  await userEvent.type(screen.getByRole("textbox", { name: "研究问题" }), question);
  expect(submit).toHaveAttribute("data-action-kind", "draft");
  await userEvent.click(submit);
  const location = JSON.parse(screen.getByTestId("location").textContent!);
  expect(location.path).toBe("/app/chat");
  expect(location.state.globalAssistant).toBe(true);
  expect(location.state.conversationProjectId).toBe("default");
  expect(expectOpaqueRuntimeUiIntent(location.state, "default").draft).toBe(question);
  expect(location.state.capabilityId).toBeUndefined();
  expect(server.calls).toEqual([]);
  expect(store.select).toHaveBeenCalledWith("default", expect.any(Function));
});
it("keeps examples editable, data requirements collapsed and whitespace-only questions unsent", async () => {
  drawHome("/app/virtual-research?area=virtual-population");
  const input = await screen.findByRole("textbox", { name: "研究问题" });
  const disclosure = screen.getByText("查看数据要求").closest("details");
  expect(disclosure).not.toHaveAttribute("open");
  await userEvent.click(screen.getByText("查看数据要求"));
  expect(screen.getByText("可按文献中的分布或设定开始，无需上传。用真实患者数据构建需要患者数据集；要在人群上做干预研究，还需要适用的、能推演治疗效果的模型。")).toBeVisible();
  const example = within(screen.getByRole("list", { name: "问题示例" })).getAllByRole("button")[0];
  await userEvent.click(example);
  expect(input).toHaveValue(example.textContent);
  expect(input).toHaveFocus();
  expect(where()).toBe("/app/virtual-research?area=virtual-population");
  await userEvent.clear(input); await userEvent.type(input, "   ");
  expect(screen.getByRole("button", { name: "进入研究对话" })).toBeDisabled();
  expect(server.calls).toEqual([]);
});
it("opens a generic research question without a forced specialty or a study", async () => {
  draw("/app/virtual-research?new=1");
  expect(await screen.findByRole("heading", { level: 1, name: "新研究" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "研究问题" })).not.toHaveAttribute("maxlength");
  expect(screen.queryByRole("list", { name: "问题示例" })).toBeNull();
  expect(screen.queryByText("查看数据要求")).toBeNull();
  expect(server.calls).toEqual([]);
});
it("retains an unsent question after a real route unmount and retires it at an account boundary", async () => {
  function Leave() { const navigate = useNavigate(); return <button onClick={() => navigate("/elsewhere")}>离开模块</button>; }
  render(<MemoryRouter initialEntries={["/app/virtual-research?area=virtual-population"]}><Routes>
    <Route path="/app/virtual-research" element={<><VcrHomePage /><Leave /></>} /><Route path="/elsewhere" element={<Back />} />
  </Routes></MemoryRouter>);
  const text = "需要保留的研究问题\n以及条件";
  await userEvent.type(screen.getByRole("textbox", { name: "研究问题" }), text);
  await userEvent.click(screen.getByRole("button", { name: "离开模块" }));
  expect(screen.queryByRole("textbox", { name: "研究问题" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "浏览器返回" }));
  expect(screen.getByRole("textbox", { name: "研究问题" })).toHaveValue(text);
  act(() => window.dispatchEvent(new Event(WEB_SESSION_ENDED_EVENT)));
  expect(screen.getByRole("textbox", { name: "研究问题" })).toHaveValue("");
  expect(JSON.stringify(window.history.state)).not.toContain(text);
});
it("keeps the empty records page concise and opens a separate new-question page", async () => {
  server = installVcrServer(network.productRequest, { "GET /vcr/studies": { studies: [], reviews: [] } }); drawHome();
  await screen.findByText("暂无研究");
  expect(document.querySelector("[data-master-detail]")).toBeNull();
  expect(screen.queryByRole("textbox", { name: "研究问题" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "新研究" }));
  expect(screen.getByRole("textbox", { name: "研究问题" })).toBeInTheDocument();
  expect(screen.queryByText("暂无研究")).toBeNull();
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
// Preview content comes from the selected study, never the current global project.
const GLP = "GLP-1 周制剂 III 期：样本量与脱落情景";
const EV = "EV-201 二线 NSCLC：单臂 II 期还是随机";

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
  expect(within(rows[1]).getByRole("link", { name: EV })).toHaveAttribute("href", "/app/virtual-research?area=records&study=std_1");
});

describe("one current surface for records, question entry and preview", () => {
  it("composes a full-width list with one header and toolbar, without a second task pane", async () => {
    const { container } = drawHome();
    const rows = await screen.findByRole("list", { name: "研究" });
    expect(container.querySelector("[data-master-detail]")).toBeNull();
    expect(screen.getByRole("region", { name: "研究列表" })).toContainElement(rows);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "研究记录" })).toBeInTheDocument();
    expect(container.querySelectorAll("[data-toolbar]")).toHaveLength(1);
    expect(container.querySelector("[data-page-chrome]")).toContainElement(screen.getByRole("searchbox", { name: "搜索研究" }));
    expect(screen.queryByRole("list", { name: "问题示例" })).toBeNull();
    expect(screen.queryByRole("region", { name: "研究预览" })).toBeNull();
  });
  it("replaces the list with the addressed preview and retains search on return", async () => {
    drawHome(); await screen.findByRole("list", { name: "研究" });
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索研究" }), "EV");
    await userEvent.click(screen.getByRole("link", { name: EV }));
    expect(where()).toBe("/app/virtual-research?area=records&study=std_1");
    expect(screen.queryByRole("list", { name: "研究" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: EV })).toBeInTheDocument();
    const preview = screen.getByRole("region", { name: "研究预览" });
    expect(preview).toHaveTextContent("已模拟 3 个方案");
    expect(within(preview).getByRole("link", { name: "查看缺口" })).toHaveAttribute("href", "/app/virtual-research/std_1/comparator");
    expect(within(preview).getByRole("link", { name: "打开研究" })).toHaveAttribute("href", "/app/virtual-research/std_1");
    await userEvent.click(screen.getByRole("button", { name: "研究列表" }));
    expect(screen.getByRole("searchbox", { name: "搜索研究" })).toHaveValue("EV");
    expect(screen.queryByRole("link", { name: GLP })).toBeNull();
    expect(screen.getByRole("region", { name: "研究列表" }).closest("[tabindex]")).toHaveFocus();
  });
  const afterAnotherPage = (path = "/app/virtual-research?area=records") =>
    render(<MemoryRouter initialEntries={["/elsewhere", path]} initialIndex={1}><VcrHomePage /><Where /><Back /></MemoryRouter>);
  const back = () => userEvent.click(screen.getByRole("button", { name: "浏览器返回" }));
  it("closes a pushed preview to the original records entry and Escape preserves browser history", async () => {
    afterAnotherPage();
    await userEvent.click(await screen.findByRole("link", { name: EV }));
    await userEvent.keyboard("{Escape}");
    expect(where()).toBe("/app/virtual-research?area=records");
    await back(); expect(where()).toBe("/elsewhere");
  });
  it("closes a deep-linked preview in place without adding a stale preview to history", async () => {
    afterAnotherPage("/app/virtual-research?study=std_1");
    await screen.findByRole("heading", { name: EV });
    await userEvent.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(where()).toBe("/app/virtual-research?area=records");
    await back(); expect(where()).toBe("/elsewhere");
  });
  it("returns from the new-question page without losing the records entry", async () => {
    afterAnotherPage(); await screen.findByRole("list", { name: "研究" });
    await userEvent.click(screen.getByRole("button", { name: "新研究" }));
    expect(where()).toBe("/app/virtual-research?new=1");
    await back(); expect(where()).toBe("/app/virtual-research?area=records");
    await back(); expect(where()).toBe("/elsewhere");
  });
  it("keeps each unsent area question while switching directories and using browser history", async () => {
    function Switch() { const navigate = useNavigate(); return <button onClick={() => navigate("?area=patient-trajectory")}>切换轨迹入口</button>; }
    render(<MemoryRouter initialEntries={["/app/virtual-research?area=virtual-population"]}><VcrHomePage /><Switch /><Back /></MemoryRouter>);
    await userEvent.type(screen.getByRole("textbox", { name: "研究问题" }), "队列的问题");
    await userEvent.click(screen.getByRole("button", { name: "切换轨迹入口" }));
    expect(screen.getByRole("textbox", { name: "研究问题" })).toHaveValue("");
    await userEvent.type(screen.getByRole("textbox", { name: "研究问题" }), "患者的问题");
    await back();
    expect(screen.getByRole("textbox", { name: "研究问题" })).toHaveValue("队列的问题");
    expect(server.calls).toEqual([]);
  });
  it("uses no unrelated study for a missing preview address", async () => {
    drawHome("/app/virtual-research?study=gone");
    await screen.findByRole("list", { name: "研究" });
    expect(screen.queryByRole("region", { name: "研究预览" })).toBeNull();
  });
  it("preserves original-conversation links and only requested or active work in preview", async () => {
    const home = fixture("ev201/home.json");
    home.studies[1] = { ...home.studies[1], originatingSessionId: "ses_own", steps: { definition: { status: "done", requested: true }, trial: { status: "none", requested: false }, comparator: { status: "running", requested: false } } };
    installVcrServer(network.productRequest, { "GET /vcr/studies": home });
    drawHome("/app/virtual-research?study=std_1");
    const steps = await screen.findByRole("list", { name: "研究进度" });
    expect(steps.querySelector("[data-vcr-step=definition]")).toBeInTheDocument();
    expect(steps.querySelector("[data-vcr-step=comparator]")).toBeInTheDocument();
    expect(steps.querySelector("[data-vcr-step=trial]")).toBeNull();
    expect(screen.getByRole("link", { name: "原研究对话" })).toHaveAttribute("href", "/app/virtual-research/std_1/chat");
  });
  it.each(["precedents", "definitions", "models"])("keeps the compatible %s library on its own page", async tab => {
    const { container } = drawHome(`/app/virtual-research?tab=${tab}&study=std_1`);
    expect(await screen.findByRole("link", { name: "回到研究列表" })).toHaveAttribute("href", "/app/virtual-research?area=records");
    expect(container.querySelector("[data-master-detail]")).toBeNull();
    expect(screen.queryByRole("button", { name: "新研究" })).toBeNull();
  });
});

describe("the studies a conversation made (VCR remediation F1)", () => {
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
    expect(within(await screen.findByRole("list", { name: "研究" })).getByRole("link", { name: EV })).toHaveAttribute("href", "/app/virtual-research?area=records&study=std_1");
    expect(within(await screen.findByRole("list", { name: "研究" })).queryByRole("link", { name: "帮我匹配患者和临床试验" })).toBeNull();
  });

  it("R11 each row offers 「在新对话中继续」: a new conversation in the study's project whose composer holds the study as its reference, unsent", async () => {
    serve({ ...fixture("ev201/home.json"), conversationStudies: [made({ projectId: "prj_conv" })] });
    draw();
    const rows = await screen.findByRole("list", { name: "对话里的研究" });
    await userEvent.click(within(rows).getByRole("button", { name: "“帮我匹配患者和临床试验”的操作" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "在新对话中继续" }));
    const location = JSON.parse(screen.getByTestId("location").textContent!);
    expect(location.path).toBe("/app/chat");
    expect(location.state.conversationProjectId).toBe("prj_conv");
    expect(location.state.globalAssistant).toBeUndefined();
    const intent = expectOpaqueRuntimeUiIntent(location.state, "prj_conv");
    expect(intent.draft).toBe("接着做“帮我匹配患者和临床试验”这项研究：");
    expect(intent.kind).toBe("create");
    expect(intent.vcrReference).toEqual({ studyId: "std_conv", kind: "study", objectId: "study" });
    expect(store.select).toHaveBeenCalledWith("prj_conv", expect.any(Function));
  });

  it("is the list when the module has no study of its own: the empty state is not drawn, without an extra task pane", async () => {
    serve({ studies: [], reviews: [], draftProjectIds: [], conversationStudies: [made()] });
    drawHome();
    const rows = await screen.findByRole("list", { name: "对话里的研究" });
    expect(within(rows).getByRole("link", { name: "帮我匹配患者和临床试验" })).toBeInTheDocument();
    expect(screen.queryByText("暂无研究")).toBeNull();
    expect(screen.queryByRole("list", { name: "研究" })).toBeNull();
    expect(screen.queryByRole("region", { name: "研究预览" })).toBeNull();
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
    expect(screen.queryByRole("textbox", { name: "研究问题" })).toBeNull();
  });
});
it("opens the laboratory entry at the module root without creating or reading anything", async () => {
  draw("/app/virtual-research");
  await screen.findByRole("heading", { level: 1, name: "虚拟实验室" });
  expect(screen.queryByRole("list", { name: "研究" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "研究记录" })).toBeNull();
  expect(server.calls).toEqual([]);
});
it("reads an old area address as its entrance and shares its unsent draft", async () => {
  function Switch() { const navigate = useNavigate(); return <button onClick={() => navigate("?area=virtual-cohort")}>旧地址</button>; }
  render(<MemoryRouter initialEntries={["/app/virtual-research?area=virtual-population"]}><VcrHomePage /><Switch /></MemoryRouter>);
  await userEvent.type(await screen.findByRole("textbox", { name: "研究问题" }), "同一个草稿");
  await userEvent.click(screen.getByRole("button", { name: "旧地址" }));
  expect(await screen.findByRole("heading", { level: 1, name: "虚拟人群" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "研究问题" })).toHaveValue("同一个草稿");
});
it("keeps the archive readable at its own address", async () => {
  drawHome("/app/virtual-research?area=records");
  expect(await screen.findByRole("heading", { level: 1, name: "研究记录" })).toBeInTheDocument();
});
