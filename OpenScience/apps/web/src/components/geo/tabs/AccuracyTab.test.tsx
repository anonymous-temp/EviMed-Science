import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeoCitedSource, GeoErrorRow, GeoProject } from "@/lib/geoClient";
import { diagnosisFilled, diagnosisWith, geoProject, monitoringFilled } from "../__fixtures__/geoTabs";
import { actionFixture, actionsFilled, clustersFilled, clusterViewFixture, G_BRAND, G_EFFECT, questionSetFixture } from "../__fixtures__/geoSpine";
import { GeoFrameHarness } from "../__fixtures__/geoFrameHarness";
import { AccuracyTab } from "./AccuracyTab";

const client = vi.hoisted(() => ({
  getGeoDiagnosis: vi.fn(),
  getGeoMonitoring: vi.fn(),
  getGeoActions: vi.fn(),
  getGeoClusters: vi.fn(),
  getGeoCluster: vi.fn(),
  getGeoQuestions: vi.fn(),
  getGeoArticles: vi.fn(),
  releaseGeoArticle: vi.fn(),
  withdrawGeoArticle: vi.fn(),
  runGeoStep: vi.fn(),
}));
vi.mock("@/lib/geoClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/geoClient")>()),
  ...client,
}));

const conversation = vi.hoisted(() => ({ open: vi.fn(async () => true) }));
vi.mock("../useOpenGeoConversation", () => ({ useOpenGeoConversation: () => conversation.open }));

function Probe() {
  const location = useLocation();
  return (
    <>
      <div data-testid="location">{location.pathname}</div>
      <div data-testid="search">{location.search}</div>
    </>
  );
}

function renderTab(project: GeoProject = geoProject(), path = "/app/geo/geo_1/accuracy") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/app/geo/geo_1/accuracy"
          element={<><GeoFrameHarness project={project} tab="accuracy"><AccuracyTab geoId="geo_1" project={project} /></GeoFrameHarness><Probe /></>}
        />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** One error row of the live shape: a claim told by one engine in answer to one question. */
function row(id: string, overrides: Partial<GeoErrorRow> = {}): GeoErrorRow {
  return {
    id,
    engine: "doubao",
    statement: "信尔美需要每天固定时间皮下注射一次",
    severity: "S3",
    errorType: "number",
    stability: "stable",
    citedSource: null,
    action: null,
    status: "open",
    snapshotId: `snap_last_${id}`,
    firstSnapshotId: `snap_first_${id}`,
    questionId: "q_brand_1",
    fingerprint: "fp_a",
    claimId: "clm_a",
    evidenceQuote: "本品每周注射一次。",
    ...overrides,
  };
}

const inline = (domain: string, attribute: GeoCitedSource["attribute"]): GeoCitedSource => ({ url: `https://${domain}/p`, domain, attribute, basis: "inline_marker" });

/** Three claims: one told by three engines, one grave one told by one, one being handled; and a closed one. */
function claims(): GeoErrorRow[] {
  return [
    row("err_1", { engine: "deepseek", citedSource: inline("baike.baidu.com", "encyclopedia"), action: "encyclopedia_fix" }),
    row("err_2", { engine: "doubao", citedSource: inline("jiankang.cn", "farm") }),
    row("err_3", { engine: "qianwen", questionId: "q_eff_1", citedSource: { url: null, domain: null, attribute: "none", basis: "no_retrieval" } }),
    row("err_4", { engine: "kimi", fingerprint: "fp_b", claimId: "clm_b", severity: "S4", statement: "哺乳期可以正常使用信尔美", evidenceQuote: "哺乳期妇女不得使用本品。", questionId: "q_safe_1", citedSource: { url: null, domain: null, attribute: null, basis: "not_attributable" }, errorType: "label_conflict" }),
    row("err_5", { engine: "deepseek", fingerprint: "fp_c", claimId: null, severity: "S2", status: "acting", statement: "漏打一天也没关系", evidenceQuote: null, questionId: "q_ctl_1", errorType: "dropped_condition" }),
    row("err_6", { engine: "doubao", fingerprint: "fp_d", claimId: null, severity: "S4", status: "closed", statement: "已经纠正的老说法", evidenceQuote: null, questionId: "q_brand_1" }),
  ];
}

