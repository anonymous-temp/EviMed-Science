import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { GEO_SUMMARIES } from "@/components/geo/__fixtures__/geoProjects";
import { GEO_OFF_SENTENCE } from "@/components/geo/GeoStates";
import { GeoHomePage } from "./GeoHomePage";
import { expectComposed } from "@/test/expectComposed";

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

// Opening a GEO conversation switches the shell's project; that has its own
// test (useOpenGeoConversation.test.tsx). Here it is the call it makes.
vi.mock("@/components/geo/useOpenGeoConversation", () => ({ useOpenGeoConversation: () => client.open }));

function renderHome() {
  return render(<MemoryRouter initialEntries={["/app/geo"]}><GeoHomePage /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  client.useGeoFeature.mockReturnValue("on");
  client.listGeoProjects.mockResolvedValue(GEO_SUMMARIES);
  client.open.mockResolvedValue(undefined);
});

describe("循证 GEO home", () => {
  it("lists one row per product with its index, its trend against the target, and 品牌提及率 with its sample", async () => {
    renderHome();
    expect(screen.getByRole("heading", { level: 1, name: "循证 GEO" })).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "循证 GEO 项目" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);

    const masi = rows[0];
    expect(within(masi).getByRole("link", { name: "玛仕度肽注射液" })).toHaveAttribute("href", "/app/geo/geo_masi");
    expect(masi).toHaveTextContent("38");
    expect(masi).toHaveTextContent("18%");
    expect(masi).toHaveTextContent("310 次里 56 次");
    // The trend is drawn against a dashed target.
    expect(masi.querySelector("[data-geo-sparkline] [data-geo-target]")).not.toBeNull();
    // What is still open is said in body text: red is the badge's, never a
    // whole sentence (F-G10).
    const alert = within(masi).getByText("2 条讲错待处理");
    expect(alert).not.toHaveClass("text-danger");
    expect(masi.querySelector(".text-danger")).toBeNull();
    expect(masi.querySelector("[data-geo-subline]")).toHaveTextContent(/^10月1日～12月31日/);

    // Under 30 answers the rate is not shown: “样本不足”, with how few there were.
    const mitiao = rows[1];
    expect(mitiao).toHaveTextContent("样本不足");
    expect(mitiao).toHaveTextContent("12 次回答");
    expect(mitiao).not.toHaveTextContent("44%");
    expect(mitiao.querySelector(".text-danger")).toBeNull();

    // A project that did one step is in the list all the same, with “—”.
    const xinli = rows[2];
    expect(xinli).toHaveTextContent("只做了信源分析");
    expect(within(xinli).getAllByText("—")).toHaveLength(2);
  });

  it("says the severe errors in its own words beside their badge — never an engine's sentence", async () => {
    client.listGeoProjects.mockResolvedValue([
      { ...GEO_SUMMARIES[0], alert: { wrongOurs: 13, severe: 11, safety: 0, severity: "S3" } },
      { ...GEO_SUMMARIES[1], alert: { wrongOurs: 3, severe: 0, safety: 0, severity: "S2" } },
      { ...GEO_SUMMARIES[2], alert: { wrongOurs: 0, severe: 0, safety: 1, severity: null } },
    ]);
    renderHome();
    const list = await screen.findByRole("list", { name: "循证 GEO 项目" });
    const sentence = within(list).getByText("11 条严重讲错待处理");
    expect(sentence).toHaveClass("text-text-2");
    expect(sentence).not.toHaveClass("text-danger");
    expect(list.querySelectorAll("[data-severity]")).toHaveLength(1);
    expect(within(list).getByText("3 条讲错待处理")).toBeInTheDocument();
    expect(within(list).getByText("1 篇稿件的安全问题待确认")).toBeInTheDocument();
  });

  it("tells two projects of one name apart by the day each started, and leaves a single name alone", async () => {
    client.listGeoProjects.mockResolvedValue([
      { ...GEO_SUMMARIES[0], id: "geo_a", name: "波立维", startedAt: `${new Date().getFullYear()}-09-29` },
      { ...GEO_SUMMARIES[1], id: "geo_b", name: "波立维", startedAt: `${new Date().getFullYear()}-10-07` },
      { ...GEO_SUMMARIES[2], id: "geo_c", name: "玛仕度肽注射液" },
    ]);
    renderHome();
    const list = await screen.findByRole("list", { name: "循证 GEO 项目" });
    expect(within(list).getByRole("link", { name: "波立维 · 9月29日" })).toHaveAttribute("href", "/app/geo/geo_a");
    expect(within(list).getByRole("link", { name: "波立维 · 10月7日" })).toHaveAttribute("href", "/app/geo/geo_b");
    expect(within(list).getByRole("link", { name: "玛仕度肽注射液" })).toBeInTheDocument();
  });

  it("offers 继续 on a paused project only, and sets it going again where the reader is looking", async () => {
    client.listGeoProjects.mockResolvedValue([
      { ...GEO_SUMMARIES[0], id: "geo_a", status: "paused" },
      { ...GEO_SUMMARIES[1], id: "geo_b", status: "active" },
    ]);
    client.patchGeoProject.mockResolvedValue({});
    renderHome();
    const list = await screen.findByRole("list", { name: "循证 GEO 项目" });
    const rows = within(list).getAllByRole("listitem");
    expect(within(rows[0]).getByText(/已暂停/)).toBeInTheDocument();
    expect(within(rows[1]).queryByRole("button", { name: /继续/ })).not.toBeInTheDocument();
    await userEvent.click(within(rows[0]).getByRole("button", { name: "继续“玛仕度肽注射液”" }));
    await waitFor(() => expect(client.patchGeoProject).toHaveBeenCalledWith("geo_a", { status: "active" }));
    // The row no longer says paused and no longer offers it; the list was not re-read.
    await waitFor(() => expect(within(rows[0]).queryByRole("button", { name: /继续/ })).not.toBeInTheDocument());
    expect(within(rows[0]).queryByText(/已暂停/)).not.toBeInTheDocument();
    expect(client.listGeoProjects).toHaveBeenCalledTimes(1);
  });

  // R19 (audit D C4): 继续 stood among the data columns and read 「继续 | 未测 | 未测」. It is under the name, after the status it changes.
  it("puts 继续 after 已暂停 under the project's name — not among the values on the right — and leaves the data columns whole", async () => {
    client.listGeoProjects.mockResolvedValue([{ ...GEO_SUMMARIES[0], id: "geo_a", status: "paused" }]);
    renderHome();
    const row = within(await screen.findByRole("list", { name: "循证 GEO 项目" })).getByRole("listitem");
    const resume = within(row).getByRole("button", { name: /继续/ });
    const subline = row.querySelector("[data-geo-subline]")!;
    expect(subline).toContainElement(resume);
    expect(subline).toHaveTextContent(/已暂停\s*继续$/);
    // The values on the right are the index and the mention rate, and no button.
    const values = row.querySelector(".w-16")!.parentElement!;
    expect(within(values).queryByRole("button")).not.toBeInTheDocument();
  });

  it("orders two or more projects by their latest activity, or the ones that need the reader first, and draws no order for one", async () => {
    client.listGeoProjects.mockResolvedValue([
      { ...GEO_SUMMARIES[0], id: "geo_a", name: "安静的项目", updatedAt: "2026-10-12T00:00:00Z", alert: { wrongOurs: 0, severe: 0, safety: 0 } },
      { ...GEO_SUMMARIES[1], id: "geo_b", name: "有严重讲错的项目", updatedAt: "2026-10-01T00:00:00Z", alert: { wrongOurs: 3, severe: 2, safety: 0, severity: "S3" } },
      { ...GEO_SUMMARIES[0], id: "geo_c", name: "停了的项目", status: "paused", updatedAt: "2026-10-13T00:00:00Z", alert: { wrongOurs: 0, severe: 0, safety: 0 } },
    ]);
    const { unmount } = renderHome();
    const names = () => within(screen.getByRole("list", { name: "循证 GEO 项目" })).getAllByRole("link").map((link) => link.textContent);
    await screen.findByRole("list", { name: "循证 GEO 项目" });
    expect(names()).toEqual(["停了的项目", "安静的项目", "有严重讲错的项目"]);
    const toolbar = screen.getByRole("group", { name: "项目排序" });
    expect(toolbar).toHaveTextContent("3 个项目");
    await userEvent.click(within(toolbar).getByRole("button", { name: "需要处理的在前" }));
    expect(names()).toEqual(["有严重讲错的项目", "安静的项目", "停了的项目"]);
    unmount();
    client.listGeoProjects.mockResolvedValue([GEO_SUMMARIES[0]]);
    renderHome();
    await screen.findByRole("list", { name: "循证 GEO 项目" });
    expect(screen.queryByRole("group", { name: "项目排序" })).not.toBeInTheDocument();
  });

  it("keeps 继续 when the project cannot be set going, and says so", async () => {
    client.listGeoProjects.mockResolvedValue([{ ...GEO_SUMMARIES[0], id: "geo_a", status: "paused" }]);
    client.patchGeoProject.mockRejectedValue(new WebApiError("no", { status: 403, code: "geo_forbidden" }));
    renderHome();
    await userEvent.click(await screen.findByRole("button", { name: /^继续/ }));
    await waitFor(() => expect(client.patchGeoProject).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: /^继续/ })).toBeInTheDocument();
  });

  it("creates a project and lands in its conversation — no form", async () => {
    client.createGeoProject.mockResolvedValue({ id: "geo_new", projectId: "p-new", sessionId: "ses_new" });
    renderHome();
    await screen.findByRole("list", { name: "循证 GEO 项目" });
    await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
    await waitFor(() => expect(client.open).toHaveBeenCalledWith({ projectId: "p-new", sessionId: "ses_new" }));
    expect(client.createGeoProject).toHaveBeenCalledWith({});
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("says what the module is for in one sentence when there is no project, and offers 新建项目 once — in the empty state, not in the header", async () => {
    client.listGeoProjects.mockResolvedValue([]);
    renderHome();
    expect(await screen.findByText("还没有循证 GEO 项目")).toBeInTheDocument();
    const sentence = screen.getByText("药企和医生在这里研究并传播自己产品的循证依据，也能看到各家 AI 是怎么表达的。");
    const buttons = screen.getAllByRole("button", { name: "新建项目" });
    expect(buttons).toHaveLength(1);
    expect(sentence.parentElement).toContainElement(buttons[0]);
    expect(buttons[0]).toBeEnabled();
    // The header is the title alone: the page has one solid button, and it is the one in the empty state.
    expect(within(screen.getByRole("banner")).queryByRole("button")).not.toBeInTheDocument();
  });

  it("creates the first project from the empty state and lands in its conversation", async () => {
    client.listGeoProjects.mockResolvedValue([]);
    client.createGeoProject.mockResolvedValue({ id: "geo_new", projectId: "p-new", sessionId: "ses_new" });
    renderHome();
    await screen.findByText("还没有循证 GEO 项目");
    await userEvent.click(screen.getByRole("button", { name: "新建项目" }));
    await waitFor(() => expect(client.open).toHaveBeenCalledWith({ projectId: "p-new", sessionId: "ses_new" }));
    expect(client.createGeoProject).toHaveBeenCalledWith({});
  });

  it("keeps the header's 新建项目, not yet pressable, while the list is read — and has no second one in the page", async () => {
    client.listGeoProjects.mockReturnValue(new Promise(() => undefined));
    renderHome();
    const header = within(screen.getByRole("banner")).getByRole("button", { name: "新建项目" });
    expect(header).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "新建项目" })).toHaveLength(1);
  });

  it("offers a retry when the list cannot be read", async () => {
    client.listGeoProjects.mockRejectedValueOnce(new WebApiError("down", { status: 503, code: "geo_unavailable" }));
    renderHome();
    await userEvent.click(await screen.findByRole("button", { name: /重试/ }));
    expect(await screen.findByRole("list", { name: "循证 GEO 项目" })).toBeInTheDocument();
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
  it("has its header with one primary action, the order over the list, and no button among the data columns", async () => {
    client.listGeoProjects.mockResolvedValue([{ ...GEO_SUMMARIES[0], status: "paused" }, GEO_SUMMARIES[1]]);
    const { container } = renderHome();
    await screen.findByRole("list", { name: "循证 GEO 项目" });
    expectComposed(container, { tablists: 0, stepRail: false, toolbar: true });
    // 继续 is under the name (the row's meta line); the values on the right are text.
    for (const row of within(screen.getByRole("list", { name: "循证 GEO 项目" })).getAllByRole("listitem")) {
      const values = row.querySelector(".w-16")?.parentElement;
      expect(values && within(values as HTMLElement).queryByRole("button")).toBeNull();
    }
  });
});
