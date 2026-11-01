import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EvimedSearchHome } from "./EvimedSearchHome";
import type { EvimedSearchCategory } from "@/lib/evimedSearchClient";
import { readEvimedSearchTopics, type EvimedSearchTopics } from "@/lib/evimedSearchTopicsClient";
import { useProjectStore } from "@/lib/projects";
import { WEB_SESSION_ENDED_EVENT, WEB_SESSION_STARTED_EVENT } from "@/lib/apiClient";

vi.mock("@/lib/evimedSearchTopicsClient", () => ({ readEvimedSearchTopics: vi.fn() }));
const readTopics = vi.mocked(readEvimedSearchTopics);
const initialProject = useProjectStore.getState().currentId;
const handlers = { onDraftChange: vi.fn(), onCategoryChange: vi.fn(), onSubmit: vi.fn(), onClear: vi.fn(), onCompositionChange: vi.fn() };

function feed(category: EvimedSearchCategory = "literature", query = "检索主题", isExample = false): EvimedSearchTopics {
  return { schemaVersion: 1, category, topics: [{ id: `${category}-one`, query, description: "可查看相关资料" }], count: 1, total: 1,
    updatedAt: "2026-10-30T00:00:00Z", revision: "feed-revision", source: { kind: "curated", label: "精选主题", isExample } };
}
function recentFeed(category: EvimedSearchCategory = "literature", query = "近期研究主题", stale = false): EvimedSearchTopics {
  const data = feed(category, query);
  data.source = { kind: "provider", label: "近期医学主题", isExample: false };
  data.recommendation = { algorithm: "recent-medical-topics-v1", windowDays: 30, generatedAt: "2026-10-30T02:00:00Z",
    dataThrough: "2026-10-30T01:00:00Z", stale, corpusVersion: "internal-corpus-revision" };
  data.topics[0]!.basis = { eventCount: 8, sourceCount: 4, latestAt: "2026-10-29T01:00:00Z", sources: [
    { id: "published-source", title: `${query}的已发表进展`, url: "https://pubmed.ncbi.nlm.nih.gov/12345678/", source: "PubMed",
      publishedAt: "2026-10-29T01:00:00Z", timelineAt: "2026-10-29T01:00:00Z", dateBasis: "published" },
    { id: "observed-source", title: `${query}的未标注日期进展`, url: "https://www.fda.gov/drugs/", source: "FDA",
      publishedAt: null, timelineAt: "2026-10-28T01:00:00Z", dateBasis: "observed" },
  ] };
  return data;
}
function page(category: EvimedSearchCategory = "literature") {
  return <EvimedSearchHome {...handlers} category={category} draft="" />;
}
function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((finish, fail) => { resolve = finish; reject = fail; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetAllMocks();
  useProjectStore.setState({ currentId: "project-one" });
  readTopics.mockResolvedValue(feed());
});
afterEach(() => { cleanup(); useProjectStore.setState({ currentId: initialProject }); });

it("reads the current project's topics and only fills and focuses the composer", async () => {
  render(page());
  const topic = await screen.findByRole("button", { name: "检索主题" });
  expect(readTopics).toHaveBeenCalledWith("project-one", "literature", expect.any(AbortSignal));
  await userEvent.click(topic);
  expect(handlers.onDraftChange).toHaveBeenCalledWith("检索主题");
  expect(screen.getByRole("searchbox", { name: "检索关键词" })).toHaveFocus();
  expect(handlers.onSubmit).not.toHaveBeenCalled();
  expect(screen.queryByText("示例主题")).toBeNull();
});

it("labels an example feed explicitly without calling it live or popular", async () => {
  readTopics.mockResolvedValue(feed("literature", "示例检索词", true));
  render(page());
  expect(await screen.findByText("示例主题")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "示例检索词" })).toBeInTheDocument();
});

it("keeps manual search available during a topic request and shows no static fallback", async () => {
  readTopics.mockReturnValue(pending<EvimedSearchTopics>().promise);
  render(page());
  expect(screen.getByLabelText("正在读取检索主题")).toHaveAttribute("aria-busy", "true");
  await userEvent.type(screen.getByRole("searchbox", { name: "检索关键词" }), "新研究");
  expect(handlers.onDraftChange).toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "高血压" })).toBeNull();
  expect(handlers.onSubmit).not.toHaveBeenCalled();
});

it("discards an old category response even when its producer ignores cancellation", async () => {
  const old = pending<EvimedSearchTopics>();
  readTopics.mockReturnValueOnce(old.promise).mockResolvedValue(recentFeed("drugs", "新的药品主题"));
  const view = render(page());
  const signal = readTopics.mock.calls[0]![2];
  view.rerender(page("drugs"));
  expect(signal.aborted).toBe(true);
  expect(await screen.findByRole("button", { name: "新的药品主题" })).toBeInTheDocument();
  await act(async () => { old.resolve(recentFeed("literature", "过期文献主题")); });
  expect(screen.queryByRole("button", { name: "过期文献主题" })).toBeNull();
  expect(screen.getByRole("button", { name: "新的药品主题" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "新的药品主题，查看近期进展来源" }));
  expect(screen.getByRole("link", { name: "新的药品主题的已发表进展" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "过期文献主题的已发表进展" })).toBeNull();
});

