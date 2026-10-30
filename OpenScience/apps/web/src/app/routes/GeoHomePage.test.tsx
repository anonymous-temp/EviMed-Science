import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { GEO_SUMMARIES } from "@/components/geo/__fixtures__/geoProjects";
import { GEO_OFF_SENTENCE } from "@/components/geo/GeoStates";
import { GEO_STEP_EMPTY, GEO_STEP_WAITING } from "@/components/geo/geoText";
import { GeoHomePage } from "./GeoHomePage";
import { compositionFacts, precedes } from "@/test/compositionFixtures";

const client = vi.hoisted(() => ({
  useGeoFeature: vi.fn(),
  listGeoProjects: vi.fn(),
  createGeoProject: vi.fn(),
  patchGeoProject: vi.fn(),
  open: vi.fn(),
}));

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
const preview = () => screen.getByRole("region", { name: "项目预览" });

beforeEach(() => {
  vi.clearAllMocks();
  width = 1100;
  rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return { width: this.hasAttribute("data-master-detail") ? width : 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) };
  });
  client.useGeoFeature.mockReturnValue("on");
  client.listGeoProjects.mockResolvedValue(GEO_SUMMARIES);
  client.open.mockResolvedValue(undefined);
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
    expect(within(masi).getByRole("link", { name: "玛仕度肽注射液" })).toHaveAttribute("href", "/app/geo?project=geo_masi");
    expect(masi).toHaveTextContent("可见度38");
    const alert = within(masi).getByText("2 条讲错待处理");
    expect(alert).not.toHaveClass("text-danger");
    expect(masi.querySelector(".text-danger")).toBeNull();

    // Otherwise it says where the project is: the window and the week.
    const mitiao = rows[1];
    expect(mitiao.querySelector("[data-geo-subline]")).toHaveTextContent(/^9月1日～11月30日/);
    expect(mitiao).toHaveTextContent("可见度61");
    expect(mitiao.querySelector(".text-danger")).toBeNull();

    // A project that did one step is in the list all the same, with “—”.
    const xinli = rows[2];
    expect(xinli).toHaveTextContent("只做了信源分析");
    expect(within(xinli).getAllByText("—")).toHaveLength(1);

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
    expect(subline).toHaveTextContent("诊断没有做完");
    expect(subline).not.toHaveTextContent("正在做");
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
    expect(sentence).toHaveClass("text-text-2");
    expect(sentence).not.toHaveClass("text-danger");
    expect(rows.querySelectorAll("[data-severity]")).toHaveLength(1);
    expect(within(rows).getByText("3 条讲错待处理")).toBeInTheDocument();
    expect(within(rows).getByText("1 篇稿件的安全问题待确认")).toBeInTheDocument();
  });

  it("tells two projects of one name apart by the day each started, and leaves a single name alone", async () => {
    client.listGeoProjects.mockResolvedValue([
      { ...GEO_SUMMARIES[0], id: "geo_a", name: "波立维", startedAt: `${new Date().getFullYear()}-09-29` },
      { ...GEO_SUMMARIES[1], id: "geo_b", name: "波立维", startedAt: `${new Date().getFullYear()}-10-07` },
      { ...GEO_SUMMARIES[2], id: "geo_c", name: "玛仕度肽注射液" },
    ]);
    renderHome();
    const rows = await list();
    expect(within(rows).getByRole("link", { name: "波立维 · 9月29日" })).toHaveAttribute("href", "/app/geo?project=geo_a");
    expect(within(rows).getByRole("link", { name: "波立维 · 10月7日" })).toHaveAttribute("href", "/app/geo?project=geo_b");
    expect(within(rows).getByRole("link", { name: "玛仕度肽注射液" })).toBeInTheDocument();
  });

  it("orders two or more projects by their latest activity, or the ones that need the reader first, and draws no order for one", async () => {
    client.listGeoProjects.mockResolvedValue([
      { ...GEO_SUMMARIES[0], id: "geo_a", name: "安静的项目", updatedAt: "2026-10-12T00:00:00Z", alert: { wrongOurs: 0, severe: 0, safety: 0 } },
      { ...GEO_SUMMARIES[1], id: "geo_b", name: "有严重讲错的项目", updatedAt: "2026-10-01T00:00:00Z", alert: { wrongOurs: 3, severe: 2, safety: 0, severity: "S3" } },
      { ...GEO_SUMMARIES[0], id: "geo_c", name: "停了的项目", status: "paused", updatedAt: "2026-10-13T00:00:00Z", alert: { wrongOurs: 0, severe: 0, safety: 0 } },
    ]);
    const { unmount } = renderHome("/app/geo?project=geo_b");
    const names = () => within(screen.getByRole("list", { name: "循证 GEO 项目" })).getAllByRole("link").map((link) => link.textContent);
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
    expect(screen.queryByRole("group", { name: "项目排序" })).not.toBeInTheDocument();
  });
});

