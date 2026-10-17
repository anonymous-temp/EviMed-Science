import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { fixture, installVcrServer } from "@/components/vcr/__fixtures__/serverFixtures";
import { VcrHomePage } from "./VcrHomePage";

// Only the network is doubled: `/api/me` and `productRequest`. The readers,
// the route functions and the page are the real ones, fed the server's own
// home payload (`ev201/home.json`).
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);

const me = vi.hoisted(() => ({ fetchWebMe: vi.fn() }));
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  fetchWebMe: me.fetchWebMe,
}));

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

const store = vi.hoisted(() => ({
  select: vi.fn(async (_projectId: string, land?: () => void) => { land?.(); }),
  load: vi.fn(async () => undefined),
}));
vi.mock("@/lib/projects", () => ({
  useProjectStore: { getState: () => ({ projects: [{ id: "prj_new" }], select: store.select, load: store.load }) },
}));

const sidebar = vi.hoisted(() => ({ hint: vi.fn(), changed: vi.fn() }));
vi.mock("@/components/vcr/useVcrProjectIds", () => ({ hintVcrDraftProject: sidebar.hint, announceVcrStudiesChanged: sidebar.changed }));

function Probe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function draw(path = "/app/virtual-research") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/virtual-research" element={<><VcrHomePage /><Probe /></>} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

const EV201 = "EV-201 二线 NSCLC：单臂 II 期还是随机";
const GLP1 = "GLP-1 周制剂 III 期：样本量与脱落情景";
const row = (name: string) => screen.getByRole("link", { name }).closest("li") as HTMLElement;
/** The page's own header (the views under it draw headers of their own). */
const pageHeader = () => within(screen.getByRole("heading", { level: 1, name: "虚拟临床研究" }).closest("header")!);

let server: ReturnType<typeof installVcrServer>;

beforeEach(() => {
  server = installVcrServer(network.productRequest, {
    "POST /vcr/studies": { id: "std_9", projectId: "prj_new", sessionId: "ses_9", status: "draft" },
  });
  me.fetchWebMe.mockReset();
  me.fetchWebMe.mockResolvedValue({ features: { vcr: true } });
  toasts.error.mockReset();
  store.select.mockClear();
  store.load.mockClear();
  sidebar.hint.mockClear();
  sidebar.changed.mockClear();
});

describe("the module being off for this account", () => {
  it("is one sentence when /api/me says so, and the list is never asked for", async () => {
    me.fetchWebMe.mockResolvedValue({ features: { vcr: false } });
    draw();
    expect(await screen.findByText("虚拟临床研究还没有在这个工作空间开放。")).toBeInTheDocument();
    expect(server.calls).toHaveLength(0);
  });

  it("is the same sentence when the route refuses", async () => {
    server = installVcrServer(network.productRequest, {
      "GET /vcr/studies": () => { throw new WebApiError("no", { status: 404, code: "vcr_not_enabled" }); },
    });
    draw();
    expect(await screen.findByText("虚拟临床研究还没有在这个工作空间开放。")).toBeInTheDocument();
  });
});