it.each<EvimedSearchCategory>(["literature", "guidelines", "drugs", "trials"])("shows dated source previews for the %s category without submitting a search", async category => {
  const data = recentFeed(category, `${category}主题`);
  readTopics.mockResolvedValue(data);
  render(page(category));
  expect(await screen.findByRole("heading", { name: "近期医学主题" })).toBeInTheDocument();
  expect(screen.queryByText("示例主题")).toBeNull();
  if (category === "trials") expect(screen.getByRole("status")).toHaveTextContent("近 30 天已采集的试验更新（非注册库总量）");
  else expect(screen.getByRole("status")).not.toHaveTextContent("非注册库总量");
  expect(screen.getByText(/进展截至/)).toHaveTextContent(category === "trials" ? "2026-10-29" : "2026-10-29 09:00");
  const sources = screen.getByRole("button", { name: `${category}主题，查看近期进展来源` });
  expect(sources).toHaveTextContent("查看 2 条原文");
  expect(sources.closest("button button")).toBeNull();
  sources.focus();
  await userEvent.keyboard("{Enter}");
  const drawer = screen.getByRole("dialog", { name: `${category}主题的近期进展` });
  expect(drawer).toHaveTextContent("近 30 天采集到 8 条相关进展，来自 4 个来源。以下展示其中 2 条原文。");
  const original = within(drawer).getByRole("link", { name: `${category}主题的已发表进展` });
  expect(original).toHaveAttribute("href", data.topics[0]!.basis!.sources[0]!.url);
  expect(original).toHaveAttribute("target", "_blank");
  expect(original).toHaveAttribute("rel", "noreferrer");
  expect(within(drawer).getByText(/PubMed · 发表于/)).toHaveTextContent("2026-10-29");
  expect(within(drawer).getByText(/FDA · 收录于/)).toHaveTextContent("2026-10-28");
  expect(drawer).not.toHaveTextContent("internal-corpus-revision");
  expect(handlers.onSubmit).not.toHaveBeenCalled();
  expect(handlers.onDraftChange).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(sources).toHaveFocus();
});

it("labels stale recent topics with their date and replaces them only after a successful refresh", async () => {
  const refreshed = pending<EvimedSearchTopics>();
  readTopics.mockResolvedValueOnce(recentFeed("literature", "上次主题", true)).mockReturnValueOnce(refreshed.promise);
  render(page());
  expect(await screen.findByText(/暂未获取更新，显示上次主题/)).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("进展截至 2026-10-29 09:00");
  await userEvent.click(screen.getByRole("button", { name: "重试更新主题" }));
  expect(screen.getByRole("button", { name: "上次主题" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "重试更新主题" })).toHaveAttribute("aria-busy", "true");
  await userEvent.click(screen.getByRole("button", { name: "重试更新主题" }));
  expect(readTopics).toHaveBeenCalledTimes(2);
  await act(async () => { refreshed.resolve(recentFeed("literature", "更新主题")); });
  expect(await screen.findByRole("button", { name: "更新主题" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "上次主题" })).toBeNull();
  expect(screen.queryByText(/暂未获取更新/)).toBeNull();
  expect(handlers.onClear).not.toHaveBeenCalled();
});

it("preserves usable topics and their sources through a refresh failure, with local retry", async () => {
  const refresh = pending<EvimedSearchTopics>();
  readTopics.mockResolvedValueOnce(recentFeed()).mockReturnValueOnce(refresh.promise).mockResolvedValueOnce(recentFeed("literature", "恢复后的主题"));
  render(page());
  await userEvent.click(await screen.findByRole("button", { name: "刷新主题" }));
  expect(screen.getByRole("button", { name: "近期研究主题" })).toBeInTheDocument();
  await act(async () => { refresh.reject(new Error("Temporary refresh failure")); });
  expect(await screen.findByText(/更新暂时失败，保留上次主题/)).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("进展截至 2026-10-29 09:00");
  await userEvent.click(screen.getByRole("button", { name: "近期研究主题，查看近期进展来源" }));
  expect(screen.getByRole("link", { name: "近期研究主题的已发表进展" })).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("button", { name: "重试更新主题" }));
  expect(await screen.findByRole("button", { name: "恢复后的主题" })).toBeInTheDocument();
  expect(screen.queryByText(/更新暂时失败/)).toBeNull();
  expect(handlers.onClear).not.toHaveBeenCalled();
  expect(handlers.onSubmit).not.toHaveBeenCalled();
});