describe("循证 GEO home — the preview beside the list", () => {
  it("splits at desktop width and shows the first project of the order, chosen by nothing", async () => {
    const { container } = renderHome();
    const rows = await list();
    expect(container.querySelector("[data-master-detail]")).toHaveAttribute("data-master-detail", "split");
    expect(within(preview()).getByRole("heading", { level: 2, name: "玛仕度肽注射液" })).toBeInTheDocument();
    // The one shown is marked in the list, and the address says nothing until a row is pressed.
    expect(within(rows).getByRole("link", { name: "玛仕度肽注射液" })).toHaveAttribute("aria-current", "true");
    expect(within(rows).getByRole("link", { name: "米曲菌胰酶片" })).not.toHaveAttribute("aria-current");
    expect(where()).toBe("/app/geo");
  });

  it("shows the two numbers with the sample each rests on, the trend against the target, the eight steps and the window", async () => {
    renderHome();
    await list();
    const view = within(preview());
    const index = view.getByRole("group", { name: "综合可见度指数" });
    expect(index).toHaveTextContent("38");
    expect(index.querySelector("[data-geo-sparkline] [data-geo-target]")).not.toBeNull();
    const mention = view.getByRole("group", { name: "品牌提及率" });
    expect(mention).toHaveTextContent("18");
    expect(mention).toHaveTextContent("310 次里 56 次");

    const steps = view.getByRole("list", { name: "八步进度" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(8);
    expect(steps.querySelector("[data-geo-step=evidence]")).toHaveTextContent("已完成");
    expect(steps.querySelector("[data-geo-step=content]")).toHaveTextContent("进行中");

    expect(view.getByText("豆包、千问、DeepSeek、元宝、Kimi")).toBeInTheDocument();
    expect(view.getByText("覆盖窗口")).toBeInTheDocument();
    expect(view.getByText("最近活动")).toBeInTheDocument();
    // What is open is a note with its way on, in body text and not in red.
    const note = view.getByText("2 条讲错待处理").closest("[data-note]")!;
    expect(within(note as HTMLElement).getByRole("link", { name: "去处理" })).toHaveAttribute("href", "/app/geo/geo_masi/accuracy");
    expect(note.querySelector(".text-danger")).toBeNull();
  });

  it("says a number that does not exist yet as such, and what measures it — once, and only while it has not been measured", async () => {
    client.listGeoProjects.mockResolvedValue([
      { ...GEO_SUMMARIES[2], id: "geo_none", name: "没开始的项目", steps: {} },
      { ...GEO_SUMMARIES[2], id: "geo_asked", name: "已排上诊断的项目", steps: { diagnosis: { status: "queued", requested: true } } },
      GEO_SUMMARIES[2],
    ]);
    renderHome();
    await list();
    const view = within(preview());
    expect(within(view.getByRole("group", { name: "综合可见度指数" })).getByText("—")).toBeInTheDocument();
    expect(view.getAllByText(GEO_STEP_EMPTY.diagnosis)).toHaveLength(1);
    await userEvent.click(screen.getByRole("link", { name: "已排上诊断的项目" }));
    expect(view.getAllByText(GEO_STEP_WAITING.diagnosis)).toHaveLength(1);
    expect(view.queryByText(GEO_STEP_EMPTY.diagnosis)).toBeNull();
    // A project whose diagnosis has run is not told to wait for it: the number's own word is the reason.
    await userEvent.click(screen.getByRole("link", { name: "注射用重组人脑利钠肽" }));
    expect(view.queryByText(GEO_STEP_EMPTY.diagnosis)).toBeNull();
    expect(view.queryByText(GEO_STEP_WAITING.diagnosis)).toBeNull();
  });

  // Under the sample floor the sample is the words, and nobody is told to wait for a measurement that has happened.
  it("says under 30 answers as 样本不足 with how few there were, and never as the number", async () => {
    renderHome("/app/geo?project=geo_mitiao");
    await list();
    const mention = within(preview()).getByRole("group", { name: "品牌提及率" });
    expect(mention).toHaveTextContent("样本不足");
    expect(mention).toHaveTextContent("12 次回答");
    expect(mention).not.toHaveTextContent("44");
    expect(within(preview()).queryByText(GEO_STEP_EMPTY.diagnosis)).toBeNull();
  });

  it("chooses a project by a press on its row — the address says which, and it survives a reload", async () => {
    const { unmount } = renderHome();
    await list();
    await userEvent.click(screen.getByRole("link", { name: "注射用重组人脑利钠肽" }));
    expect(where()).toBe("/app/geo?project=geo_xinli");
    expect(within(preview()).getByRole("heading", { level: 2, name: "注射用重组人脑利钠肽" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "注射用重组人脑利钠肽" })).toHaveAttribute("aria-current", "true");
    unmount();
    renderHome("/app/geo?project=geo_mitiao");
    await list();
    expect(within(preview()).getByRole("heading", { level: 2, name: "米曲菌胰酶片" })).toBeInTheDocument();
  });

  it("reads a project the address does not know as none chosen: the first of the order is shown", async () => {
    renderHome("/app/geo?project=geo_gone");
    await list();
    expect(within(preview()).getByRole("heading", { level: 2, name: "玛仕度肽注射液" })).toBeInTheDocument();
  });

  it("opens the project from 打开项目, and its conversation from 继续对话", async () => {
    renderHome("/app/geo?project=geo_mitiao");
    await list();
    const open = within(preview()).getByRole("link", { name: "打开项目" });
    expect(open).toHaveAttribute("href", "/app/geo/geo_mitiao");
    await userEvent.click(within(preview()).getByRole("button", { name: "继续对话" }));
    await waitFor(() => expect(client.open).toHaveBeenCalledWith({ geoId: "geo_mitiao", projectId: "p-mitiao" }));
    await userEvent.click(open);
    expect(where()).toBe("/app/geo/geo_mitiao");
  });

  it("offers 继续 on a paused project's preview only, and sets it going again where the reader is looking", async () => {
    client.listGeoProjects.mockResolvedValue([
      { ...GEO_SUMMARIES[0], id: "geo_a", status: "paused" },
      { ...GEO_SUMMARIES[1], id: "geo_b", status: "active" },
    ]);
    client.patchGeoProject.mockResolvedValue({});
    renderHome();
    const rows = within(await list()).getAllByRole("listitem");
    // The row says the state and carries no control; the preview carries the one thing to do about it.
    expect(rows[0]).toHaveTextContent("已暂停");
    expect(within(rows[0]).queryByRole("button")).not.toBeInTheDocument();
    expect(within(preview()).getByText("项目已暂停。")).toBeInTheDocument();
    await userEvent.click(within(preview()).getByRole("button", { name: "继续“玛仕度肽注射液”" }));
    await waitFor(() => expect(client.patchGeoProject).toHaveBeenCalledWith("geo_a", { status: "active" }));
    // Neither the row nor the preview says paused any more; the list was not re-read.
    await waitFor(() => expect(within(preview()).queryByText("项目已暂停。")).not.toBeInTheDocument());
    expect(within(preview()).queryByRole("button", { name: /^继续“/ })).not.toBeInTheDocument();
    expect(rows[0]).not.toHaveTextContent("已暂停");
    expect(client.listGeoProjects).toHaveBeenCalledTimes(1);
    // An active project has none to offer.
    await userEvent.click(screen.getByRole("link", { name: "米曲菌胰酶片" }));
    expect(within(preview()).queryByRole("button", { name: /^继续“/ })).not.toBeInTheDocument();
  });

  it("keeps 继续 when the project cannot be set going, and says so", async () => {
    client.listGeoProjects.mockResolvedValue([{ ...GEO_SUMMARIES[0], id: "geo_a", status: "paused" }]);
    client.patchGeoProject.mockRejectedValue(new WebApiError("no", { status: 403, code: "geo_forbidden" }));
    renderHome();
    await userEvent.click(await screen.findByRole("button", { name: "继续“玛仕度肽注射液”" }));
    await waitFor(() => expect(client.patchGeoProject).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "继续“玛仕度肽注射液”" })).toBeInTheDocument();
  });
});