const correction = actionFixture({
  key: "correct_error:ggr_brand:wrong",
  kind: "correct_error",
  need: { ...actionFixture({ key: "k", kind: "maintain" }).need, errorIds: ["err_1", "err_2"], gapClass: "wrong" },
  what: { layer: "correction", title: "纠正每天注射的说法", channel: "wechat_mp", channelNote: null },
  status: "writing",
  articleIds: ["art_fix"],
});

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  conversation.open.mockClear();
  client.getGeoDiagnosis.mockResolvedValue(diagnosisWith(claims()));
  client.getGeoMonitoring.mockResolvedValue(monitoringFilled);
  client.getGeoActions.mockResolvedValue({ ...actionsFilled, actions: [correction] });
  client.getGeoClusters.mockResolvedValue(clustersFilled);
  client.getGeoCluster.mockImplementation(async (_geoId: string, id: string) => clusterViewFixture(id));
  client.getGeoQuestions.mockResolvedValue(questionSetFixture());
  client.getGeoArticles.mockResolvedValue({
    articles: [{ id: "art_fix", layer: "correction", title: "关于每周一次用法的更正", groupId: G_BRAND, question: null, status: "draft", gate: "passed", safety: "clear", path: "articles/fix.md", runId: "run_1", claimCount: 1, placements: 0, cited: false }],
  });
  client.runGeoStep.mockResolvedValue({ sessionId: "ses_geo_1" });
});

const claimRow = (key: string): HTMLElement | null => (document.querySelector(`[data-geo-claim='${key}']`)?.closest("li") as HTMLElement | null) ?? null;
const findClaim = (key: string) => waitFor(() => {
  const found = claimRow(key);
  if (!found) throw new Error(`no row for ${key}`);
  return found;
});
const claimKeys = () => [...document.querySelectorAll("[data-geo-claim]")].map((node) => node.getAttribute("data-geo-claim"));

describe("准确与安全: the numbers", () => {
  it("leads with the accuracy rate, and says the denominator once", async () => {
    renderTab();
    const accuracy = await screen.findByRole("group", { name: "事实准确率" });
    expect(accuracy).toHaveTextContent("92");
    expect(accuracy).toHaveTextContent("目标 98%");
    expect(within(screen.getByRole("region", { name: "准确与安全" })).getAllByText(/次有效回答计算/)).toHaveLength(1);
  });
});