it("closes a source preview immediately when its category changes", async () => {
  readTopics.mockResolvedValueOnce(recentFeed()).mockResolvedValueOnce(recentFeed("trials", "新试验主题"));
  const view = render(page());
  await userEvent.click(await screen.findByRole("button", { name: "近期研究主题，查看近期进展来源" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  view.rerender(page("trials"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button", { name: "近期研究主题" })).toBeNull();
  expect(await screen.findByRole("button", { name: "新试验主题" })).toBeInTheDocument();
});

it("labels a registry's posted update date as an update, not publication or collection", async () => {
  const data = recentFeed("trials", "近期试验主题");
  data.topics[0]!.basis!.sources = [{ id: "NCT07797140", title: "Recently updated trial", url: "https://clinicaltrials.gov/study/NCT07797140",
    source: "ClinicalTrials.gov", publishedAt: null, timelineAt: "2026-10-29T00:00:00.000Z", dateBasis: "updated" }];
  readTopics.mockResolvedValue(data);
  render(page("trials"));
  await userEvent.click(await screen.findByRole("button", { name: "近期试验主题，查看近期进展来源" }));
  const drawer = screen.getByRole("dialog");
  expect(within(drawer).getByText(/ClinicalTrials.gov · 更新于/)).toHaveTextContent("2026-10-29");
  expect(drawer).not.toHaveTextContent("发表于");
  expect(drawer).not.toHaveTextContent("收录于");
});

it("dates current-category progress from its own topics rather than a newer global corpus timestamp", async () => {
  const data = recentFeed("trials", "近期试验主题");
  data.topics[0]!.basis!.latestAt = "2026-10-29T00:00:00.000Z";
  readTopics.mockResolvedValueOnce(data).mockResolvedValueOnce({ ...data, category: "guidelines", topics: [], count: 0, total: 0 });
  const view = render(page("trials"));
  await screen.findByRole("heading", { name: "近期医学主题" });
  expect(screen.getByRole("status")).toHaveTextContent("进展截至 2026-10-29");
  expect(screen.getByRole("status")).not.toHaveTextContent("08:00");
  expect(screen.getByRole("status")).not.toHaveTextContent("2026-10-30");
  view.rerender(page("guidelines"));
  await screen.findByText("暂无可选主题");
  expect(screen.getByRole("status")).not.toHaveTextContent("进展截至");
});

it("clears topics and discards late responses when the selected project changes", async () => {
  const old = pending<EvimedSearchTopics>();
  readTopics.mockReturnValueOnce(old.promise).mockResolvedValue(feed("literature", "新项目主题"));
  render(page());
  const signal = readTopics.mock.calls[0]![2];
  act(() => { useProjectStore.setState({ currentId: "project-two" }); });
  expect(signal.aborted).toBe(true);
  expect(await screen.findByRole("button", { name: "新项目主题" })).toBeInTheDocument();
  await act(async () => { old.resolve(feed("literature", "旧项目主题")); });
  expect(screen.queryByRole("button", { name: "旧项目主题" })).toBeNull();
  expect(readTopics).toHaveBeenLastCalledWith("project-two", "literature", expect.any(AbortSignal));
});

it("offers local recovery after failure without resetting the composer", async () => {
  readTopics.mockRejectedValueOnce(new Error("Temporarily unavailable")).mockResolvedValue(feed());
  render(page());
  await userEvent.click(await screen.findByRole("button", { name: "重试读取主题" }));
  expect(await screen.findByRole("button", { name: "检索主题" })).toBeInTheDocument();
  expect(readTopics).toHaveBeenCalledTimes(2);
  expect(handlers.onClear).not.toHaveBeenCalled();
  expect(handlers.onSubmit).not.toHaveBeenCalled();
});

it("shows a real empty feed without invented replacements", async () => {
  readTopics.mockResolvedValue({ ...feed(), topics: [], count: 0, total: 0 });
  render(page());
  expect(await screen.findByText("暂无可选主题")).toBeInTheDocument();
  expect(screen.getByText("直接输入关键词，即可开始检索。")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "高血压" })).toBeNull();
});

it("does not create a project or read a feed without a selected project", async () => {
  useProjectStore.setState({ currentId: "" });
  render(page());
  expect(screen.getByText("选择项目后查看主题")).toBeInTheDocument();
  expect(readTopics).not.toHaveBeenCalled();
  expect(screen.getByRole("searchbox", { name: "检索关键词" })).toBeEnabled();
});

it("refreshes topic identity when an account session changes", async () => {
  render(page());
  await screen.findByRole("button", { name: "检索主题" });
  const pendingFeed = pending<EvimedSearchTopics>();
  readTopics.mockReturnValue(pendingFeed.promise);
  act(() => { window.dispatchEvent(new Event(WEB_SESSION_STARTED_EVENT)); });
  await waitFor(() => expect(readTopics).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("button", { name: "检索主题" })).toBeNull();
});

it("clears a signed-out account's topics without creating a retry loop", async () => {
  render(page());
  await screen.findByRole("button", { name: "检索主题" });
  act(() => { window.dispatchEvent(new Event(WEB_SESSION_ENDED_EVENT)); });
  expect(screen.queryByRole("button", { name: "检索主题" })).toBeNull();
  expect(screen.getByText("登录已失效，请重新登录后查看主题。")).toBeInTheDocument();
  expect(readTopics).toHaveBeenCalledTimes(1);
});

it("aborts a pending read on unmount", () => {
  readTopics.mockReturnValue(pending<EvimedSearchTopics>().promise);
  const view = render(page());
  const signal = readTopics.mock.calls[0]![2];
  view.unmount();
  expect(signal.aborted).toBe(true);
});
