import { render, screen, waitFor, within } from "@testing-library/react";
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

const sidebar = vi.hoisted(() => ({ hint: vi.fn() }));
vi.mock("@/components/vcr/useVcrProjectIds", () => ({ hintVcrDraftProject: sidebar.hint }));

function Probe() {
  const location = useLocation();
  const state = location.state as { runtimeUiIntent?: { draft?: string } } | null;
  return <div data-testid="location">{location.pathname}<span data-testid="draft">{JSON.stringify(state?.runtimeUiIntent?.draft ?? null)}</span></div>;
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

let server: ReturnType<typeof installVcrServer>;

beforeEach(() => {
  server = installVcrServer(network.productRequest, {
    "POST /vcr/studies": { id: "std_9", projectId: "prj_new", sessionId: "ses_9", status: "draft" },
  });
  me.fetchWebMe.mockReset();
  me.fetchWebMe.mockResolvedValue({ features: { vcr: true } });
  toasts.error.mockReset();
  store.select.mockClear();
  sidebar.hint.mockClear();
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
});

describe("the study list", () => {
  it("lists both studies the server sent, each with its tier tag and a link to its page", async () => {
    draw();
    expect(await screen.findByRole("link", { name: EV201 })).toHaveAttribute("href", "/app/virtual-research/std_1");
    expect(screen.getByRole("link", { name: GLP1 })).toHaveAttribute("href", "/app/virtual-research/std_2");
    expect(within(row(EV201)).getByText("T0 公开资料")).toBeInTheDocument();
    expect(within(row(GLP1)).getByText("T0 公开资料")).toBeInTheDocument();
  });

  it("says on each row what it asks, what it found and how far it has come, in words", async () => {
    draw();
    await screen.findByRole("link", { name: EV201 });
    const ev201 = row(EV201);
    expect(within(ev201).getByText("单臂 II 期加外部对照行不行，还是必须做随机？")).toBeInTheDocument();
    expect(within(ev201).getByText("已模拟 3 个方案，成功把握 58%～74%；真实外部对照不可估计，缺 3 项数据")).toBeInTheDocument();
    expect(within(ev201).getByText("今天 09:09")).toBeInTheDocument();
    // The steps it has come through, each with its word; the failed one says so; one not started is not named.
    const progress = within(ev201).getByRole("img", { name: /定义已完成/ });
    expect(progress).toHaveAttribute("aria-label", "定义已完成，证据已完成，人群已完成，患者 未完成，对照已完成，试验已完成，匹配已完成");
    expect(ev201.querySelector("[data-vcr-step='patients'][data-vcr-step-state='attention']")).not.toBeNull();
    expect(within(ev201).getByText("未完成")).toBeInTheDocument();
    // A study that has concluded nothing prints no result line, and one that has begun nothing says so.
    const glp1 = row(GLP1);
    expect(glp1.querySelector("[data-vcr-latest]")).toBeNull();
    expect(within(glp1).getByText("还没有开始")).toBeInTheDocument();
  });

  it("stacks the progress under the conclusion below md, so a phone's row title is not squeezed to one character per line", async () => {
    draw();
    await screen.findByRole("link", { name: EV201 });
    const li = row(EV201);
    // jsdom has no layout: the contract is the classes. The right column is fixed-width only from md up.
    expect(li.className).toContain("flex-col");
    expect(li.className).toContain("md:flex-row");
    const aside = li.querySelector("[data-vcr-row-aside]") as HTMLElement;
    expect(aside.className).toContain("md:w-72");
    expect(aside.className).not.toMatch(/(^|\s)w-72(\s|$)/);
    expect(aside.className).toMatch(/(^|\s)w-full(\s|$)/);
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
    expect(todo).toHaveTextContent("P-0192 待确认联系，另有 2 件待办");
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

  it("is an empty state with 新建研究 in it when there is no study yet — and no search box", async () => {
    server = installVcrServer(network.productRequest, { "GET /vcr/studies": { studies: [], draftProjectIds: [] } });
    draw();
    expect(await screen.findByText("还没有研究")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "新建研究" })).toHaveLength(2);
    expect(screen.queryByRole("searchbox")).toBeNull();
    // UI-27: no sentence under the title explaining what to do.
    expect(screen.queryByText(/从上面四个动作/)).toBeNull();
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
  // None of it opens a form (plan §9.3): the study is made as a draft and the conversation opens with its chip, ready for the first sentence.
  it("makes a study with nothing said about it, tells the sidebar it is a draft, and lands in its conversation with an empty composer", async () => {
    draw();
    await screen.findByRole("link", { name: EV201 });
    await userEvent.click(screen.getByRole("button", { name: "新建研究" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies", "POST", {}));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/chat"));
    expect(screen.getByTestId("draft").textContent).toBe("null");
    expect(sidebar.hint).toHaveBeenCalledWith("prj_new");
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

  it("calls the definitions' view 人群定义", async () => {
    draw("/app/virtual-research?tab=definitions");
    expect(await screen.findByRole("tab", { name: "人群定义" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: "人群定义库" })).toBeNull();
  });
});