describe("准确与安全: the list is by claim", () => {
  it("makes one row of a claim several engines tell, with its engines, its gravest grade, where it came from and where its correction stands", async () => {
    renderTab();
    const told = await findClaim("fp_a");
    expect(told).toHaveTextContent("信尔美需要每天固定时间皮下注射一次");
    // the three engines that tell it, in one row; the server's tally decides the count of chips, not the rows
    expect(told).toHaveTextContent("千问");
    expect(told).toHaveTextContent("豆包");
    expect(told).toHaveTextContent("DeepSeek");
    expect(told.querySelector("[data-severity='S3']")).not.toBeNull();
    expect(told).toHaveTextContent("出处 baike.baidu.com（百科词条） 等 2 处");
    // the correction under way: its status is on the row and the row asks for no second one
    expect(told).toHaveTextContent("纠错稿：");
    expect(within(told).queryByRole("button", { name: "写纠错稿" })).toBeNull();
    // six error rows, four claims: the grave ones to start with
    expect(claimKeys()).toEqual(["fp_b", "fp_a"]);
  });

  it("starts on the grave ones, and every status chip carries the server's count", async () => {
    renderTab();
    await findClaim("fp_a");
    const toolbar = document.querySelector("[data-toolbar]") as HTMLElement;
    const status = within(toolbar).getByRole("group", { name: "处置状态" });
    expect(within(status).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["严重4", "待处理4", "处置中1", "全部6"].map((text) => text));
    expect(within(status).getByRole("button", { name: /严重/ })).toHaveAttribute("aria-pressed", "true");
    // the severe ones: S4 and S3 that are live
    expect(claimKeys()).toEqual(["fp_b", "fp_a"]);
    await userEvent.click(within(status).getByRole("button", { name: /^全部/ }));
    expect(claimKeys()).toEqual(["fp_b", "fp_a", "fp_c", "fp_d"]);
    // the closed one is set down, not red
    expect(claimRow("fp_d")).not.toBeNull();
    expect(screen.getByTestId("search")).toHaveTextContent("show=all");
  });

  it("starts on 全部 when nothing grave is open, and offers no chip for a status nothing is in", async () => {
    client.getGeoDiagnosis.mockResolvedValue(diagnosisFilled);
    renderTab();
    await screen.findByRole("heading", { name: "讲错清单，按严重度排序" });
    const status = within(document.querySelector("[data-toolbar]") as HTMLElement).getByRole("group", { name: "处置状态" });
    expect(within(status).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["处置中1", "全部1"]);
    expect(within(status).getByRole("button", { name: /^全部/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("says the sentence in body text and the grade in the badge: red is the badge alone", async () => {
    renderTab();
    const told = await findClaim("fp_b");
    expect(within(told).getByText(/哺乳期可以正常使用信尔美/)).not.toHaveClass("text-danger");
    expect(told.querySelector("[data-severity='S4']")).not.toBeNull();
  });

  it("offers 「写纠错稿」 on a claim nobody is correcting, and it opens the conversation with the brief in it, unsent", async () => {
    renderTab();
    const bare = await findClaim("fp_b");
    await userEvent.click(within(bare).getByRole("button", { name: "写纠错稿" }));
    await waitFor(() => expect(conversation.open).toHaveBeenCalledTimes(1));
    const [target, brief] = conversation.open.mock.calls[0] as unknown as [{ projectId: string; sessionId: string | null }, string];
    expect(target).toEqual({ projectId: "prj_geo_1", sessionId: null });
    expect(brief).toContain("哺乳期可以正常使用信尔美");
    expect(brief).toContain("说明书：哺乳期妇女不得使用本品。");
    expect(screen.queryByRole("button", { name: "问 AI" })).toBeNull();
  });

  it("shows twenty at a time, says how many more, and says how many the page cannot list", async () => {
    const rows = Array.from({ length: 30 }, (_, index) => row(`err_${index}`, {
      fingerprint: `fp_m${index}`,
      statement: `第 ${index + 1} 句不对的话`,
      severity: index < 3 ? "S3" : index < 12 ? "S2" : "S1",
      status: index === 29 ? "closed" : index < 5 ? "acting" : "open",
      questionId: null,
    }));
    // 104 errors in the project, 30 of them in the page: the server's count is the tally.
    client.getGeoDiagnosis.mockResolvedValue({ ...diagnosisWith(rows), errorCounts: { total: 104, open: 97, acting: 3, awaiting_remeasure: 0, closed: 4, severe: 3 } });
    renderTab();
    await screen.findByRole("heading", { name: "讲错清单，按严重度排序" });
    const toolbar = document.querySelector("[data-toolbar]") as HTMLElement;
    const status = within(toolbar).getByRole("group", { name: "处置状态" });
    expect(within(status).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["严重3", "待处理97", "处置中3", "全部104"]);
    expect(claimKeys()).toHaveLength(3);
    await userEvent.click(within(status).getByRole("button", { name: /^全部/ }));
    expect(claimKeys()).toHaveLength(20);
    expect(screen.getByText("这里列出了 30 条讲错，还有 74 条没有列出。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "显示更多 · 还有 10 条说法" }));
    expect(claimKeys()).toHaveLength(30);
    expect(screen.queryByRole("button", { name: /显示更多/ })).toBeNull();
    // the gravest first, the closed one last
    expect(claimKeys().slice(0, 3)).toEqual(["fp_m0", "fp_m1", "fp_m2"]);
    expect(claimKeys()[29]).toBe("fp_m29");
  });
});

describe("准确与安全: the band's toolbar", () => {
  it("holds the view switch, the status chips, the engine and group choices and the search; nothing filters from under the list", async () => {
    renderTab();
    await findClaim("fp_a");
    const toolbar = document.querySelector("[data-toolbar]") as HTMLElement;
    expect(within(toolbar).getByRole("button", { name: "按说法" })).toHaveAttribute("aria-pressed", "true");
    expect(within(toolbar).getByRole("button", { name: "按引擎" })).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: "引擎" })).toBeInTheDocument();
    expect(within(toolbar).getByRole("searchbox", { name: "搜索说法" })).toBeInTheDocument();
    for (const search of document.querySelectorAll("input[type='search']")) expect(toolbar.contains(search)).toBe(true);
    for (const group of document.querySelectorAll("[role='group'][aria-label]")) {
      if (group.closest("[data-stat-band], [data-stat-tile]") || group.getAttribute("aria-label") === "事实准确率" || group.getAttribute("aria-label") === "严重讲错") continue;
      if (group.getAttribute("aria-label") === "准确与安全") continue;
      expect(toolbar.contains(group), group.getAttribute("aria-label") ?? "").toBe(true);
    }
  });

  it("keeps the choice in the address, so the way back from an answer returns to the list as it was left", async () => {
    renderTab();
    await findClaim("fp_a");
    const status = within(document.querySelector("[data-toolbar]") as HTMLElement).getByRole("group", { name: "处置状态" });
    await userEvent.click(within(status).getByRole("button", { name: /^处置中/ }));
    expect(screen.getByTestId("search")).toHaveTextContent("show=acting");
    expect(claimKeys()).toEqual(["fp_c"]);
  });

  it("finds a claim by a word of it, and says when there is none", async () => {
    renderTab();
    await findClaim("fp_a");
    const search = within(document.querySelector("[data-toolbar]") as HTMLElement).getByRole("searchbox", { name: "搜索说法" });
    await userEvent.type(search, "哺乳期");
    expect(claimKeys()).toEqual(["fp_b"]);
    await userEvent.clear(search);
    await userEvent.type(search, "不存在的词");
    expect(await screen.findByText("没有符合的说法。")).toBeInTheDocument();
    const note = screen.getByText("没有符合的说法。").closest("[data-note]") as HTMLElement;
    await userEvent.click(within(note).getByRole("button", { name: "清除筛选" }));
    expect(claimKeys()).toEqual(["fp_b", "fp_a"]);
  });

  it("lets go of every narrowing in one step: the engine, the kind, the trace and the group together", async () => {
    renderTab(geoProject(), "/app/geo/geo_1/accuracy?show=all&engine=kimi&type=label_conflict&trace=unattributable&cluster=ggr_safety");
    await findClaim("fp_b");
    await userEvent.click(within(document.querySelector("[data-toolbar]") as HTMLElement).getByRole("button", { name: "清除筛选" }));
    const search = screen.getByTestId("search").textContent ?? "";
    for (const name of ["engine=", "type=", "trace=", "cluster="]) expect(search).not.toContain(name);
    expect(search).toContain("show=all");
    expect(claimKeys()).toEqual(["fp_b", "fp_a", "fp_c", "fp_d"]);
  });

  it("narrows to one question group by its choice, and the choice is the group's name", async () => {
    renderTab(geoProject(), "/app/geo/geo_1/accuracy?show=all");
    await findClaim("fp_a");
    await userEvent.click(within(document.querySelector("[data-toolbar]") as HTMLElement).getByRole("button", { name: /问题群/ }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "说明书安全题组" }));
    expect(screen.getByTestId("search")).toHaveTextContent("cluster=ggr_safety");
    expect(claimKeys()).toEqual(["fp_b"]);
  });
});

describe("准确与安全: by engine", () => {
  it("lists each engine's claims under its name, each counted over that engine's rows, and does not say the engine again", async () => {
    renderTab(geoProject(), "/app/geo/geo_1/accuracy?show=all&view=engines");
    await screen.findByRole("heading", { name: "讲错清单，按引擎" });
    const deepseek = (await screen.findByRole("heading", { name: "DeepSeek" })).closest("section") as HTMLElement;
    expect(within(deepseek).getAllByRole("listitem")).toHaveLength(2);
    const told = deepseek.querySelector("[data-geo-claim='fp_a']")!.closest("li") as HTMLElement;
    expect(told).not.toHaveTextContent("千问");
    expect(told).toHaveTextContent("出处 baike.baidu.com（百科词条）");
    // a claim three engines tell is a row in each of the three sections
    expect(document.querySelectorAll("[data-geo-claim='fp_a']")).toHaveLength(3);
  });
});

describe("准确与安全: a claim's drawer", () => {
  it("opens from the row at its own address, with what is said, what the label says and each engine's words as the way to its answer", async () => {
    renderTab();
    const told = await findClaim("fp_a");
    await userEvent.click(within(told).getByRole("button", { name: /信尔美需要每天固定时间皮下注射一次/ }));
    await waitFor(() => expect(screen.getByTestId("search")).toHaveTextContent("error=fp_a"));
    const drawer = await screen.findByRole("dialog");
    const record = drawer.querySelector("[data-geo-error-drawer='fp_a']") as HTMLElement;
    expect(record).toHaveTextContent("说明书：本品每周注射一次。");
    // three rows, one per engine, each the way to the answer it was first said in
    const words = within(record).getAllByRole("link", { name: /信尔美需要每天固定时间皮下注射一次/ });
    expect(words).toHaveLength(3);
    expect(words[0]).toHaveAttribute("href", "/app/geo/geo_1/answers/snap_first_err_1");
  });

  it("follows the claim to where each engine took it from, and to the group it was asked in", async () => {
    renderTab();
    await userEvent.click(within(await findClaim("fp_a")).getByRole("button", { name: /信尔美需要每天固定时间皮下注射一次/ }));
    const record = (await screen.findByRole("dialog")).querySelector("[data-geo-error-drawer]") as HTMLElement;
    const source = record.querySelector("[data-geo-error-source='baike.baidu.com']") as HTMLElement;
    expect(source.getAttribute("href")).toBe("/app/geo/geo_1/sources?source=baike.baidu.com");
    expect(record.querySelector("[data-geo-error-trace='noRetrieval']")).toHaveTextContent("这条回答没有引用任何来源");
    const groups = [...record.querySelectorAll("[data-geo-cluster-link]")].map((node) => node.getAttribute("data-geo-cluster-link"));
    expect(new Set(groups)).toEqual(new Set([G_BRAND, G_EFFECT]));
  });

  it("shows the correction under way with its article, and the footer can ask for another", async () => {
    renderTab();
    await userEvent.click(within(await findClaim("fp_a")).getByRole("button", { name: /信尔美需要每天固定时间皮下注射一次/ }));
    const record = (await screen.findByRole("dialog")).querySelector("[data-geo-error-drawer]") as HTMLElement;
    const action = await waitFor(() => {
      const node = record.querySelector("[data-geo-error-action]");
      if (!node) throw new Error("no action");
      return node as HTMLElement;
    });
    expect(action.getAttribute("href")).toBe("/app/geo/geo_1/actions?action=correct_error%3Aggr_brand%3Awrong");
    expect(await within(record).findByText("关于每周一次用法的更正")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "再写一篇纠错稿" }));
    await waitFor(() => expect(conversation.open).toHaveBeenCalledTimes(1));
  });

  it("says plainly when a claim has no correction, and starts one with one button", async () => {
    renderTab();
    await userEvent.click(within(await findClaim("fp_b")).getByRole("button", { name: /哺乳期可以正常使用信尔美/ }));
    const record = (await screen.findByRole("dialog")).querySelector("[data-geo-error-drawer]") as HTMLElement;
    expect(within(record).getByText("这条说法还没有纠错稿。")).toBeInTheDocument();
    await userEvent.click(within(record).getByRole("button", { name: "写纠错稿" }));
    await waitFor(() => expect(conversation.open).toHaveBeenCalledTimes(1));
  });

  it("says so when the address names a claim the list no longer holds", async () => {
    renderTab(geoProject(), "/app/geo/geo_1/accuracy?error=gone");
    expect(await screen.findByText("这条说法已经不在清单里了")).toBeInTheDocument();
  });

  it("opens a question group's drawer from a name in it, in place of its own", async () => {
    renderTab(geoProject(), "/app/geo/geo_1/accuracy?error=fp_a");
    const record = (await screen.findByRole("dialog")).querySelector("[data-geo-error-drawer]") as HTMLElement;
    await userEvent.click(within(record).getAllByRole("link", { name: "品牌身份、规格与厂家" })[0]);
    await waitFor(() => expect(screen.getByTestId("search")).toHaveTextContent(`group=${G_BRAND}`));
    expect(screen.getByTestId("search")).not.toHaveTextContent("error=");
  });
});

describe("准确与安全: the charts and the list share one selection", () => {
  it("draws the four charts before the list, none folded", async () => {
    renderTab();
    await findClaim("fp_a");
    const grid = document.querySelector("[data-chart-grid]") as HTMLElement;
    const list = document.querySelector("[data-geo-error-list]") as HTMLElement;
    expect(grid.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector("details")).toBeNull();
    expect(within(grid).getByText(/按回答计，讲错我方/)).toBeInTheDocument();
    expect(within(grid).getByText(/讲错最多，/)).toBeInTheDocument();
    expect(within(grid).getByText(/讲错最多的是/)).toBeInTheDocument();
    expect(within(grid).getByText(/条讲错里，/)).toBeInTheDocument();
    // a grid with no hole: every row's cells add up to its columns
    for (const rowNode of grid.querySelectorAll("[data-chart-row]")) expect(rowNode.children.length).toBeGreaterThan(0);
  });

  it("an engine of the severity chart narrows the list to it, the toolbar says so, and pressing it again lets go", async () => {
    renderTab(geoProject(), "/app/geo/geo_1/accuracy?show=all");
    await findClaim("fp_a");
    const bar = document.querySelector("[data-severity-engine='kimi'] button") as HTMLElement;
    await userEvent.click(bar);
    expect(screen.getByTestId("search")).toHaveTextContent("engine=kimi");
    expect(claimKeys()).toEqual(["fp_b"]);
    expect(bar).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(bar);
    expect(screen.getByTestId("search")).not.toHaveTextContent("engine=");
    expect(claimKeys()).toEqual(["fp_b", "fp_a", "fp_c", "fp_d"]);
  });

  it("a kind of the type chart narrows the list, with a removable mark in the toolbar", async () => {
    renderTab(geoProject(), "/app/geo/geo_1/accuracy?show=all");
    await findClaim("fp_a");
    await userEvent.click(within(document.querySelector("[data-bar-list]") as HTMLElement).getByRole("button", { name: /与说明书冲突/ }));
    expect(claimKeys()).toEqual(["fp_b"]);
    const toolbar = document.querySelector("[data-toolbar]") as HTMLElement;
    await userEvent.click(within(toolbar).getByRole("button", { name: /类型：与说明书冲突/ }));
    expect(claimKeys()).toEqual(["fp_b", "fp_a", "fp_c", "fp_d"]);
  });

  it("a part of the source chart narrows the list to the errors traced that way", async () => {
    renderTab(geoProject(), "/app/geo/geo_1/accuracy?show=all");
    await findClaim("fp_a");
    await userEvent.click(screen.getByRole("button", { name: /这条回答没有引用任何来源/ }));
    expect(claimKeys()).toEqual(["fp_a"]);
    // the claim now lists only the engine that cited nothing
    expect(claimRow("fp_a")).toHaveTextContent("千问");
    expect(claimRow("fp_a")).not.toHaveTextContent("DeepSeek");
  });
});

describe("准确与安全: nothing wrong", () => {
  it("draws no list where nothing was measured wrong, and says so once in the chart that would have shown it", async () => {
    client.getGeoDiagnosis.mockResolvedValue(diagnosisWith([]));
    client.getGeoMonitoring.mockResolvedValue({ ...monitoringFilled, newErrors: [] });
    renderTab();
    expect(await screen.findByText("这一轮没有测到讲错我方的说法。")).toBeInTheDocument();
    expect(document.querySelector("[data-geo-error-list]")).toBeNull();
    expect(screen.queryByRole("heading", { name: "讲错清单，按严重度排序" })).toBeNull();
  });
});
