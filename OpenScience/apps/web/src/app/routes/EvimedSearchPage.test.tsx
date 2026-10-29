import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { EvimedSearchPage } from "./EvimedSearchPage";
import * as api from "@/lib/evimedSearchClient";
import { WEB_SESSION_ENDED_EVENT, WEB_SESSION_STARTED_EVENT, WEB_SESSION_SYNC_STORAGE_KEY, WebApiError } from "@/lib/apiClient";
import { expectComposed } from "@/test/expectComposed";

vi.mock("@/lib/evimedSearchClient", async (load) => ({
  ...await load<typeof import("@/lib/evimedSearchClient")>(),
  searchEvimed: vi.fn(),
  readEvimedSearchDetail: vi.fn(),
  readEvimedSearchFacets: vi.fn(),
  setEvimedSearchCollection: vi.fn(),
  readEvimedSearchCitations: vi.fn(),
  exportEvimedSearchRecords: vi.fn(),
  readEvimedFullTextStatus: vi.fn(),
  readEvimedFullTextOffer: vi.fn(),
  requestEvimedFullText: vi.fn(),
  downloadEvimedFullText: vi.fn(),
}));

const item: api.EvimedSearchItem = {
  id: "paper-one", title: "血压管理研究", subtitle: "Blood pressure management", summary: "研究比较了不同干预方案的结果。",
  source: "Journal of Medicine", publishedAt: "2026", authors: ["张三", "Li"], url: "https://example.org/paper", doi: "10.1234/paper",
  detailRef: "record-one", tags: ["随机对照试验"],
};
const result: api.EvimedSearchResult = { category: "literature", query: "高血压", page: 1, pageSize: 10, total: 21, items: [item] };
const router = { navigate: (() => Promise.resolve()) as unknown as ReturnType<typeof useNavigate> };
function Location() {
  const location = useLocation();
  router.navigate = useNavigate();
  return <span data-testid="location">{location.pathname}{location.search}</span>;
}
function open(path = "/app/search/literature?q=高血压") {
  return render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/app/search/:category?" element={<><Location /><EvimedSearchPage /></>} />
    <Route path="*" element={<Location />} />
  </Routes></MemoryRouter>);
}

function resultTitle(category: api.EvimedSearchCategory, query = "高血压", page = 1) {
  return `${category}: ${query}, page ${page}`;
}

function serveByRequest() {
  vi.mocked(api.searchEvimed).mockImplementation(async (category, request) => ({
    ...result, category, query: request.query, page: request.page, total: 100,
    items: [{ ...item, title: resultTitle(category, request.query, request.page) }],
  }));
}

function facetsFor(category: api.EvimedSearchCategory, filters: api.EvimedSearchFilters = {}): api.EvimedSearchFacets {
  const group = (key: keyof api.EvimedSearchFilters, label: string, options: api.EvimedSearchFacetOption[]) => ({ key, label, options });
  const language = group("language", "语言", [{ value: "zh", label: "中文", count: 18 }, { value: "en", label: "英文", count: 12 }]);
  const timeline = [{ year: 2020, count: 3 }, { year: 2024, count: 9 }, { year: 2026, count: 18 }];
  if (category === "literature") return { timeline, unavailable: [], groups: [language,
    group("articleType", "文献类型", [{ value: "RCT", label: "随机对照研究", count: 12 }, { value: "Review", label: "综述", count: 6 }]),
    group("keyWords", "关键词", [{ value: "血压", label: "血压", count: 8 }]),
    group("p", "研究人群", [{ value: "老年人", label: "老年人", count: 4 }]),
    group("ic", "干预措施", [{ value: "降压治疗", label: "降压治疗", count: 3 }]),
    group("jcrPartition", "JCR 分区", [{ value: "Q1", label: "Q1", count: 2 }]),
    group("journalPartition", "期刊分区", [{ value: "SCI", label: "SCI", count: 10 }]),
  ] };
  if (category === "guidelines") return { timeline, unavailable: [], groups: [language,
    group("secondLevelDepartment", "专科", [{ value: "心内科", label: "心内科", parent: "内科", count: 8 }]),
    group("sType", "指南类型", [{ value: "1", label: "临床指南", count: 9 }]),
    group("keywords", "主题词", [{ value: "血压管理", label: "血压管理", count: 3 }]),
    group("zdzs", "制定机构", [{ value: "中华医学会", label: "中华医学会", count: 2 }]),
  ] };
  if (category === "drugs") return { timeline: [], unavailable: [], groups: [group("source", "药品来源", [
    { value: "NMPA", label: "中国 NMPA" }, { value: "FDA", label: "美国 FDA" }, { value: "EMA", label: "欧洲 EMA" }, { value: "PMDA", label: "日本 PMDA" },
  ])] };
  const source = group("source", "试验来源", [{ value: "0", label: "中国临床试验注册中心" }, { value: "1", label: "ClinicalTrials.gov" }, { value: "2", label: "其他注册平台" }]);
  return { timeline: [], unavailable: [], groups: [source, ...(filters.source === "2"
    ? [group("clinicalSourceDb", "注册平台", [{ value: "WHO", label: "WHO ICTRP", count: 10 }])]
    : [group("testPhase", "试验分期", [{ value: "III", label: "Ⅲ 期", count: 8 }]), ...(filters.source === "1"
      ? [group("recruitmentStatus", "招募状态", [{ value: "RECRUITING", label: "招募中", count: 6 }]), group("associatedArticles", "关联文献", [{ value: "1", label: "有关联文献", count: 4 }])]
      : [group("studyType", "研究类型", [{ value: "RCT", label: "随机对照试验", count: 7 }])])]) ] };
}

function queryParams() {
  return new URL(screen.getByTestId("location").textContent!, "http://localhost").searchParams;
}

function pageScroller() {
  const scroller = document.querySelector("[data-page-header]")?.closest<HTMLElement>(".overflow-y-auto");
  if (!scroller) throw new Error("The page must expose its actual scroll container.");
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, value: 3000 },
    clientHeight: { configurable: true, value: 600 },
  });
  return scroller;
}

