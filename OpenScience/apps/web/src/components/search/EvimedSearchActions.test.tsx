import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EvimedSearchActions, EvimedSearchBatchActions } from "./EvimedSearchActions";
import { WEB_SESSION_ENDED_EVENT, WEB_SESSION_SYNC_STORAGE_KEY, WebApiError } from "@/lib/apiClient";

const api = vi.hoisted(() => ({ collect: vi.fn(), citations: vi.fn(), export: vi.fn(), status: vi.fn(), offer: vi.fn(), request: vi.fn(), download: vi.fn() }));
vi.mock("@/lib/evimedSearchClient", async (original) => ({ ...await original<typeof import("@/lib/evimedSearchClient")>(),
  setEvimedSearchCollection: api.collect, readEvimedSearchCitations: api.citations, exportEvimedSearchRecords: api.export,
  readEvimedFullTextStatus: api.status, readEvimedFullTextOffer: api.offer, requestEvimedFullText: api.request, downloadEvimedFullText: api.download,
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const item = { id: "paper-1", title: "A controlled study", actionRef: "opaque-action-one", collected: false };
const available = { status: 2, url: "https://example.org/paper.pdf", canRequest: false, canDownload: true };
const offer = { status: 2, url: "https://example.org/paper.pdf", offerRef: "opaque-offer", filename: "paper.pdf", daily: 0, permanent: 0,
  unlimited: false, kind: "beans" as const, amount: 3 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const createObjectURL = URL.createObjectURL;
const revokeObjectURL = URL.revokeObjectURL;
beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  api.collect.mockResolvedValue({ collected: true });
  api.citations.mockResolvedValue({ quotes: [{ label: "GB/T 7714", text: "A controlled study [J]. 2026." }] });
  api.export.mockResolvedValue({ filename: "references.xlsx", contentType: "application/octet-stream", base64: btoa("file content") });
  api.status.mockResolvedValue(available); api.offer.mockResolvedValue(offer);
  api.request.mockResolvedValue({ status: 1, url: null, canRequest: false, canDownload: false });
  api.download.mockResolvedValue({ blob: new Blob(["%PDF-1.7 test"]), filename: "paper.pdf" });
  URL.createObjectURL = vi.fn(() => "blob:test-download"); URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); URL.createObjectURL = createObjectURL; URL.revokeObjectURL = revokeObjectURL;
});

describe("search result actions", () => {
  it("opens export formats from the compact overflow without fetching or downloading on menu open", async () => {
    const user = userEvent.setup();
    render(<EvimedSearchActions category="literature" item={item} />);
    expect(screen.getByRole("button", { name: "收藏" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "引用" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "原文下载" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menuitem", { name: "原文下载" })).toBeInTheDocument();
    expect(screen.getByText("题录导出")).toBeInTheDocument();
    expect(api.status).not.toHaveBeenCalled();
    expect(api.export).not.toHaveBeenCalled();
    await user.click(screen.getByRole("menuitem", { name: "PDF" }));
    await waitFor(() => expect(api.export).toHaveBeenCalledWith("literature", [item.actionRef], 2, expect.any(AbortSignal)));
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
  });

  it("retains labelled direct actions in the reader and does not offer literature exports for drug labels", async () => {
    const user = userEvent.setup();
    const view = render(<EvimedSearchActions category="literature" item={item} compact={false} />);
    expect(screen.getByRole("button", { name: "题录导出" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "原文下载" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "更多操作" })).not.toBeInTheDocument();
    view.rerender(<EvimedSearchActions category="drugs" item={item} />);
    await user.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menuitem", { name: "原文下载" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "PDF" })).not.toBeInTheDocument();
  });

  it("offers no unsupported trial actions or actions without an admitted reference", () => {
    const view = render(<EvimedSearchActions category="trials" item={item} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    view.rerender(<EvimedSearchActions category="literature" item={{ ...item, actionRef: null }} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(api.status).not.toHaveBeenCalled(); expect(api.collect).not.toHaveBeenCalled();
  });

  it("commits collection state only after success and prevents duplicate writes", async () => {
    const pending = deferred<{ collected: boolean }>(); api.collect.mockReturnValueOnce(pending.promise);
    const update = vi.fn(); const user = userEvent.setup();
    render(<EvimedSearchActions category="literature" item={item} onCollectedChange={update} />);
    await user.click(screen.getByRole("button", { name: "收藏" }));
    expect(screen.getByRole("button", { name: "收藏" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "收藏" })).toHaveAttribute("aria-busy", "true");
    await user.click(screen.getByRole("button", { name: "收藏" }));
    expect(api.collect).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    await act(async () => pending.resolve({ collected: true }));
    expect(screen.getByRole("button", { name: "已收藏" })).toHaveAttribute("aria-pressed", "true");
    expect(api.collect).toHaveBeenCalledWith("literature", item.actionRef, true, expect.any(AbortSignal));
    expect(update).toHaveBeenCalledWith(true);
  });

  it("keeps a failed collection unchanged and suppresses a late response for a different item", async () => {
    const user = userEvent.setup(); api.collect.mockRejectedValueOnce(new Error("offline"));
    const update = vi.fn(); const view = render(<EvimedSearchActions category="guidelines" item={item} onCollectedChange={update} />);
    await user.click(screen.getByRole("button", { name: "收藏" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收藏" })).toHaveAttribute("aria-pressed", "false");
    const pending = deferred<{ collected: boolean }>(); api.collect.mockReturnValueOnce(pending.promise);
    await user.click(screen.getByRole("button", { name: "重试" }));
    const signal = api.collect.mock.calls.at(-1)![3] as AbortSignal;
    view.rerender(<EvimedSearchActions category="guidelines" item={{ ...item, id: "second", actionRef: "opaque-two" }} onCollectedChange={update} />);
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve({ collected: true }));
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "收藏" })).toHaveAttribute("aria-pressed", "false");
  });

  it("switches citation format without allowing the old response to replace it and copies plain text", async () => {
    const pending = deferred<{ quotes: { label: string; text: string }[] }>(); api.citations.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup(); const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<EvimedSearchActions category="literature" item={item} />);
    await user.click(screen.getByRole("button", { name: "引用" }));
    const firstSignal = api.citations.mock.calls[0][3] as AbortSignal;
    api.citations.mockResolvedValueOnce({ quotes: [{ label: "Bibtex", text: "@article{paper,title={A controlled study}}" }] });
    await user.selectOptions(screen.getByRole("combobox", { name: "引用格式" }), "5");
    expect(firstSignal.aborted).toBe(true);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "引用内容" })).toHaveValue("@article{paper,title={A controlled study}}"));
    await act(async () => pending.resolve({ quotes: [{ label: "Old", text: "stale citation" }] }));
    await user.click(screen.getByRole("button", { name: "复制引用" }));
    expect(copy).toHaveBeenCalledWith("@article{paper,title={A controlled study}}");
    expect(api.citations).toHaveBeenLastCalledWith("literature", [item.actionRef], 5, expect.any(AbortSignal));
  });

  it("reads the full-text offer on open and downloads only after an explicit cost confirmation", async () => {
    const pending = deferred<{ blob: Blob; filename: string }>(); api.download.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup(); render(<EvimedSearchActions category="literature" item={item} />);
    await user.click(screen.getByRole("button", { name: "更多操作" }));
    await user.click(screen.getByRole("menuitem", { name: "原文下载" }));
    const dialog = screen.getByRole("dialog", { name: "原文下载" });
    expect(await within(dialog).findByText("免费次数已用完，本次下载消耗 3 灵豆。")).toBeInTheDocument();
    expect(api.download).not.toHaveBeenCalled(); expect(api.request).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "确认下载 · 3 灵豆" }));
    expect(api.download).toHaveBeenCalledWith("literature", offer, expect.any(AbortSignal));
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeDisabled();
    await act(async () => pending.resolve({ blob: new Blob(["%PDF-1.7 test"]), filename: "paper.pdf" }));
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("requires a new offer and another confirmation after a failed download authorization", async () => {
    api.download.mockRejectedValueOnce(new Error("cost changed"));
    const user = userEvent.setup(); render(<EvimedSearchActions category="literature" item={item} />);
    await user.click(screen.getByRole("button", { name: "更多操作" }));
    await user.click(screen.getByRole("menuitem", { name: "原文下载" }));
    await user.click(await screen.findByRole("button", { name: "确认下载 · 3 灵豆" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认下载 · 3 灵豆" })).not.toBeInTheDocument();
    expect(api.download).toHaveBeenCalledTimes(1);
    api.offer.mockResolvedValueOnce({ ...offer, amount: 4 });
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("button", { name: "确认下载 · 4 灵豆" })).toBeInTheDocument();
    expect(api.download).toHaveBeenCalledTimes(1);
  });

  it("cancels an unfinished offer when its dialog closes without authorizing a download", async () => {
    const pending = deferred<typeof offer>(); api.offer.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup(); render(<EvimedSearchActions category="literature" item={item} />);
    await user.click(screen.getByRole("button", { name: "更多操作" }));
    await user.click(screen.getByRole("menuitem", { name: "原文下载" }));
    await waitFor(() => expect(api.offer).toHaveBeenCalledOnce());
    const signal = api.offer.mock.calls[0][2] as AbortSignal;
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(offer));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.download).not.toHaveBeenCalled(); expect(api.request).not.toHaveBeenCalled();
  });

  it("requests an unavailable original only when the reader chooses to obtain it", async () => {
    api.status.mockResolvedValue({ status: 0, url: null, canRequest: true, canDownload: false });
    const user = userEvent.setup(); render(<EvimedSearchActions category="drugs" item={item} />);
    expect(screen.queryByRole("button", { name: "引用" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "更多操作" }));
    await user.click(screen.getByRole("menuitem", { name: "原文下载" }));
    expect(await screen.findByRole("button", { name: "获取原文" })).toBeInTheDocument();
    expect(api.request).not.toHaveBeenCalled(); expect(api.offer).not.toHaveBeenCalled();
    api.status.mockResolvedValueOnce({ status: 1, url: null, canRequest: false, canDownload: false });
    await user.click(screen.getByRole("button", { name: "获取原文" }));
    expect(await screen.findByText("原文正在获取中。")).toBeInTheDocument();
    expect(api.request).toHaveBeenCalledOnce(); expect(api.download).not.toHaveBeenCalled();
  });

  it("exports the selected literature once and never offers batch actions for other categories", async () => {
    const clear = vi.fn(); const user = userEvent.setup();
    const view = render(<EvimedSearchBatchActions category="literature" items={[item, item, { ...item, id: "two", actionRef: "opaque-two" }]} onClear={clear} />);
    await user.click(screen.getByRole("button", { name: "导出已选 2 篇" }));
    await user.click(screen.getByRole("menuitem", { name: "Excel" }));
    await waitFor(() => expect(api.export).toHaveBeenCalledWith("literature", [item.actionRef, "opaque-two"], 1, expect.any(AbortSignal)));
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "清空选择" })); expect(clear).toHaveBeenCalledOnce();
    view.rerender(<EvimedSearchBatchActions category="guidelines" items={[item]} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows reauthentication instead of retrying a refused account action", async () => {
    api.collect.mockRejectedValueOnce(new WebApiError("Expired", { status: 401, code: "evimed_search_credential_expired" }));
    const user = userEvent.setup(); render(<EvimedSearchActions category="literature" item={item} />);
    await user.click(screen.getByRole("button", { name: "收藏" }));
    expect(await screen.findByRole("link", { name: "重新登录" })).toHaveAttribute("href", expect.stringContaining("/login?reauth=evimed"));
    expect(api.collect).toHaveBeenCalledOnce();
  });

  it("keeps batch export recovery outside the toolbar and restores the trigger on dismissal", async () => {
    api.export.mockRejectedValueOnce(new WebApiError("Expired", { status: 401, code: "evimed_search_credential_expired" }));
    const user = userEvent.setup();
    const view = render(<EvimedSearchBatchActions category="literature" items={[item]} />);
    const trigger = screen.getByRole("button", { name: "导出已选 1 篇" });
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "Excel" }));
    const dialog = await screen.findByRole("dialog", { name: "题录导出失败" });
    expect(view.container).not.toContainElement(dialog);
    expect(within(dialog).getByRole("link", { name: "重新登录" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "导出已选 1 篇" })).toBe(trigger);
  });

  it.each(["local", "other-tab"])("closes actions and cancels outstanding reads on a %s account change", async (source) => {
    const pending = deferred<typeof offer>(); api.offer.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup(); render(<EvimedSearchActions category="literature" item={item} />);
    await user.click(screen.getByRole("button", { name: "更多操作" }));
    await user.click(screen.getByRole("menuitem", { name: "原文下载" }));
    await waitFor(() => expect(api.offer).toHaveBeenCalledOnce());
    const signal = api.offer.mock.calls[0][2] as AbortSignal;
    act(() => window.dispatchEvent(source === "local" ? new Event(WEB_SESSION_ENDED_EVENT)
      : new StorageEvent("storage", { key: WEB_SESSION_SYNC_STORAGE_KEY, newValue: "changed" })));
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(offer));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "原文下载" })).not.toBeInTheDocument();
    expect(api.download).not.toHaveBeenCalled();
  });

  it("refreshes the search instead of replaying an expired action reference", async () => {
    api.collect.mockRejectedValueOnce(new WebApiError("Expired", { status: 403, code: "evimed_search_reference_invalid" }));
    const refresh = vi.fn(); const user = userEvent.setup(); render(<EvimedSearchActions category="literature" item={item} onRefresh={refresh} />);
    await user.click(screen.getByRole("button", { name: "收藏" }));
    await user.click(await screen.findByRole("button", { name: "重新检索" }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(api.collect).toHaveBeenCalledOnce();
  });
});