describe("the home page", () => {
  it("has one way in — 新建研究 — and none of the four action cards or the box of recent reviews", async () => {
    draw();
    await screen.findByRole("link", { name: EV201 });
    expect(screen.getAllByRole("button", { name: "新建研究" })).toHaveLength(1);
    for (const gone of [/创建虚拟队列/, /创建虚拟患者/, /构建合成对照/, /模拟临床试验/]) {
      expect(screen.queryByRole("button", { name: gone })).toBeNull();
    }
    expect(screen.queryByText("最近复核")).toBeNull();
    expect(screen.queryByText("招募待办")).toBeNull();
  });

  it("has the four views, in the order the plan names them, and the list is the first", async () => {
    draw();
    await screen.findByRole("link", { name: EV201 });
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["研究2", "方法库", "试验先例", "人群定义"]);
    expect(screen.getByRole("tab", { name: /^研究/ })).toHaveAttribute("aria-selected", "true");
  });

  it("puts the views, the filters and the search in the one toolbar above the list they act on, and has no second row of tabs", async () => {
    draw();
    await screen.findByRole("link", { name: EV201 });
    const toolbar = document.querySelector("[data-toolbar]") as HTMLElement;
    expect(document.querySelectorAll("[role=tablist]")).toHaveLength(1);
    expect(toolbar).toContainElement(screen.getByRole("tablist"));
    expect(toolbar).toContainElement(screen.getByRole("searchbox", { name: "搜索研究" }));
    const list = screen.getByRole("list", { name: "研究" });
    expect(toolbar.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("the study list", () => {
  it("lists both studies the server sent, each with its tier tag and a link to its page", async () => {
    draw();
    expect(await screen.findByRole("link", { name: EV201 })).toHaveAttribute("href", "/app/virtual-research/std_1");
    expect(screen.getByRole("link", { name: GLP1 })).toHaveAttribute("href", "/app/virtual-research/std_2");
    expect(within(row(EV201)).getByText("T0 公开资料")).toBeInTheDocument();
    expect(within(row(GLP1)).getByText("T0 公开资料")).toBeInTheDocument();
  });

  it("says on each row what it asks, what it found and how far it has come: all seven steps in order, how many are done, and the next", async () => {
    draw();
    await screen.findByRole("link", { name: EV201 });
    const ev201 = row(EV201);
    expect(within(ev201).getByText("单臂 II 期加外部对照行不行，还是必须做随机？")).toBeInTheDocument();
    expect(within(ev201).getByText("已模拟 3 个方案，成功把握 58%～74%；真实外部对照不可估计，缺 3 项数据")).toBeInTheDocument();
    expect(within(ev201).getByText("今天 09:09")).toBeInTheDocument();
    // All seven, each in its own state; the failed one says so, and the study says how far it is and what comes next.
    const progress = within(ev201).getByRole("list", { name: /^七个步骤/ });
    expect(progress).toHaveAttribute("aria-label", "七个步骤：定义已完成，证据已完成，人群已完成，患者未完成，对照已完成，试验已完成，匹配已完成");
    expect(ev201.querySelectorAll("[data-vcr-step]")).toHaveLength(7);
    expect(ev201.querySelector("[data-vcr-step='patients'][data-vcr-step-state='attention']")).not.toBeNull();
    expect(within(ev201).getByText("6/7 步")).toBeInTheDocument();
    expect(within(ev201).getByRole("link", { name: "下一步：生成虚拟患者" })).toHaveAttribute("href", "/app/virtual-research/std_1/patients");
    // A study that has concluded nothing prints no result line, and one that has begun nothing shows seven hollow steps.
    const glp1 = row(GLP1);
    expect(glp1.querySelector("[data-vcr-latest]")).toBeNull();
    expect(glp1.querySelectorAll("[data-vcr-step-state='todo']")).toHaveLength(7);
    expect(within(glp1).getByText("0/7 步")).toBeInTheDocument();
    expect(within(glp1).queryByText(/下一步/)).toBeNull();
  });

  it("makes every step word a link of its own, to the tab that holds the step, above the row's own link", async () => {
    draw();
    await screen.findByRole("link", { name: EV201 });
    const ev201 = row(EV201);
    expect(within(ev201).getByRole("link", { name: "对照" })).toHaveAttribute("href", "/app/virtual-research/std_1/comparator");
    expect(within(ev201).getByRole("link", { name: /^患者/ })).toHaveAttribute("href", "/app/virtual-research/std_1/patients");
    // Above the stretched title, so the press lands on the word and not on the row.
    expect(ev201.querySelector("[data-vcr-progress]")?.className).toContain("z-sticky");
    expect(within(ev201).getByRole("link", { name: EV201 })).toHaveAttribute("href", "/app/virtual-research/std_1");
  });

  it("names the step under way, with 进行中", async () => {
    const home = fixture("ev201/home.json");
    home.studies[0].steps.trial = { status: "running", requested: true };
    home.studies[0].steps.matching = { status: "none", requested: true };
    server = installVcrServer(network.productRequest, { "GET /vcr/studies": home });
    draw();
    await screen.findByRole("link", { name: GLP1 });
    const running = row(GLP1).parentElement?.querySelector("[data-vcr-step='trial'][data-vcr-step-state='active']");
    expect(running).not.toBeNull();
    expect(running).toHaveTextContent("试验进行中");
  });

  it("puts a study's 招募待办 on its own row, with the way to it — one column, nothing to read twice", async () => {
    draw();
    await screen.findByRole("link", { name: EV201 });
    const todo = row(EV201).querySelector("[data-vcr-todo]") as HTMLElement;
    expect(todo).not.toBeNull();
    expect(todo).toHaveTextContent("需要你 · P-0192 待确认联系，另有 2 件待办");
    expect(within(todo).getByRole("link", { name: "去确认" })).toHaveAttribute("href", "/app/virtual-research/std_1/matching");
    expect(row(GLP1).querySelector("[data-vcr-todo]")).toBeNull();
  });

  it("is rows with no todo at all where the payload has none: a recruiting role is not everyone's", async () => {
    const home = fixture("ev201/home.json");
    delete home.todos;
    delete home.reviews;
    server = installVcrServer(network.productRequest, { "GET /vcr/studies": home });
    draw();
    await screen.findByRole("link", { name: EV201 });
    expect(document.querySelector("[data-vcr-todo]")).toBeNull();
    // What the server marks as needing the reader on the study's own account is still said, with the way to it.
    const need = row(EV201).querySelector("[data-vcr-need]") as HTMLElement;
    expect(need).toHaveTextContent("需要你 · 真实外部对照不可估计，缺 3 项数据");
    expect(within(need).getByRole("link", { name: "查看缺口" })).toHaveAttribute("href", "/app/virtual-research/std_1/comparator");
  });

  it("says nothing of a need where the study has none", async () => {
    draw();
    await screen.findByRole("link", { name: GLP1 });
    expect(row(GLP1).querySelector("[data-vcr-need]")).toBeNull();
  });

  // A state is a filter only while a study is in it: 0 is not a chip.
  it("draws a state chip only for the states some study is in, with its count, and filters the list by it", async () => {
    draw();
    await screen.findByRole("link", { name: EV201 });
    const group = screen.getByRole("group", { name: "状态" });
    expect(within(group).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["全部2", "需要你1"]);
    expect(within(group).queryByRole("button", { name: /进行中/ })).toBeNull();
    await userEvent.click(within(group).getByRole("button", { name: /需要你/ }));
    expect(screen.getByRole("link", { name: EV201 })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: GLP1 })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByRole("link", { name: GLP1 })).toBeInTheDocument();
  });

  it("sorts by state when asked — what needs the reader first — and by recency otherwise, as the server lists them", async () => {
    draw();
    await screen.findByRole("link", { name: EV201 });
    const titles = () => within(screen.getByRole("list", { name: "研究" })).getAllByRole("link", { name: /^(EV-201|GLP-1)/ }).map((link) => link.textContent);
    expect(titles()).toEqual([GLP1, EV201]);
    await userEvent.click(screen.getByRole("button", { name: "排序" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "按状态" }));
    await waitFor(() => expect(titles()).toEqual([EV201, GLP1]));
  });

  it("filters by name or question from the search box, and says so when nothing matches", async () => {
    draw();
    await screen.findByRole("link", { name: EV201 });
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索研究" }), "外部对照");
    expect(screen.getByRole("link", { name: EV201 })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: GLP1 })).toBeNull();
    await userEvent.clear(screen.getByRole("searchbox", { name: "搜索研究" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索研究" }), "没有这个");
    expect(screen.getByText("没有匹配的研究")).toBeInTheDocument();
  });

  // Review L-4/L-5: 「还没有研究」 and a button, with no word on what the module is for, and 新建研究 twice as a solid button.
  it("says what it takes and what it gives, as a recipe, and offers 新建研究 once — in the empty state, with none in the header — when there is no study yet", async () => {
    server = installVcrServer(network.productRequest, { "GET /vcr/studies": { studies: [], draftProjectIds: [] } });
    draw();
    expect(await screen.findByText("还没有研究")).toBeInTheDocument();
    expect(screen.getByText(/^用 已有证据和你的数据/)).toBeInTheDocument();
    expect(screen.getByText(/^得到 模拟人群、试验方案和样本量/)).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: "新建研究" });
    expect(buttons).toHaveLength(1);
    expect(document.querySelector("[data-empty]")).toContainElement(buttons[0]);
    expect(pageHeader().queryByRole("button")).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
    // UI-27: no sentence under the title explaining what to do.
    expect(screen.queryByText(/从上面四个动作/)).toBeNull();
  });

  it("keeps the header's 新建研究 while the list is read, when it cannot be read, and on the other views", async () => {
    server = installVcrServer(network.productRequest, { "GET /vcr/studies": () => new Promise(() => undefined) });
    draw();
    expect(pageHeader().getByRole("button", { name: "新建研究" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "新建研究" })).toHaveLength(1);
    cleanup();
    server = installVcrServer(network.productRequest, { "GET /vcr/studies": () => { throw new WebApiError("down", { status: 503, code: "vcr_unavailable" }); } });
    draw();
    await screen.findByRole("button", { name: "重试" });
    expect(pageHeader().getByRole("button", { name: "新建研究" })).toBeInTheDocument();
    cleanup();
    server = installVcrServer(network.productRequest, { "GET /vcr/studies": { studies: [], draftProjectIds: [] } });
    draw("/app/virtual-research?tab=models");
    await screen.findByRole("tab", { name: /方法库/ });
    await waitFor(() => expect(pageHeader().getByRole("button", { name: "新建研究" })).toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: "新建研究" })).toHaveLength(1);
  });

  it("creates the first study from the empty state and lands in the study's conversation view", async () => {
    server = installVcrServer(network.productRequest, {
      "GET /vcr/studies": { studies: [], draftProjectIds: [] },
      "POST /vcr/studies": { id: "std_9", projectId: "prj_new", sessionId: "ses_9", status: "draft" },
    });
    draw();
    // The header's button stands until the empty state has taken its place: wait for the state before pressing.
    await screen.findByText("还没有研究");
    await userEvent.click(screen.getByRole("button", { name: "新建研究" }));
    await waitFor(() => expect(server.calls.some((call) => call.method === "POST" && call.path === "/vcr/studies")).toBe(true));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/virtual-research/std_9/chat"));
  });

  it("offers 重试 when the list cannot be read", async () => {
    let first = true;
    server = installVcrServer(network.productRequest, {
      "GET /vcr/studies": () => {
        if (first) { first = false; throw new WebApiError("down", { status: 503, code: "vcr_unavailable" }); }
        return fixture("ev201/home.json");
      },
    });
    draw();
    await userEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByRole("link", { name: EV201 })).toBeInTheDocument();
  });
});