describe("循证 GEO home — below the room for both", () => {
  beforeEach(() => { width = 600; });

  it("is the list alone, with nothing chosen and no drawer", async () => {
    const { container } = renderHome();
    await list();
    expect(container.querySelector("[data-master-detail]")).toHaveAttribute("data-master-detail", "single");
    expect(screen.queryByRole("region", { name: "项目预览" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "循证 GEO" })).toBeInTheDocument();
  });

  it("opens the preview in the drawer over the list on a press, and closing it is the address's", async () => {
    renderHome();
    await list();
    await userEvent.click(screen.getByRole("link", { name: "米曲菌胰酶片" }));
    expect(where()).toBe("/app/geo?project=geo_mitiao");
    const drawer = await screen.findByRole("dialog", { name: "米曲菌胰酶片" });
    // The drawer's own title names the project; the preview does not say it twice.
    expect(within(drawer).getAllByRole("heading", { name: "米曲菌胰酶片" })).toHaveLength(1);
    expect(within(drawer).getByRole("link", { name: "打开项目" })).toHaveAttribute("href", "/app/geo/geo_mitiao");
    expect(within(drawer).getByRole("group", { name: "综合可见度指数" })).toHaveTextContent("61");
    // The list stays the page behind it.
    expect(screen.getByRole("list", { name: "循证 GEO 项目" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(where()).toBe("/app/geo");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the drawer for the project the address names, as it loads", async () => {
    renderHome("/app/geo?project=geo_xinli");
    expect(await screen.findByRole("dialog", { name: "注射用重组人脑利钠肽" })).toBeInTheDocument();
  });

  it("says the first-run recipe in the page itself — one sentence and one button", async () => {
    client.listGeoProjects.mockResolvedValue([]);
    renderHome();
    expect(await screen.findByText("还没有循证 GEO 项目")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "新建项目" })).toHaveLength(1);
  });
});

describe("循证 GEO home — creating, empty, and failing", () => {
  it("creates a project and lands in its conversation — no form", async () => {
    client.createGeoProject.mockResolvedValue({ id: "geo_new", projectId: "p-new", sessionId: "ses_new" });
    renderHome();
    await list();
    await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
    await waitFor(() => expect(client.open).toHaveBeenCalledWith({ geoId: "geo_new", projectId: "p-new", sessionId: "ses_new" }));
    expect(client.createGeoProject).toHaveBeenCalledWith({});
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("is split with no project too: the list's column has the title, and the pane says what the module is for and offers 新建项目 once", async () => {
    client.listGeoProjects.mockResolvedValue([]);
    const { container } = renderHome();
    const title = await screen.findByText("还没有循证 GEO 项目");
    expect(container.querySelector("[data-master-detail]")).toHaveAttribute("data-master-detail", "split");
    expect(within(preview()).getByText(title.textContent!)).toBeInTheDocument();
    const sentence = screen.getByText("药企和医生在这里研究并传播自己产品的循证依据，也能看到各家 AI 是怎么表达的。");
    const buttons = screen.getAllByRole("button", { name: "新建项目" });
    expect(buttons).toHaveLength(1);
    expect(sentence.parentElement).toContainElement(buttons[0]);
    expect(preview()).toContainElement(buttons[0]);
    expect(buttons[0]).toBeEnabled();
    // The header is the title alone: the page has one solid button, and it is the one in the empty state.
    expect(within(container.querySelector<HTMLElement>("[data-page-header]")!).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "项目排序" })).not.toBeInTheDocument();
  });

  it("creates the first project from the empty state and lands in its conversation", async () => {
    client.listGeoProjects.mockResolvedValue([]);
    client.createGeoProject.mockResolvedValue({ id: "geo_new", projectId: "p-new", sessionId: "ses_new" });
    renderHome();
    await screen.findByText("还没有循证 GEO 项目");
    await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
    await waitFor(() => expect(client.open).toHaveBeenCalledWith({ geoId: "geo_new", projectId: "p-new", sessionId: "ses_new" }));
    expect(client.createGeoProject).toHaveBeenCalledWith({});
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
    const retry = await screen.findByRole("button", { name: /重试/ });
    expect(preview()).toContainElement(retry);
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

describe("the GEO home's composition", () => {
  it("is a list and a preview: the header with the one solid button over the list, the order's toolbar in the list's column, no tab list, no step rail", async () => {
    client.listGeoProjects.mockResolvedValue([{ ...GEO_SUMMARIES[0], status: "paused" }, GEO_SUMMARIES[1]]);
    const { container } = renderHome();
    const rows = await list();
    const facts = compositionFacts(container);
    const listPane = screen.getByRole("region", { name: "项目列表" });
    expect(container.querySelector("[data-master-detail]")).toHaveAttribute("data-master-detail", "split");
    expect(facts.tablists).toHaveLength(0);
    expect(facts.stepRails).toHaveLength(0);
    expect(facts.clickableTags).toEqual([]);
    // One toolbar, in the list's column and before the rows it orders.
    expect(facts.toolbars).toHaveLength(1);
    expect(listPane).toContainElement(facts.toolbars[0]);
    expect(precedes(facts.toolbars[0], rows)).toBe(true);
    // One solid button on the page — the header's 新建项目; the preview's ways on are secondary.
    expect(facts.header).not.toBeNull();
    expect(listPane).toContainElement(facts.header!);
    expect(facts.headerPrimaryActions).toHaveLength(1);
    expect(container.querySelectorAll(".bg-accent")).toHaveLength(1);
    // A row is a link and says its state; the values are text, and no button stands among them.
    for (const row of within(rows).getAllByRole("listitem")) expect(within(row).queryByRole("button")).toBeNull();
  });
});