async function selectFilter(label: string, option: string) {
  await userEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}(：|$)`) }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: option }));
}

async function switchTab(label: string, category: api.EvimedSearchCategory, query = "高血压", page = 1) {
  await userEvent.click(screen.getByRole("tab", { name: label }));
  return screen.findByRole("link", { name: resultTitle(category, query, page) });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.searchEvimed).mockResolvedValue(result);
  vi.mocked(api.setEvimedSearchCollection).mockImplementation(async (_category, _ref, collected) => ({ collected }));
  vi.mocked(api.readEvimedSearchCitations).mockResolvedValue({ quotes: [{ label: "GB/T 7714", text: "Test citation" }] });
  vi.mocked(api.exportEvimedSearchRecords).mockRejectedValue(new Error("Export disabled in page-state test"));
  vi.mocked(api.readEvimedFullTextStatus).mockResolvedValue({ status: 0, canDownload: false, canRequest: true, url: null });
  vi.mocked(api.readEvimedSearchFacets).mockImplementation(async (category, request) => facetsFor(category, request.filters));
  vi.mocked(api.readEvimedSearchDetail).mockResolvedValue({
    title: item.title, subtitle: item.subtitle, source: item.source, url: item.url, doi: item.doi,
    sections: [{ title: "摘要", text: "<script>untrusted text</script>\n研究方法与结果。" }], metadata: [{ label: "发表年份", value: "2026" }],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("starts with a composed searchable page and does not issue an empty query", async () => {
  const { container } = open("/app/search");
  expect(screen.getByRole("heading", { name: "医学检索", level: 1 })).toBeInTheDocument();
  expect(screen.getByText("输入关键词，开始检索。")).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "医学检索首页" })).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "筛选条件" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "检索结果" })).toBeNull();
  expect(screen.getByRole("button", { name: "检索" })).toBeDisabled();
  expect(api.searchEvimed).not.toHaveBeenCalled();
  expectComposed(container);
  await userEvent.type(screen.getByRole("searchbox", { name: "检索关键词" }), "糖尿病");
  expect(api.searchEvimed).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(api.searchEvimed).toHaveBeenCalledWith("literature", expect.objectContaining({ query: "糖尿病", page: 1 }), expect.any(AbortSignal)));
  expect(screen.queryByRole("region", { name: "医学检索首页" })).toBeNull();
});

it("keeps one unsubmitted homepage query across categories and searches only the selected category", async () => {
  serveByRequest();
  open("/app/search");
  await userEvent.type(screen.getByRole("searchbox", { name: "检索关键词" }), " 高血压 ");
  for (const label of ["查指南", "找药品", "搜文献", "临床试验"]) {
    await userEvent.click(screen.getByRole("tab", { name: label }));
    expect(screen.getByRole("tab", { name: label })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("searchbox", { name: "检索关键词" })).toHaveValue(" 高血压 ");
    expect(screen.getByRole("tabpanel", { name: label })).toContainElement(screen.getByRole("searchbox", { name: "检索关键词" }));
  }
  expect(api.searchEvimed).not.toHaveBeenCalled();
  expect(api.readEvimedSearchFacets).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "检索" }));
  await screen.findByRole("link", { name: resultTitle("trials") });
  expect(api.searchEvimed).toHaveBeenCalledTimes(1);
  expect(api.searchEvimed).toHaveBeenCalledWith("trials", expect.objectContaining({ query: "高血压", page: 1 }), expect.any(AbortSignal));
});

it.each([
  ["literature", "高血压", "输入疾病、干预措施或研究主题"],
  ["guidelines", "高血压诊疗", "输入疾病、专科或指南主题"],
  ["drugs", "阿司匹林", "输入药品通用名或商品名"],
  ["trials", "肺癌", "输入疾病、干预措施或试验名称"],
] as const)("prefills a %s example without a request until it is submitted", async (category, example, placeholder) => {
  serveByRequest();
  open(`/app/search/${category}`);
  const input = screen.getByRole("searchbox", { name: "检索关键词" });
  expect(input).toHaveAttribute("placeholder", placeholder);
  await userEvent.click(screen.getByRole("button", { name: example }));
  expect(input).toHaveValue(example);
  expect(input).toHaveFocus();
  expect(api.searchEvimed).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("link", { name: resultTitle(category, example) });
  expect(api.searchEvimed).toHaveBeenCalledTimes(1);
});

it("returns to a clean homepage and honors the result URL when navigating back", async () => {
  serveByRequest();
  open("/app/search/literature?q=高血压&page=2&language=en");
  await screen.findByRole("link", { name: resultTitle("literature", "高血压", 2) });
  await userEvent.click(screen.getByRole("link", { name: "检索首页" }));
  expect(screen.getByRole("region", { name: "医学检索首页" })).toBeInTheDocument();
  expect(screen.getByRole("searchbox", { name: "检索关键词" })).toHaveValue("");
  expect(queryParams().size).toBe(0);
  expect(api.searchEvimed).toHaveBeenCalledTimes(1);
  await act(async () => { await router.navigate(-1); });
  await screen.findByRole("link", { name: resultTitle("literature", "高血压", 2) });
  expect(api.searchEvimed).toHaveBeenLastCalledWith("literature", expect.objectContaining({ page: 2, query: "高血压", filters: { language: "en", sort: "comprehensive" } }), expect.any(AbortSignal));
});

it("does not submit partially composed Chinese text", async () => {
  open("/app/search");
  const input = screen.getByRole("searchbox", { name: "检索关键词" });
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: "gaoxueya" } });
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
  expect(api.searchEvimed).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);
  fireEvent.change(input, { target: { value: "高血压" } });
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
  await waitFor(() => expect(api.searchEvimed).toHaveBeenCalledWith("literature", expect.objectContaining({ query: "高血压" }), expect.any(AbortSignal)));
});

it("allows a multiline homepage query without submitting on Shift+Enter", async () => {
  open("/app/search");
  const input = screen.getByRole("searchbox", { name: "检索关键词" });
  expect(input.tagName).toBe("TEXTAREA");
  await userEvent.type(input, "高血压{Shift>}{Enter}{/Shift}治疗");
  expect(input).toHaveValue("高血压\n治疗");
  expect(api.searchEvimed).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("tab", { name: "查指南" }));
  expect(screen.getByRole("searchbox", { name: "检索关键词" })).toHaveValue("高血压\n治疗");
  await userEvent.click(screen.getByRole("button", { name: "检索" }));
  await waitFor(() => expect(api.searchEvimed).toHaveBeenCalledTimes(1));
  expect(api.searchEvimed).toHaveBeenCalledWith("guidelines", expect.objectContaining({ query: "高血压\n治疗" }), expect.any(AbortSignal));
});

it("honors explicit relevance sorting while leaving unqualified searches comprehensive", async () => {
  open("/app/search/literature?q=高血压&sort=relevance");
  await screen.findByRole("link", { name: item.title });
  expect(api.searchEvimed).toHaveBeenCalledWith("literature", expect.objectContaining({ filters: { language: "", sort: "relevance" } }), expect.any(AbortSignal));
  expect(screen.getByRole("button", { name: "排序：相关性" })).toHaveTextContent("相关性");
  await userEvent.click(screen.getByRole("button", { name: "排序：相关性" }));
  expect(screen.getByRole("menuitemradio", { name: "相关性" })).toHaveAttribute("aria-checked", "true");
  await userEvent.click(screen.getByRole("menuitemradio", { name: "综合" }));
  await waitFor(() => expect(api.searchEvimed).toHaveBeenLastCalledWith("literature", expect.objectContaining({ filters: { language: "", sort: "comprehensive" } }), expect.any(AbortSignal)));
  expect(screen.getByRole("button", { name: "排序" })).toHaveTextContent("综合排序");
  expect(queryParams().get("sort")).toBeNull();
});

it("shows source context and paginates the same search without dropping its filters", async () => {
  open("/app/search/literature?q=高血压&language=en&years=5&sort=newest");
  const link = await screen.findByRole("link", { name: item.title });
  const row = within(link.closest("li")!);
  expect(row.getByText("Journal of Medicine")).toBeInTheDocument();
  expect(row.getByText("2026")).toBeInTheDocument();
  expect(row.getByText("张三、Li")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  await waitFor(() => expect(api.searchEvimed).toHaveBeenLastCalledWith("literature", {
    query: "高血压", page: 2, pageSize: 10, filters: { language: "en", sort: "newest", startYear: new Date().getFullYear() - 4, endYear: new Date().getFullYear() },
  }, expect.any(AbortSignal)));
  expect(queryParams().get("language")).toBe("en");
  expect(queryParams().get("years")).toBeNull();
  expect(queryParams().get("startYear")).toBe(String(new Date().getFullYear() - 4));
  expect(queryParams().get("endYear")).toBe(String(new Date().getFullYear()));
  expect(queryParams().get("sort")).toBe("newest");
  expect(queryParams().get("page")).toBe("2");
});

it("switches categories by keyboard, keeping the query and resetting incompatible filters", async () => {
  open("/app/search/literature?q=高血压&page=3&language=en");
  await screen.findByRole("link", { name: item.title });
  screen.getByRole("tab", { name: "搜文献" }).focus();
  await userEvent.keyboard("{ArrowRight}");
  await waitFor(() => expect(api.searchEvimed).toHaveBeenLastCalledWith("guidelines", expect.objectContaining({ query: "高血压", page: 1, filters: { language: "", sort: "comprehensive" } }), expect.any(AbortSignal)));
  expect(screen.getByRole("tab", { name: "查指南" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByTestId("location")).not.toHaveTextContent("page=3");
  expect(screen.getByTestId("location")).not.toHaveTextContent("language=en");
});

it("opens an addressed reader as plain text and restores the result list without repeating its search", async () => {
  const { container } = open("/app/search/literature?q=高血压&page=2");
  await userEvent.click(await screen.findByRole("link", { name: item.title }));
  await screen.findByRole("heading", { level: 1, name: item.title });
  expect(api.readEvimedSearchDetail).toHaveBeenCalledWith("literature", "record-one", expect.any(AbortSignal));
  expect(screen.getByText(/<script>untrusted text<\/script>/)).toBeInTheDocument();
  expect(container.querySelector("script")).toBeNull();
  expect(screen.getByRole("link", { name: "打开原文" })).toHaveAttribute("href", item.url);
  await userEvent.click(screen.getByRole("link", { name: "返回检索结果" }));
  await screen.findByRole("link", { name: item.title });
  expect(api.searchEvimed).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("location")).toHaveTextContent("page=2");
});

it("shows a journal once when source, subtitle and detail metadata repeat the same value", async () => {
  const journal = "中国糖尿病杂志";
  vi.mocked(api.searchEvimed).mockResolvedValue({ ...result, items: [{ ...item, source: journal, subtitle: ` ${journal} ` }] });
  vi.mocked(api.readEvimedSearchDetail).mockResolvedValue({
    title: item.title, source: journal, subtitle: ` ${journal} `, doi: item.doi, url: item.url,
    metadata: [{ label: "期刊", value: journal }, { label: "DOI", value: item.doi! }, { label: "发表年份", value: "2026" }, { label: "作者", value: " " }],
    sections: [{ title: "摘要", text: item.summary }],
  });
  open();
  const link = await screen.findByRole("link", { name: item.title });
  expect(within(link.closest("li")!).getAllByText(new RegExp(journal))).toHaveLength(1);
  await userEvent.click(link);
  await screen.findByRole("heading", { level: 1, name: item.title });
  expect(screen.getAllByText(journal)).toHaveLength(1);
  expect(screen.getAllByText(item.doi!)).toHaveLength(1);
  expect(screen.getByText("2026")).toBeInTheDocument();
  expect(screen.queryByText("名称")).toBeNull();
  expect(screen.queryByText("期刊")).toBeNull();
  expect(screen.queryByText("作者")).toBeNull();
  expect(screen.getByText(item.summary)).toBeInTheDocument();
});

it("uses a real trial source link without inventing a detail action", async () => {
  vi.mocked(api.searchEvimed).mockResolvedValue({ ...result, category: "trials", items: [{ ...item, detailRef: null, url: "https://clinicaltrials.gov/study/NCT01234567" }] });
  open("/app/search/trials?q=高血压&source=1");
  const link = await screen.findByRole("link", { name: item.title });
  expect(link).toHaveAttribute("href", "https://clinicaltrials.gov/study/NCT01234567");
  expect(link).toHaveAttribute("target", "_blank");
  expect(api.searchEvimed).toHaveBeenCalledWith("trials", expect.objectContaining({ filters: { source: "1" } }), expect.any(AbortSignal));
  expect(api.readEvimedSearchDetail).not.toHaveBeenCalled();
});

it("does not expose an unsafe source URL as a clickable result", async () => {
  vi.mocked(api.searchEvimed).mockResolvedValue({ ...result, category: "trials", items: [{ ...item, detailRef: null, url: "javascript:alert(1)" }] });
  open("/app/search/trials?q=高血压");
  await screen.findByText(item.title);
  expect(screen.queryByRole("link", { name: item.title })).toBeNull();
  expect(screen.queryByRole("button", { name: item.title })).toBeNull();
});

it("shows loading then empty results separately from upstream failures", async () => {
  let resolve!: (value: api.EvimedSearchResult) => void;
  vi.mocked(api.searchEvimed).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  open();
  expect(screen.getByRole("status", { name: "正在检索" })).toBeInTheDocument();
  await act(async () => resolve({ ...result, total: 0, items: [] }));
  expect(screen.getByText(/没有找到符合条件的结果/)).toBeInTheDocument();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("retries a failed request while preserving its query", async () => {
  vi.mocked(api.searchEvimed).mockRejectedValueOnce(new Error("upstream private details"));
  open();
  expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法读取检索结果，请重试。");
  expect(screen.queryByText("upstream private details")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByRole("link", { name: item.title })).toBeInTheDocument();
});

it("offers explicit EviMed reauthentication without silently leaving the search page", async () => {
  vi.mocked(api.searchEvimed).mockRejectedValueOnce(new WebApiError("expired", { status: 403, code: "evimed_search_credential_expired" }));
  open("/app/search/drugs?q=阿司匹林&source=NMPA");
  const link = await screen.findByRole("link", { name: "重新登录" });
  const url = new URL(link.getAttribute("href")!, "http://localhost");
  expect(url.searchParams.get("reauth")).toBe("evimed");
  const next = new URL(url.searchParams.get("next")!, "http://localhost");
  expect(next.pathname).toBe("/app/search/drugs");
  expect(next.searchParams.get("q")).toBe("阿司匹林");
  expect(next.searchParams.get("source")).toBe("NMPA");
  expect(screen.getByTestId("location")).toHaveTextContent("/app/search/drugs");
});

it("ignores a late response from the previous category", async () => {
  let finishOld!: (value: api.EvimedSearchResult) => void;
  vi.mocked(api.searchEvimed).mockImplementationOnce(() => new Promise((done) => { finishOld = done; }));
  open();
  await userEvent.click(screen.getByRole("tab", { name: "找药品" }));
  await screen.findByRole("link", { name: item.title });
  await act(async () => finishOld({ ...result, items: [{ ...item, title: "Stale result" }] }));
  expect(screen.queryByText("Stale result")).toBeNull();
  expect(screen.getByRole("tab", { name: "找药品" })).toHaveAttribute("aria-selected", "true");
});

it("keeps the current URL when the browser navigates between prior queries", async () => {
  open();
  await screen.findByRole("link", { name: item.title });
  await act(async () => { await router.navigate("/app/search/guidelines?q=哮喘&years=10"); });
  await waitFor(() => expect(api.searchEvimed).toHaveBeenLastCalledWith("guidelines", expect.objectContaining({ query: "哮喘" }), expect.any(AbortSignal)));
  expect(screen.getByRole("searchbox", { name: "检索关键词" })).toHaveValue("哮喘");
});

it("actually searches again when an expired detail reference needs replacement", async () => {
  vi.mocked(api.readEvimedSearchDetail).mockRejectedValueOnce(new WebApiError("expired", { status: 400, code: "evimed_search_reference_invalid" }));
  open("/app/search/literature?q=高血压&page=2&language=en&years=5&sort=newest");
  await userEvent.click(await screen.findByRole("link", { name: item.title }));
  await screen.findByRole("alert");
  vi.mocked(api.searchEvimed).mockResolvedValueOnce({ ...result, items: [{ ...item, detailRef: "fresh-record" }] });
  await userEvent.click(screen.getByRole("button", { name: "重新检索" }));
  const refreshed = await screen.findByRole("link", { name: item.title });
  expect(refreshed).toHaveAttribute("href", expect.stringContaining("detail=fresh-record"));
  expect(api.searchEvimed).toHaveBeenCalledTimes(2);
  expect(api.searchEvimed).toHaveBeenLastCalledWith("literature", expect.objectContaining({ page: 2, filters: {
    language: "en", sort: "newest", startYear: new Date().getFullYear() - 4, endYear: new Date().getFullYear(),
  } }), expect.any(AbortSignal));
});

it("can recover from a bookmarked page beyond the remaining results", async () => {
  vi.mocked(api.searchEvimed).mockResolvedValueOnce({ ...result, page: 9, total: 1, items: [] });
  open("/app/search/literature?q=高血压&page=9&language=zh");
  await userEvent.click(await screen.findByRole("button", { name: "返回第一页" }));
  await screen.findByRole("link", { name: item.title });
  expect(api.searchEvimed).toHaveBeenLastCalledWith("literature", expect.objectContaining({ page: 1, filters: { language: "zh", sort: "comprehensive" } }), expect.any(AbortSignal));
});

it("collapses the entire filter column without clearing an unfinished refinement or reloading results", async () => {
  open("/app/search/literature?q=高血压&language=en");
  await screen.findByRole("link", { name: item.title });
  await userEvent.type(screen.getByRole("textbox", { name: "结果中搜索" }), "未提交的词语");
  const requests = vi.mocked(api.searchEvimed).mock.calls.length;
  const collapse = screen.getByRole("button", { name: "收起筛选栏" });
  const panel = document.getElementById(collapse.getAttribute("aria-controls")!)!;
  await userEvent.click(collapse);
  expect(panel).not.toBeVisible();
  expect(screen.getByRole("button", { name: "展开筛选栏" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("link", { name: item.title })).toBeVisible();
  expect(queryParams().get("language")).toBe("en");
  expect(api.searchEvimed).toHaveBeenCalledTimes(requests);
  await userEvent.click(screen.getByRole("button", { name: "展开筛选栏" }));
  expect(panel).toBeVisible();
  expect(screen.getByRole("textbox", { name: "结果中搜索" })).toHaveValue("未提交的词语");
  expect(screen.getByRole("button", { name: "语言：英文" })).toBeVisible();
  expect(api.searchEvimed).toHaveBeenCalledTimes(requests);
});

it("retains the horizontal collapse choice across tabs and reader return", async () => {
  open();
  await screen.findByRole("link", { name: item.title });
  await userEvent.click(screen.getByRole("button", { name: "收起筛选栏" }));
  await userEvent.click(screen.getByRole("tab", { name: "查指南" }));
  await waitFor(() => expect(api.searchEvimed).toHaveBeenLastCalledWith("guidelines", expect.anything(), expect.any(AbortSignal)));
  expect(screen.getByRole("button", { name: "展开筛选栏" })).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(await screen.findByRole("link", { name: item.title }));
  await screen.findByRole("heading", { name: item.title });
  await userEvent.click(screen.getByRole("link", { name: "返回检索结果" }));
  await screen.findByRole("link", { name: item.title });
  expect(screen.getByRole("button", { name: "展开筛选栏" })).toHaveAttribute("aria-expanded", "false");
});

it("keeps filters and submission reachable in the compact collapsible sidebar", async () => {
  const originalMatchMedia = window.matchMedia.bind(window);
  const media = vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    ...originalMatchMedia(query), matches: query === "(max-width: 1023px)",
  }));
  try {
    open();
    await screen.findByRole("link", { name: item.title });
    const disclosure = screen.getByText("筛选条件").closest("details")!;
    expect(disclosure).not.toHaveAttribute("open");
    await userEvent.click(screen.getByText("筛选条件"));
    expect(disclosure).toHaveAttribute("open");
    await selectFilter("语言", "英文");
    await waitFor(() => expect(api.searchEvimed).toHaveBeenLastCalledWith("literature", expect.objectContaining({ filters: { language: "en", sort: "comprehensive" } }), expect.any(AbortSignal)));
    await userEvent.click(screen.getByText("筛选条件"));
    expect(disclosure).not.toHaveAttribute("open");
    expect(screen.getByRole("searchbox", { name: "检索关键词" })).toBeVisible();
    expect(screen.getByRole("button", { name: "检索" })).toBeVisible();
  } finally {
    media.mockRestore();
  }
});

it("restores each visited category's page, filters, unsubmitted draft and scroll without another request", async () => {
  serveByRequest();
  open("/app/search/literature?q=高血压&page=3&language=en&years=5&sort=newest");
  await screen.findByRole("link", { name: resultTitle("literature", "高血压", 3) });
  fireEvent.change(screen.getByRole("searchbox", { name: "检索关键词" }), { target: { value: "未提交的文献关键词" } });
  fireEvent.scroll(pageScroller(), { target: { scrollTop: 680 } });
  await switchTab("查指南", "guidelines");
  expect(screen.getByRole("searchbox", { name: "检索关键词" })).toHaveValue("高血压");
  expect(pageScroller().scrollTop).toBe(0);
  await selectFilter("语言", "中文");
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByRole("link", { name: resultTitle("guidelines", "高血压", 2) });
  fireEvent.change(screen.getByRole("searchbox", { name: "检索关键词" }), { target: { value: "未提交的指南关键词" } });
  fireEvent.scroll(pageScroller(), { target: { scrollTop: 210 } });
  const requests = vi.mocked(api.searchEvimed).mock.calls.length;
  await switchTab("搜文献", "literature", "高血压", 3);
  expect(queryParams().get("page")).toBe("3");
  expect(queryParams().get("language")).toBe("en");
  expect(queryParams().get("years")).toBeNull();
  expect(queryParams().get("startYear")).toBe(String(new Date().getFullYear() - 4));
  expect(queryParams().get("endYear")).toBe(String(new Date().getFullYear()));
  expect(queryParams().get("sort")).toBe("newest");
  expect(screen.getByRole("searchbox", { name: "检索关键词" })).toHaveValue("未提交的文献关键词");
  await waitFor(() => expect(pageScroller().scrollTop).toBe(680));
  await switchTab("查指南", "guidelines", "高血压", 2);
  expect(queryParams().get("language")).toBe("zh");
  expect(screen.getByRole("searchbox", { name: "检索关键词" })).toHaveValue("未提交的指南关键词");
  await waitFor(() => expect(pageScroller().scrollTop).toBe(210));
  expect(api.searchEvimed).toHaveBeenCalledTimes(requests);
});

it("starts a new keyword round with default filters and invalidates every previous category", async () => {
  serveByRequest();
  open("/app/search/literature?q=高血压&page=3&language=en&years=5&sort=newest");
  await screen.findByRole("link", { name: resultTitle("literature", "高血压", 3) });
  fireEvent.change(screen.getByRole("searchbox", { name: "检索关键词" }), { target: { value: "旧文献草稿" } });
  await switchTab("找药品", "drugs");
  await selectFilter("药品来源", "美国 FDA");
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByRole("link", { name: resultTitle("drugs", "高血压", 2) });
  fireEvent.change(screen.getByRole("searchbox", { name: "检索关键词" }), { target: { value: "阿司匹林" } });
  await userEvent.click(screen.getByRole("button", { name: "检索" }));
  await screen.findByRole("link", { name: resultTitle("drugs", "阿司匹林") });
  expect(api.searchEvimed).toHaveBeenLastCalledWith("drugs", expect.objectContaining({ query: "阿司匹林", page: 1, filters: { source: "" } }), expect.any(AbortSignal));
  expect(queryParams().get("source")).toBeNull();
  await switchTab("搜文献", "literature", "阿司匹林");
  expect(api.searchEvimed).toHaveBeenLastCalledWith("literature", expect.objectContaining({ query: "阿司匹林", page: 1, filters: { language: "", sort: "comprehensive" } }), expect.any(AbortSignal));
  expect(queryParams().get("language")).toBeNull();
  expect(queryParams().get("years")).toBeNull();
  expect(queryParams().get("sort")).toBeNull();
  expect(screen.getByRole("searchbox", { name: "检索关键词" })).toHaveValue("阿司匹林");
});

it("explicitly resubmits the same keyword on page one, refreshing only that category's cached pages", async () => {
  serveByRequest();
  open("/app/search/literature?q=高血压&page=2&language=en");
  await screen.findByRole("link", { name: resultTitle("literature", "高血压", 2) });
  await switchTab("查指南", "guidelines");
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByRole("link", { name: resultTitle("guidelines", "高血压", 2) });
  await switchTab("搜文献", "literature", "高血压", 2);
  fireEvent.change(screen.getByRole("searchbox", { name: "检索关键词" }), { target: { value: " 高血压 " } });
  await userEvent.click(screen.getByRole("button", { name: "检索" }));
  await screen.findByRole("link", { name: resultTitle("literature") });
  expect(api.searchEvimed).toHaveBeenLastCalledWith("literature", expect.objectContaining({ query: "高血压", page: 1, filters: { language: "en", sort: "comprehensive" } }), expect.any(AbortSignal));
  const requests = vi.mocked(api.searchEvimed).mock.calls.length;
  await switchTab("查指南", "guidelines", "高血压", 2);
  expect(api.searchEvimed).toHaveBeenCalledTimes(requests);
  await switchTab("搜文献", "literature");
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByRole("link", { name: resultTitle("literature", "高血压", 2) });
  expect(vi.mocked(api.searchEvimed).mock.calls.filter(([category, request]) => category === "literature" && request.page === 2)).toHaveLength(2);
  const beforeRefresh = vi.mocked(api.searchEvimed).mock.calls.length;
  await userEvent.click(screen.getByRole("button", { name: "检索" }));
  await screen.findByRole("link", { name: resultTitle("literature") });
  expect(api.searchEvimed).toHaveBeenCalledTimes(beforeRefresh + 1);
});

it.each(["button", "escape"])("clears the entire search round with %s and cannot restore old tab results", async (clearMethod) => {
  serveByRequest();
  open("/app/search/literature?q=高血压&page=2&language=en");
  await screen.findByRole("link", { name: resultTitle("literature", "高血压", 2) });
  await switchTab("找药品", "drugs");
  const requests = vi.mocked(api.searchEvimed).mock.calls.length;
  if (clearMethod === "button") await userEvent.click(screen.getByRole("button", { name: "清除搜索" }));
  else {
    await userEvent.click(screen.getByRole("searchbox", { name: "检索关键词" }));
    await userEvent.keyboard("{Escape}");
  }
  expect(screen.getByText("输入关键词，开始检索。")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab", { name: "搜文献" }));
  expect(screen.getByRole("searchbox", { name: "检索关键词" })).toHaveValue("");
  expect(queryParams().get("q")).toBeNull();
  expect(queryParams().get("language")).toBeNull();
  expect(api.searchEvimed).toHaveBeenCalledTimes(requests);
  await userEvent.type(screen.getByRole("searchbox", { name: "检索关键词" }), "高血压{Enter}");
  await screen.findByRole("link", { name: resultTitle("literature") });
  expect(api.searchEvimed).toHaveBeenCalledTimes(requests + 1);
  expect(api.searchEvimed).toHaveBeenLastCalledWith("literature", expect.objectContaining({ page: 1, filters: { language: "", sort: "comprehensive" } }), expect.any(AbortSignal));
});

it("changes only the active category's filters and resets only its current page", async () => {
  serveByRequest();
  open("/app/search/literature?q=高血压&page=3&language=en");
  await screen.findByRole("link", { name: resultTitle("literature", "高血压", 3) });
  await switchTab("查指南", "guidelines");
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByRole("link", { name: resultTitle("guidelines", "高血压", 2) });
  await switchTab("搜文献", "literature", "高血压", 3);
  await selectFilter("语言", "中文");
  await screen.findByRole("link", { name: resultTitle("literature") });
  expect(api.searchEvimed).toHaveBeenLastCalledWith("literature", expect.objectContaining({ page: 1, filters: { language: "zh", sort: "comprehensive" } }), expect.any(AbortSignal));
  const requests = vi.mocked(api.searchEvimed).mock.calls.length;
  await switchTab("查指南", "guidelines", "高血压", 2);
  expect(queryParams().get("language")).toBeNull();
  expect(api.searchEvimed).toHaveBeenCalledTimes(requests);
});

it("treats selecting the already active category as a no-op, including keyboard Home", async () => {
  serveByRequest();
  open("/app/search/literature?q=高血压&page=3&language=en");
  await screen.findByRole("link", { name: resultTitle("literature", "高血压", 3) });
  fireEvent.change(screen.getByRole("searchbox", { name: "检索关键词" }), { target: { value: "草稿关键词" } });
  fireEvent.scroll(pageScroller(), { target: { scrollTop: 440 } });
  await userEvent.click(screen.getByRole("tab", { name: "搜文献" }));
  await userEvent.keyboard("{Home}");
  expect(queryParams().get("page")).toBe("3");
  expect(queryParams().get("language")).toBe("en");
  expect(screen.getByRole("searchbox", { name: "检索关键词" })).toHaveValue("草稿关键词");
  expect(pageScroller().scrollTop).toBe(440);
  expect(api.searchEvimed).toHaveBeenCalledTimes(1);
});

it("aborts a superseded search and ignores its late success after a new keyword submission", async () => {
  let finishOld!: (value: api.EvimedSearchResult) => void;
  serveByRequest();
  vi.mocked(api.searchEvimed).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
  open();
  const oldSignal = vi.mocked(api.searchEvimed).mock.calls[0][2];
  fireEvent.change(screen.getByRole("searchbox", { name: "检索关键词" }), { target: { value: "哮喘" } });
  fireEvent.keyDown(screen.getByRole("searchbox", { name: "检索关键词" }), { key: "Enter", code: "Enter" });
  await screen.findByRole("link", { name: resultTitle("literature", "哮喘") });
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => finishOld({ ...result, items: [{ ...item, title: "Late old query result" }] }));
  expect(screen.queryByText("Late old query result")).toBeNull();
  expect(queryParams().get("q")).toBe("哮喘");
});

it("aborts a category request and ignores its late failure after another tab has succeeded", async () => {
  let failOld!: (reason: unknown) => void;
  serveByRequest();
  vi.mocked(api.searchEvimed).mockImplementationOnce(() => new Promise((_, reject) => { failOld = reject; }));
  open();
  const oldSignal = vi.mocked(api.searchEvimed).mock.calls[0][2];
  await switchTab("找药品", "drugs");
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => failOld(new Error("Late stale failure")));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("link", { name: resultTitle("drugs") })).toBeInTheDocument();
});

it("reuses successful empty results but does not cache a failed tab", async () => {
  serveByRequest();
  vi.mocked(api.searchEvimed).mockResolvedValueOnce({ ...result, total: 0, items: [] });
  open();
  await screen.findByText(/没有找到符合条件的结果/);
  vi.mocked(api.searchEvimed).mockRejectedValueOnce(new Error("upstream temporarily unavailable"));
  await userEvent.click(screen.getByRole("tab", { name: "查指南" }));
  await screen.findByRole("alert");
  await userEvent.click(screen.getByRole("tab", { name: "搜文献" }));
  await screen.findByText(/没有找到符合条件的结果/);
  expect(api.searchEvimed).toHaveBeenCalledTimes(2);
  await switchTab("查指南", "guidelines");
  expect(api.searchEvimed).toHaveBeenCalledTimes(3);
});

it("expires a successful result after five minutes and refreshes when its tab is reopened", async () => {
  serveByRequest();
  const startedAt = Date.now();
  vi.setSystemTime(startedAt);
  open();
  await screen.findByRole("link", { name: resultTitle("literature") });
  await switchTab("查指南", "guidelines");
  vi.setSystemTime(startedAt + 299_000);
  await switchTab("搜文献", "literature");
  expect(api.searchEvimed).toHaveBeenCalledTimes(2);
  await switchTab("查指南", "guidelines");
  vi.setSystemTime(startedAt + 301_000);
  await switchTab("搜文献", "literature");
  expect(api.searchEvimed).toHaveBeenCalledTimes(3);
});

it("keeps at most twenty-four successful query pages and evicts the least recently visited one", async () => {
  serveByRequest();
  open();
  await screen.findByRole("link", { name: resultTitle("literature") });
  for (let page = 2; page <= 24; page += 1) {
    await act(async () => { await router.navigate(`/app/search/literature?q=高血压&page=${page}`); });
    await screen.findByRole("link", { name: resultTitle("literature", "高血压", page) });
  }
  expect(api.searchEvimed).toHaveBeenCalledTimes(24);
  await act(async () => { await router.navigate("/app/search/literature?q=高血压"); });
  await screen.findByRole("link", { name: resultTitle("literature") });
  expect(api.searchEvimed).toHaveBeenCalledTimes(24);
  await act(async () => { await router.navigate("/app/search/literature?q=高血压&page=25"); });
  await screen.findByRole("link", { name: resultTitle("literature", "高血压", 25) });
  await act(async () => { await router.navigate("/app/search/literature?q=高血压"); });
  await screen.findByRole("link", { name: resultTitle("literature") });
  expect(api.searchEvimed).toHaveBeenCalledTimes(25);
  await act(async () => { await router.navigate("/app/search/literature?q=高血压&page=2"); });
  await screen.findByRole("link", { name: resultTitle("literature", "高血压", 2) });
  expect(api.searchEvimed).toHaveBeenCalledTimes(26);
});

it("restores list scroll and draft after closing a detail reader", async () => {
  serveByRequest();
  open("/app/search/literature?q=高血压&page=2&language=en");
  const record = await screen.findByRole("link", { name: resultTitle("literature", "高血压", 2) });
  fireEvent.change(screen.getByRole("searchbox", { name: "检索关键词" }), { target: { value: "未提交的文献草稿" } });
  fireEvent.scroll(pageScroller(), { target: { scrollTop: 720 } });
  await userEvent.click(record);
  await screen.findByRole("heading", { level: 1, name: item.title });
  fireEvent.scroll(pageScroller(), { target: { scrollTop: 110 } });
  await userEvent.click(screen.getByRole("link", { name: "返回检索结果" }));
  await screen.findByRole("link", { name: resultTitle("literature", "高血压", 2) });
  expect(api.searchEvimed).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("searchbox", { name: "检索关键词" })).toHaveValue("未提交的文献草稿");
  await waitFor(() => expect(pageScroller().scrollTop).toBe(720));
});

it("honors browser history URL parameters even when a category has a newer remembered state", async () => {
  serveByRequest();
  open("/app/search/literature?q=高血压&page=2&language=en");
  await screen.findByRole("link", { name: resultTitle("literature", "高血压", 2) });
  await selectFilter("语言", "中文");
  await screen.findByRole("link", { name: resultTitle("literature") });
  await act(async () => { await router.navigate(-1); });
  await screen.findByRole("link", { name: resultTitle("literature", "高血压", 2) });
  expect(queryParams().get("language")).toBe("en");
  expect(screen.getByRole("button", { name: "语言：英文" })).toBeInTheDocument();
  await act(async () => { await router.navigate(1); });
  await screen.findByRole("link", { name: resultTitle("literature") });
  expect(queryParams().get("language")).toBe("zh");
  expect(api.searchEvimed).toHaveBeenCalledTimes(2);
});

it("drops prior results across an account session change and cannot adopt its late response", async () => {
  let finishOld!: (value: api.EvimedSearchResult) => void;
  serveByRequest();
  vi.mocked(api.searchEvimed).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
  open();
  const oldSignal = vi.mocked(api.searchEvimed).mock.calls[0][2];
  await act(async () => { window.dispatchEvent(new Event(WEB_SESSION_STARTED_EVENT)); });
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => finishOld({ ...result, items: [{ ...item, title: "Previous account result" }] }));
  expect(screen.queryByText("Previous account result")).toBeNull();
});

it("aborts a closed detail reader and never caches its late response", async () => {
  let finishDetail!: (value: api.EvimedSearchDetail) => void;
  serveByRequest();
  vi.mocked(api.readEvimedSearchDetail).mockImplementationOnce(() => new Promise((resolve) => { finishDetail = resolve; }));
  open();
  await userEvent.click(await screen.findByRole("link", { name: resultTitle("literature") }));
  await screen.findByRole("status", { name: "正在检索" });
  const detailSignal = vi.mocked(api.readEvimedSearchDetail).mock.calls[0][2];
  await userEvent.click(screen.getByRole("link", { name: "返回检索结果" }));
  await screen.findByRole("link", { name: resultTitle("literature") });
  expect(detailSignal?.aborted).toBe(true);
  await act(async () => finishDetail({
    title: "Late closed reader result", subtitle: "", source: "", url: null, doi: null, sections: [], metadata: [],
  }));
  expect(screen.queryByRole("heading", { name: "Late closed reader result" })).toBeNull();
  await userEvent.click(screen.getByRole("link", { name: resultTitle("literature") }));
  await screen.findByRole("heading", { level: 1, name: item.title });
  expect(api.readEvimedSearchDetail).toHaveBeenCalledTimes(2);
  expect(api.searchEvimed).toHaveBeenCalledTimes(1);
});

it("clears private tab state on a cross-tab session signal while ignoring unrelated storage changes", async () => {
  serveByRequest();
  open("/app/search/literature?q=高血压&page=2&language=en");
  await screen.findByRole("link", { name: resultTitle("literature", "高血压", 2) });
  await switchTab("查指南", "guidelines");
  fireEvent.change(screen.getByRole("searchbox", { name: "检索关键词" }), { target: { value: "Private draft" } });
  await act(async () => { window.dispatchEvent(new StorageEvent("storage", { key: "unrelated-preference", newValue: "changed" })); });
  expect(screen.getByRole("link", { name: resultTitle("guidelines") })).toBeInTheDocument();
  expect(screen.getByRole("searchbox", { name: "检索关键词" })).toHaveValue("Private draft");
  await act(async () => {
    window.dispatchEvent(new StorageEvent("storage", {
      key: WEB_SESSION_SYNC_STORAGE_KEY,
      newValue: JSON.stringify({ at: Date.now(), nonce: "test-session-change", kind: "ended" }),
    }));
  });
  expect(screen.getByText("输入关键词，开始检索。")).toBeInTheDocument();
  expect(screen.getByRole("searchbox", { name: "检索关键词" })).toHaveValue("");
  expect(queryParams().get("q")).toBeNull();
  await userEvent.click(screen.getByRole("tab", { name: "搜文献" }));
  expect(queryParams().get("page")).toBeNull();
  expect(queryParams().get("language")).toBeNull();
  expect(api.searchEvimed).toHaveBeenCalledTimes(2);
});

it("discards mounted-page caches and cancels its pending request when the page is unmounted", async () => {
  let finishOld!: (value: api.EvimedSearchResult) => void;
  serveByRequest();
  const firstPage = open();
  await screen.findByRole("link", { name: resultTitle("literature") });
  vi.mocked(api.searchEvimed).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  const oldSignal = vi.mocked(api.searchEvimed).mock.calls[1][2];
  firstPage.unmount();
  expect(oldSignal?.aborted).toBe(true);
  open();
  await screen.findByRole("link", { name: resultTitle("literature") });
  expect(api.searchEvimed).toHaveBeenCalledTimes(3);
  await act(async () => finishOld({ ...result, page: 2, items: [{ ...item, title: "Unmounted page result" }] }));
  expect(screen.queryByText("Unmounted page result")).toBeNull();
  expect(screen.getByRole("link", { name: resultTitle("literature") })).toBeInTheDocument();
});

it("cannot restore a previous account's resource state by navigating back to its old list URL", async () => {
  let finishNew!: (value: api.EvimedSearchResult) => void;
  serveByRequest();
  vi.mocked(api.searchEvimed).mockResolvedValueOnce({ ...result, items: [{ ...item, title: "Previous account cached title" }] });
  open();
  await userEvent.click(await screen.findByRole("link", { name: "Previous account cached title" }));
  await screen.findByRole("heading", { level: 1, name: item.title });
  await act(async () => { window.dispatchEvent(new Event(WEB_SESSION_STARTED_EVENT)); });
  await screen.findByText("输入关键词，开始检索。");
  vi.mocked(api.searchEvimed).mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve; }));
  await act(async () => { await router.navigate(-1); });
  expect(screen.getByRole("status", { name: "正在检索" })).toBeInTheDocument();
  expect(screen.queryByText("Previous account cached title")).toBeNull();
  expect(api.searchEvimed).toHaveBeenCalledTimes(2);
  await act(async () => finishNew({ ...result, items: [{ ...item, title: "Current account fresh title" }] }));
  await screen.findByRole("link", { name: "Current account fresh title" });
});

it("invalidates cached lists when a detail request reports expired search authorization", async () => {
  let finishFresh!: (value: api.EvimedSearchResult) => void;
  vi.mocked(api.searchEvimed).mockResolvedValueOnce({ ...result, items: [{ ...item, title: "Cached authorized title" }] });
  vi.mocked(api.readEvimedSearchDetail).mockRejectedValueOnce(new WebApiError("expired", {
    status: 403, code: "evimed_search_credential_expired",
  }));
  open();
  await userEvent.click(await screen.findByRole("link", { name: "Cached authorized title" }));
  await screen.findByRole("link", { name: "重新登录" });
  vi.mocked(api.searchEvimed).mockImplementationOnce(() => new Promise((resolve) => { finishFresh = resolve; }));
  await act(async () => { await router.navigate(-1); });
  expect(screen.getByRole("status", { name: "正在检索" })).toBeInTheDocument();
  expect(screen.queryByText("Cached authorized title")).toBeNull();
  expect(queryParams().get("q")).toBe("高血压");
  expect(api.searchEvimed).toHaveBeenCalledTimes(2);
  await act(async () => finishFresh({ ...result, items: [{ ...item, title: "Revalidated fresh title" }] }));
  await screen.findByRole("link", { name: "Revalidated fresh title" });
});

it("keeps the result count outside the tabs and search controls across loading and large totals", async () => {
  let finish!: (value: api.EvimedSearchResult) => void;
  serveByRequest();
  const { container } = open();
  await screen.findByRole("link", { name: resultTitle("literature") });
  const count = container.querySelector("[data-search-count]")!;
  const heading = container.querySelector("[data-search-result-heading]")!;
  expect(count).toHaveTextContent("共 100 条");
  expect(heading).toContainElement(count as HTMLElement);
  expect(screen.getByRole("tablist", { name: "检索类别" })).not.toContainElement(count as HTMLElement);
  expect(screen.getByRole("searchbox", { name: "检索关键词" }).closest("[data-toolbar]")).not.toContainElement(count as HTMLElement);
  vi.mocked(api.searchEvimed).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await userEvent.click(screen.getByRole("tab", { name: "查指南" }));
  expect(container.querySelector("[data-search-count]")).toBe(count);
  expect(count).toHaveTextContent("正在检索");
  await act(async () => finish({ ...result, category: "guidelines", total: 2_345_678 }));
  expect(container.querySelector("[data-search-count]")).toBe(count);
  expect(count).toHaveTextContent("共 2,345,678 条");
  expect(screen.getAllByRole("tab").map(tab => tab.textContent)).toEqual(["搜文献", "查指南", "找药品", "临床试验"]);
});

it("applies a year draft once, resets pagination and reuses facets when only years, sort or page change", async () => {
  serveByRequest();
  open("/app/search/literature?q=高血压&page=3&language=en");
  await screen.findByRole("link", { name: resultTitle("literature", "高血压", 3) });
  await screen.findByRole("button", { name: "选择 2016—2021 年，共 3 条" });
  fireEvent.change(screen.getByLabelText("开始年份"), { target: { value: "2020" } });
  fireEvent.change(screen.getByLabelText("结束年份"), { target: { value: "2024" } });
  expect(api.searchEvimed).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "应用年份" }));
  await screen.findByRole("link", { name: resultTitle("literature") });
  expect(api.searchEvimed).toHaveBeenCalledTimes(2);
  expect(api.searchEvimed).toHaveBeenLastCalledWith("literature", expect.objectContaining({ page: 1,
    filters: { language: "en", sort: "comprehensive", startYear: 2020, endYear: 2024 },
  }), expect.any(AbortSignal));
  expect(queryParams().get("startYear")).toBe("2020");
  expect(queryParams().get("endYear")).toBe("2024");
  expect(queryParams().get("page")).toBeNull();
  await selectFilter("排序", "最新发表");
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByRole("link", { name: resultTitle("literature", "高血压", 2) });
  expect(api.readEvimedSearchFacets).toHaveBeenCalledTimes(1);
  expect(api.readEvimedSearchFacets).toHaveBeenCalledWith("literature", { query: "高血压", filters: { language: "en" } }, expect.any(AbortSignal));
  await userEvent.click(screen.getByRole("button", { name: "不限年份" }));
  await screen.findByRole("link", { name: resultTitle("literature") });
  expect(queryParams().get("startYear")).toBeNull();
  expect(queryParams().get("endYear")).toBeNull();
  expect(queryParams().get("sort")).toBe("newest");
  expect(api.readEvimedSearchFacets).toHaveBeenCalledTimes(1);
});

it("submits refinements from the sidebar and preserves extended filters in category caches", async () => {
  serveByRequest();
  open("/app/search/literature?q=高血压&page=3&language=en");
  await screen.findByRole("link", { name: resultTitle("literature", "高血压", 3) });
  await userEvent.click(await screen.findByRole("checkbox", { name: "随机对照研究" }));
  await screen.findByRole("link", { name: resultTitle("literature") });
  expect(queryParams().get("articleType")).toBe('["RCT"]');
  await userEvent.type(screen.getByRole("textbox", { name: "结果中搜索" }), "老年人");
  expect(queryParams().get("words")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "在结果中搜索" }));
  fireEvent.change(screen.getByLabelText("最小影响因子"), { target: { value: "2.5" } });
  fireEvent.change(screen.getByLabelText("最大影响因子"), { target: { value: "10" } });
  await userEvent.click(screen.getByRole("button", { name: "应用影响因子" }));
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByRole("link", { name: resultTitle("literature", "高血压", 2) });
  expect(api.searchEvimed).toHaveBeenLastCalledWith("literature", expect.objectContaining({ page: 2, filters: {
    words: "老年人", language: "en", sort: "comprehensive", articleType: ["RCT"], smallJcr: 2.5, bidJcr: 10,
  } }), expect.any(AbortSignal));
  await switchTab("查指南", "guidelines");
  const searches = vi.mocked(api.searchEvimed).mock.calls.length;
  const facets = vi.mocked(api.readEvimedSearchFacets).mock.calls.length;
  await switchTab("搜文献", "literature", "高血压", 2);
  expect(screen.getByRole("checkbox", { name: "随机对照研究" })).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("textbox", { name: "结果中搜索" })).toHaveValue("老年人");
  expect(screen.getByLabelText("最小影响因子")).toHaveValue(2.5);
  expect(screen.getByLabelText("最大影响因子")).toHaveValue(10);
  expect(api.searchEvimed).toHaveBeenCalledTimes(searches);
  expect(api.readEvimedSearchFacets).toHaveBeenCalledTimes(facets);
  fireEvent.change(screen.getByRole("searchbox", { name: "检索关键词" }), { target: { value: "糖尿病" } });
  await userEvent.click(screen.getByRole("button", { name: "检索" }));
  await screen.findByRole("link", { name: resultTitle("literature", "糖尿病") });
  expect(api.searchEvimed).toHaveBeenLastCalledWith("literature", expect.objectContaining({ page: 1,
    filters: { language: "", sort: "comprehensive" },
  }), expect.any(AbortSignal));
  for (const key of ["articleType", "words", "smallJcr", "bidJcr", "page"]) expect(queryParams().get(key)).toBeNull();
  await switchTab("查指南", "guidelines", "糖尿病");
  expect(api.readEvimedSearchFacets).toHaveBeenLastCalledWith("guidelines", { query: "糖尿病", filters: { language: "" } }, expect.any(AbortSignal));
});

it("removes language-specific ranking and JCR filters when leaving English literature", async () => {
  const params = new URLSearchParams({ q: "高血压", language: "en", sort: "impact-high", jcrPartition: JSON.stringify(["Q1"]), articleType: JSON.stringify(["RCT"]) });
  open(`/app/search/literature?${params}`);
  await screen.findByRole("link", { name: item.title });
  expect(await screen.findByRole("checkbox", { name: "Q1" })).toHaveAttribute("aria-checked", "true");
  await selectFilter("语言", "中文");
  await waitFor(() => expect(api.searchEvimed).toHaveBeenLastCalledWith("literature", expect.objectContaining({ filters: {
    language: "zh", sort: "comprehensive", articleType: ["RCT"],
  } }), expect.any(AbortSignal)));
  expect(queryParams().get("jcrPartition")).toBeNull();
  expect(queryParams().get("sort")).toBeNull();
  expect(queryParams().get("articleType")).toBe('["RCT"]');
});

it("submits both guideline department levels and clears all refinements without changing the keyword", async () => {
  serveByRequest();
  open("/app/search/guidelines?q=高血压&page=3");
  await screen.findByRole("link", { name: resultTitle("guidelines", "高血压", 3) });
  await userEvent.click(await screen.findByRole("checkbox", { name: "心内科" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "临床指南" }));
  expect(queryParams().get("secondLevelDepartment")).toBe('["心内科"]');
  expect(queryParams().get("firstLevelDepartment")).toBe('["内科"]');
  expect(queryParams().get("sType")).toBe('["1"]');
  await waitFor(() => expect(api.searchEvimed).toHaveBeenLastCalledWith("guidelines", expect.objectContaining({ page: 1, filters: {
    language: "", sort: "comprehensive", firstLevelDepartment: ["内科"], secondLevelDepartment: ["心内科"], sType: ["1"],
  } }), expect.any(AbortSignal)));
  await userEvent.click(screen.getByRole("button", { name: "清空筛选" }));
  await screen.findByRole("link", { name: resultTitle("guidelines") });
  expect(queryParams().get("q")).toBe("高血压");
  for (const key of ["firstLevelDepartment", "secondLevelDepartment", "sType", "page"]) expect(queryParams().get(key)).toBeNull();
  expect(screen.getByRole("checkbox", { name: "心内科" })).toHaveAttribute("aria-checked", "false");
});

it("clears incompatible trial filters on source changes and supports its registration-year and sample ranges", async () => {
  serveByRequest();
  const params = new URLSearchParams({ q: "高血压", studyType: JSON.stringify(["RCT"]), minSampleSize: "20", maxSampleSize: "200", testPhase: JSON.stringify(["III"]), page: "3" });
  open(`/app/search/trials?${params}`);
  await screen.findByRole("link", { name: resultTitle("trials", "高血压", 3) });
  await selectFilter("试验来源", "ClinicalTrials.gov");
  await screen.findByRole("link", { name: resultTitle("trials") });
  expect(api.searchEvimed).toHaveBeenLastCalledWith("trials", expect.objectContaining({ page: 1, filters: { source: "1" } }), expect.any(AbortSignal));
  for (const key of ["studyType", "minSampleSize", "maxSampleSize", "testPhase"]) expect(queryParams().get(key)).toBeNull();
  await userEvent.click(await screen.findByRole("checkbox", { name: "招募中" }));
  fireEvent.change(screen.getByLabelText("开始年份"), { target: { value: "2020" } });
  fireEvent.change(screen.getByLabelText("结束年份"), { target: { value: "2025" } });
  await userEvent.click(screen.getByRole("button", { name: "应用年份" }));
  fireEvent.change(screen.getByLabelText("最小样本量"), { target: { value: "100" } });
  await userEvent.click(screen.getByRole("button", { name: "应用样本量" }));
  expect(api.searchEvimed).toHaveBeenLastCalledWith("trials", expect.objectContaining({ filters: {
    source: "1", recruitmentStatus: ["RECRUITING"], startYear: 2020, endYear: 2025, minSampleSize: 100,
  } }), expect.any(AbortSignal));
  await selectFilter("试验来源", "其他注册平台");
  expect(queryParams().get("recruitmentStatus")).toBeNull();
  expect(queryParams().get("minSampleSize")).toBeNull();
  expect(queryParams().get("startYear")).toBe("2020");
  expect(screen.queryByLabelText("最小样本量")).toBeNull();
  await userEvent.click(await screen.findByRole("checkbox", { name: "WHO ICTRP" }));
  expect(api.searchEvimed).toHaveBeenLastCalledWith("trials", expect.objectContaining({ filters: {
    source: "2", startYear: 2020, endYear: 2025, clinicalSourceDb: "WHO",
  } }), expect.any(AbortSignal));
});

it("keeps successful results readable while facets fail and retries only the failed refinement request", async () => {
  vi.mocked(api.readEvimedSearchFacets).mockRejectedValueOnce(new Error("Private upstream facet error"));
  open();
  await screen.findByRole("link", { name: item.title });
  const retry = await screen.findByRole("button", { name: "重新加载筛选" });
  expect(screen.getByText("部分筛选暂时未能加载。")).toBeInTheDocument();
  expect(screen.queryByText("Private upstream facet error")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByLabelText("开始年份")).toBeEnabled();
  await userEvent.click(retry);
  await screen.findByRole("checkbox", { name: "随机对照研究" });
  expect(api.readEvimedSearchFacets).toHaveBeenCalledTimes(2);
  expect(api.searchEvimed).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "重新加载筛选" })).toBeNull();
});

it("retains available facets when a companion aggregation reports partial failure", async () => {
  vi.mocked(api.readEvimedSearchFacets).mockResolvedValueOnce({ ...facetsFor("literature"), unavailable: ["p"] });
  open();
  await screen.findByRole("link", { name: item.title });
  expect(await screen.findByRole("checkbox", { name: "随机对照研究" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "重新加载筛选" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "重新加载筛选" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "重新加载筛选" })).toBeNull());
  expect(api.searchEvimed).toHaveBeenCalledTimes(1);
});

it.each(["success", "failure"])("aborts stale category facets and ignores their late %s", async (completion) => {
  let resolveOld!: (value: api.EvimedSearchFacets) => void;
  let rejectOld!: (error: unknown) => void;
  serveByRequest();
  vi.mocked(api.readEvimedSearchFacets).mockImplementationOnce(() => new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; }));
  open();
  await screen.findByRole("link", { name: resultTitle("literature") });
  expect(screen.getByRole("status", { name: "正在加载筛选" })).toBeInTheDocument();
  const oldSignal = vi.mocked(api.readEvimedSearchFacets).mock.calls[0][2];
  await switchTab("找药品", "drugs");
  await screen.findByRole("button", { name: "药品来源" });
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => {
    if (completion === "success") resolveOld({ timeline: [], unavailable: [], groups: [{ key: "articleType", label: "过期分类", options: [{ value: "stale", label: "不应出现的过期筛选" }] }] });
    else rejectOld(new Error("Stale facet failure"));
  });
  expect(screen.queryByText("不应出现的过期筛选")).toBeNull();
  expect(screen.queryByRole("button", { name: "重新加载筛选" })).toBeNull();
  expect(screen.getByRole("button", { name: "药品来源" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: resultTitle("drugs") })).toBeInTheDocument();
});

it("expires cached refinements together with a reopened search after five minutes", async () => {
  serveByRequest();
  const now = Date.now();
  vi.setSystemTime(now);
  open();
  await screen.findByRole("link", { name: resultTitle("literature") });
  await switchTab("查指南", "guidelines");
  vi.setSystemTime(now + 299_000);
  await switchTab("搜文献", "literature");
  expect(api.readEvimedSearchFacets).toHaveBeenCalledTimes(2);
  await switchTab("查指南", "guidelines");
  vi.setSystemTime(now + 301_000);
  await switchTab("搜文献", "literature");
  expect(api.readEvimedSearchFacets).toHaveBeenCalledTimes(3);
});

it("ends pending facet work on an account change and never restores its private options", async () => {
  let finishOld!: (value: api.EvimedSearchFacets) => void;
  vi.mocked(api.readEvimedSearchFacets).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
  open();
  await screen.findByRole("link", { name: item.title });
  const oldSignal = vi.mocked(api.readEvimedSearchFacets).mock.calls[0][2];
  await act(async () => window.dispatchEvent(new Event(WEB_SESSION_STARTED_EVENT)));
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => finishOld({ timeline: [], unavailable: [], groups: [{ key: "articleType", label: "私有分类", options: [{ value: "private", label: "上一个账号的筛选" }] }] }));
  expect(screen.queryByText("上一个账号的筛选")).toBeNull();
  expect(screen.getByText("输入关键词，开始检索。")).toBeInTheDocument();
  expect(api.readEvimedSearchFacets).toHaveBeenCalledTimes(1);
});

it("refuses late successful search rows when the companion facets report expired authorization", async () => {
  let finishList!: (value: api.EvimedSearchResult) => void;
  vi.mocked(api.searchEvimed).mockImplementationOnce(() => new Promise((resolve) => { finishList = resolve; }));
  vi.mocked(api.readEvimedSearchFacets).mockRejectedValueOnce(new WebApiError("expired", { status: 403, code: "evimed_search_credential_expired" }));
  open();
  await screen.findByRole("link", { name: "重新登录" });
  expect(vi.mocked(api.searchEvimed).mock.calls[0][2]?.aborted).toBe(true);
  await act(async () => finishList({ ...result, items: [{ ...item, title: "Unauthorized late result" }] }));
  expect(screen.queryByText("Unauthorized late result")).toBeNull();
  expect(screen.getByRole("link", { name: "重新登录" })).toBeInTheDocument();
});

function serveSelectablePages() {
  vi.mocked(api.searchEvimed).mockImplementation(async (category, request) => ({
    ...result, category, query: request.query, page: request.page, total: 40,
    items: Array.from({ length: 10 }, (_, index) => ({ ...item,
      id: `paper-${request.page}-${index}`, title: `${category} ${request.page}-${index}`,
      actionRef: `${category}-action-${request.page}-${index}`, collected: false,
    })),
  }));
}

it("retains selected literature across pages and sorting while category tabs keep their own state", async () => {
  serveSelectablePages();
  open();
  await userEvent.click(await screen.findByRole("checkbox", { name: "选择《literature 1-0》" }));
  expect(screen.getByRole("button", { name: "导出已选 1 篇" })).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "选择本页" })).toBePartiallyChecked();
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  await userEvent.click(await screen.findByRole("checkbox", { name: "选择《literature 2-0》" }));
  expect(screen.getByRole("button", { name: "导出已选 2 篇" })).toBeInTheDocument();
  await selectFilter("排序", "最新发表");
  await screen.findByRole("link", { name: "literature 1-0" });
  expect(screen.getByRole("checkbox", { name: "选择《literature 1-0》" })).toBeChecked();
  expect(screen.getByRole("button", { name: "导出已选 2 篇" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab", { name: "查指南" }));
  await screen.findByRole("link", { name: "guidelines 1-0" });
  expect(screen.queryByRole("group", { name: "已选文献操作" })).toBeNull();
  expect(screen.queryByRole("checkbox", { name: "选择本页" })).toBeNull();
  await selectFilter("语言", "英文");
  await userEvent.click(screen.getByRole("tab", { name: "搜文献" }));
  await screen.findByRole("link", { name: "literature 1-0" });
  expect(screen.getByRole("checkbox", { name: "选择《literature 1-0》" })).toBeChecked();
  expect(screen.getByRole("button", { name: "导出已选 2 篇" })).toBeInTheDocument();
  expect(queryParams().get("sort")).toBe("newest");
  expect(queryParams().get("language")).toBeNull();
});

it.each(["filter", "new-keyword", "same-keyword", "session"])("clears selected references after %s and does not restore them from another tab", async (reason) => {
  serveSelectablePages();
  open();
  await userEvent.click(await screen.findByRole("checkbox", { name: "选择《literature 1-0》" }));
  expect(screen.getByRole("button", { name: "导出已选 1 篇" })).toBeInTheDocument();
  if (reason === "filter") await selectFilter("语言", "英文");
  else if (reason === "session") await act(async () => { window.dispatchEvent(new Event(WEB_SESSION_ENDED_EVENT)); });
  else {
    if (reason === "new-keyword") fireEvent.change(screen.getByRole("searchbox", { name: "检索关键词" }), { target: { value: "糖尿病" } });
    await userEvent.click(screen.getByRole("button", { name: "检索" }));
  }
  if (reason === "session") {
    await screen.findByText("输入关键词，开始检索。");
    await userEvent.type(screen.getByRole("searchbox", { name: "检索关键词" }), "高血压{Enter}");
  }
  await screen.findByRole("link", { name: "literature 1-0" });
  expect(screen.queryByRole("group", { name: "已选文献操作" })).toBeNull();
  expect(screen.getByRole("checkbox", { name: "选择《literature 1-0》" })).not.toBeChecked();
  await userEvent.click(screen.getByRole("tab", { name: "查指南" }));
  await screen.findByRole("link", { name: "guidelines 1-0" });
  await userEvent.click(screen.getByRole("tab", { name: "搜文献" }));
  await screen.findByRole("link", { name: "literature 1-0" });
  expect(screen.queryByRole("group", { name: "已选文献操作" })).toBeNull();
  expect(screen.getByRole("checkbox", { name: "选择《literature 1-0》" })).not.toBeChecked();
});

it("caps cross-page selections at twenty records and submits only those signed references", async () => {
  serveSelectablePages();
  open();
  await screen.findByRole("link", { name: "literature 1-0" });
  await userEvent.click(screen.getByRole("checkbox", { name: "选择本页" }));
  expect(screen.getByRole("button", { name: "导出已选 10 篇" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByRole("link", { name: "literature 2-0" });
  await userEvent.click(screen.getByRole("checkbox", { name: "选择本页" }));
  expect(screen.getByRole("button", { name: "导出已选 20 篇" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByRole("link", { name: "literature 3-0" });
  expect(screen.getByRole("checkbox", { name: "选择本页" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "选择《literature 3-0》" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "导出已选 20 篇" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Excel" }));
  await waitFor(() => expect(api.exportEvimedSearchRecords).toHaveBeenCalledTimes(1));
  const [category, refs, format, signal] = vi.mocked(api.exportEvimedSearchRecords).mock.calls[0];
  expect(category).toBe("literature");
  expect(format).toBe(1);
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(refs).toEqual([1, 2].flatMap(page => Array.from({ length: 10 }, (_, index) => `literature-action-${page}-${index}`)));
  await userEvent.click(screen.getByRole("button", { name: "清空选择" }));
  expect(screen.queryByRole("group", { name: "已选文献操作" })).toBeNull();
  expect(screen.getByRole("checkbox", { name: "选择本页" })).toBeEnabled();
  expect(screen.getByRole("checkbox", { name: "选择《literature 3-0》" })).toBeEnabled();
});

it("synchronizes collection from the reader back to cached rows without crossing categories with the same id", async () => {
  vi.mocked(api.searchEvimed).mockImplementation(async (category, request) => ({ ...result, category, query: request.query, page: request.page,
    items: [{ ...item, id: "shared-id", title: `${category} collection record`, actionRef: `${category}-list-action`, collected: false }],
  }));
  vi.mocked(api.readEvimedSearchDetail).mockImplementation(async (category) => ({
    id: "shared-id", title: `${category} collection reader`, actionRef: `${category}-detail-action`, collected: false,
    subtitle: "", source: "", url: null, doi: null, sections: [], metadata: [],
  }));
  open();
  await screen.findByRole("link", { name: "literature collection record" });
  await userEvent.click(screen.getByRole("tab", { name: "查指南" }));
  await screen.findByRole("link", { name: "guidelines collection record" });
  expect(screen.getByRole("button", { name: /^收藏$/ })).toHaveAttribute("aria-pressed", "false");
  await userEvent.click(screen.getByRole("tab", { name: "搜文献" }));
  await userEvent.click(await screen.findByRole("link", { name: "literature collection record" }));
  await screen.findByRole("heading", { name: "literature collection reader", level: 1 });
  await userEvent.click(screen.getByRole("button", { name: /^收藏$/ }));
  await screen.findByRole("button", { name: "已收藏" });
  expect(api.setEvimedSearchCollection).toHaveBeenLastCalledWith("literature", "literature-detail-action", true, expect.any(AbortSignal));
  await userEvent.click(screen.getByRole("link", { name: "返回检索结果" }));
  await screen.findByRole("link", { name: "literature collection record" });
  expect(screen.getByRole("button", { name: "已收藏" })).toHaveAttribute("aria-pressed", "true");
  await userEvent.click(screen.getByRole("tab", { name: "查指南" }));
  await screen.findByRole("link", { name: "guidelines collection record" });
  expect(screen.getByRole("button", { name: /^收藏$/ })).toHaveAttribute("aria-pressed", "false");
  await userEvent.click(screen.getByRole("tab", { name: "搜文献" }));
  await screen.findByRole("link", { name: "literature collection record" });
  await userEvent.click(screen.getByRole("button", { name: "已收藏" }));
  await screen.findByRole("button", { name: /^收藏$/ });
  await userEvent.click(screen.getByRole("link", { name: "literature collection record" }));
  await screen.findByRole("heading", { name: "literature collection reader", level: 1 });
  expect(screen.getByRole("button", { name: /^收藏$/ })).toHaveAttribute("aria-pressed", "false");
  expect(api.searchEvimed).toHaveBeenCalledTimes(2);
  expect(api.readEvimedSearchDetail).toHaveBeenCalledTimes(1);
});

it("aborts a pending collection on tab change and ignores its late response", async () => {
  let finish!: (value: { collected: boolean }) => void;
  vi.mocked(api.searchEvimed).mockImplementation(async (category, request) => ({ ...result, category, query: request.query, page: request.page,
    items: [{ ...item, title: `${category} collection record`, actionRef: `${category}-action`, collected: false }],
  }));
  vi.mocked(api.setEvimedSearchCollection).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  open();
  await screen.findByRole("link", { name: "literature collection record" });
  await userEvent.click(screen.getByRole("button", { name: /^收藏$/ }));
  const signal = vi.mocked(api.setEvimedSearchCollection).mock.calls[0][3];
  await userEvent.click(screen.getByRole("tab", { name: "查指南" }));
  await screen.findByRole("link", { name: "guidelines collection record" });
  expect(signal?.aborted).toBe(true);
  await act(async () => finish({ collected: true }));
  expect(screen.getByRole("button", { name: /^收藏$/ })).toHaveAttribute("aria-pressed", "false");
  await userEvent.click(screen.getByRole("tab", { name: "搜文献" }));
  await screen.findByRole("link", { name: "literature collection record" });
  expect(screen.getByRole("button", { name: /^收藏$/ })).toHaveAttribute("aria-pressed", "false");
});