describe("新建研究", () => {
  // None of it opens a form (plan §9.3): the study is made as a draft and its conversation view opens with the step bar above it.
  it("makes a study with nothing said about it, tells the sidebar it is a draft, moves the shell to its project and lands in the study's own page — not the chat surface", async () => {
    draw();
    await screen.findByRole("link", { name: EV201 });
    await userEvent.click(screen.getByRole("button", { name: "新建研究" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies", "POST", {}));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/virtual-research/std_9/chat"));
    expect(screen.getByTestId("location")).not.toHaveTextContent("/app/chat");
    expect(sidebar.hint).toHaveBeenCalledWith("prj_new", "std_9");
    expect(sidebar.changed).toHaveBeenCalled();
    expect(store.select).toHaveBeenCalledWith("prj_new", expect.any(Function));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("says so when the study could not be made, and stays", async () => {
    server = installVcrServer(network.productRequest, {
      "POST /vcr/studies": () => { throw new WebApiError("no", { status: 409, code: "project_limit_reached" }); },
    });
    draw();
    await screen.findByRole("link", { name: EV201 });
    await userEvent.click(screen.getByRole("button", { name: "新建研究" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(screen.getByTestId("location")).toHaveTextContent("/app/virtual-research");
    expect(sidebar.hint).not.toHaveBeenCalled();
  });
});

describe("the home's other views", () => {
  it("keeps the chosen view in the address and reads the model library there, under the name 方法库", async () => {
    draw("/app/virtual-research?tab=models");
    expect(await screen.findByRole("tab", { name: "方法库" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(server.calls.some((call) => call.path === "/vcr/models")).toBe(true));
    expect(await screen.findByRole("button", { name: /二线 NSCLC 多西他赛组 PFS · Weibull/ })).toBeInTheDocument();
    // The study list is not on this view, and neither is its search box.
    expect(screen.queryByText("单臂 II 期加外部对照行不行，还是必须做随机？")).toBeNull();
    expect(screen.queryByRole("searchbox", { name: "搜索研究" })).toBeNull();
  });

  it("opens 试验先例 on the library", async () => {
    draw("/app/virtual-research?tab=precedents");
    await waitFor(() => expect(server.calls.some((call) => call.path === "/vcr/precedents")).toBe(true));
    expect(await screen.findByText("CTR20990001")).toBeInTheDocument();
  });

  // The page has one row of controls (DESIGN.md rule 7): the libraries hand theirs to it instead of drawing a second under it.
  it("puts 方法库's tier chips, count and 引入文献模型 in the page's one toolbar, beside the views", async () => {
    draw("/app/virtual-research?tab=models");
    await screen.findByRole("button", { name: /二线 NSCLC 多西他赛组 PFS · Weibull/ });
    const toolbars = document.querySelectorAll("[data-toolbar]");
    expect(toolbars).toHaveLength(1);
    expect(toolbars[0]).toContainElement(screen.getByRole("tablist"));
    expect(toolbars[0]).toContainElement(screen.getByRole("button", { name: "引入文献模型" }));
    expect(toolbars[0]).toHaveTextContent(/\d+ 个模型/);
    // And it is above the list it acts on.
    expect(toolbars[0].compareDocumentPosition(screen.getByRole("list", { name: "模型" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("puts 试验先例's search in the same one toolbar, and takes 方法库's controls away when the view changes", async () => {
    draw("/app/virtual-research?tab=models");
    await screen.findByRole("button", { name: "引入文献模型" });
    await userEvent.click(screen.getByRole("tab", { name: "试验先例" }));
    expect(await screen.findByText("CTR20990001")).toBeInTheDocument();
    const toolbars = document.querySelectorAll("[data-toolbar]");
    expect(toolbars).toHaveLength(1);
    expect(toolbars[0]).toContainElement(screen.getByRole("tablist"));
    expect(toolbars[0]).toContainElement(screen.getByRole("searchbox", { name: "搜索先例" }));
    expect(screen.queryByRole("button", { name: "引入文献模型" })).toBeNull();
  });

  it("calls the definitions' view 人群定义", async () => {
    draw("/app/virtual-research?tab=definitions");
    expect(await screen.findByRole("tab", { name: "人群定义" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: "人群定义库" })).toBeNull();
  });
});
