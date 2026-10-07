import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxItem } from "@/lib/inboxClient";
import { studyOfPath, useVcrFinishedToasts, vcrNoticeTarget } from "./useVcrFinishedToasts";

const inbox = vi.hoisted(() => ({
  fetchInboxUnreadCount: vi.fn(),
  listInbox: vi.fn(),
  markInboxRead: vi.fn(),
  announceInboxChanged: vi.fn(),
}));
vi.mock("@/lib/inboxClient", () => inbox);

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

const project = vi.hoisted(() => ({ currentId: "prj_ev201" }));
vi.mock("@/lib/projects", () => ({
  useProjectStore: (selector: (state: { currentId: string }) => unknown) => selector({ currentId: project.currentId }),
}));

function Harness({ enabled = true }: { enabled?: boolean }) {
  useVcrFinishedToasts(enabled);
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}

function draw(path: string, enabled = true) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<Harness enabled={enabled} />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** One notice as the inbox sends it: a 「虚拟临研」 source names `<studyId>/<tab>`. */
const notice = (id: string, source: string | null, extra: Partial<InboxItem> = {}): InboxItem => ({
  id, projectId: "prj_ev201", source: source ? { type: "vcr", id: source } : null, noticeType: "notify", priority: 0,
  title: `方案模拟完成：${id}`, body: "", actions: [], count: 1, readAt: null, resolvedAt: null, resolution: null, revision: 3,
  createdAt: "2026-10-07T10:00:00.000Z", ...extra,
});

/** The inbox as the reader's tab sees it: a count and the unread items behind it. */
function holdInbox(items: InboxItem[]) {
  inbox.fetchInboxUnreadCount.mockImplementation(async () => ({ unreadTotal: items.length, safetyUnread: 0 }));
  inbox.listInbox.mockImplementation(async () => ({ items, nextCursor: null }));
  return { set: (next: InboxItem[]) => { items = next; } };
}

const tick = async (ms = 20_000) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  vi.useFakeTimers();
  inbox.fetchInboxUnreadCount.mockReset();
  inbox.listInbox.mockReset();
  inbox.markInboxRead.mockReset();
  inbox.markInboxRead.mockResolvedValue({});
  inbox.announceInboxChanged.mockReset();
  toasts.success.mockReset();
  project.currentId = "prj_ev201";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});

afterEach(() => { vi.useRealTimers(); });

describe("the notice's address", () => {
  it("is the study and the tab its source names, and 总览 for a tab it does not know", () => {
    expect(vcrNoticeTarget(notice("a", "std_1/trial"))).toEqual({ studyId: "std_1", tab: "trial" });
    expect(vcrNoticeTarget(notice("b", "std_1/population/res_9"))).toEqual({ studyId: "std_1", tab: "population" });
    expect(vcrNoticeTarget(notice("c", "std_1"))).toEqual({ studyId: "std_1", tab: "overview" });
    expect(vcrNoticeTarget(notice("d", "std_1/nowhere"))).toEqual({ studyId: "std_1", tab: "overview" });
    expect(vcrNoticeTarget(notice("e", null))).toBeNull();
    expect(vcrNoticeTarget({ source: { type: "run", id: "std_1/trial" } })).toBeNull();
  });

  it("reads the study out of the page's address, and nothing out of another", () => {
    expect(studyOfPath("/app/virtual-research/std_1")).toBe("std_1");
    expect(studyOfPath("/app/virtual-research/std_1/trial")).toBe("std_1");
    expect(studyOfPath("/app/virtual-research")).toBeNull();
    expect(studyOfPath("/app/chat")).toBeNull();
  });
});

describe("a finished computation, said where the reader is looking", () => {
  it("toasts a new notice for the study on screen, with 查看结果 that opens the tab and marks it read", async () => {
    const held = holdInbox([]);
    draw("/app/virtual-research/std_1/population");
    await tick(0);
    held.set([notice("n1", "std_1/trial")]);
    await tick();
    expect(toasts.success).toHaveBeenCalledTimes(1);
    expect(toasts.success.mock.calls[0][0]).toBe("方案模拟完成：n1");
    const action = toasts.success.mock.calls[0][1].action;
    expect(action.label).toBe("查看结果");
    act(() => action.onClick());
    expect(screen.getByTestId("where")).toHaveTextContent("/app/virtual-research/std_1/trial");
    expect(inbox.markInboxRead).toHaveBeenCalledWith("n1", 3);
  });

  it("says nothing of what was already unread when the reader arrived — that is the inbox's", async () => {
    holdInbox([notice("old", "std_1/trial")]);
    draw("/app/virtual-research/std_1");
    await tick(0);
    await tick();
    await tick();
    expect(toasts.success).not.toHaveBeenCalled();
    expect(inbox.listInbox).toHaveBeenCalledTimes(1);
  });

  it("toasts a notice once, however long it stays unread", async () => {
    const held = holdInbox([]);
    draw("/app/virtual-research/std_1");
    await tick(0);
    held.set([notice("n1", "std_1/trial")]);
    await tick();
    await tick();
    held.set([notice("n1", "std_1/trial"), notice("n2", "std_1/population")]);
    await tick();
    expect(toasts.success.mock.calls.map((call) => call[0])).toEqual(["方案模拟完成：n1", "方案模拟完成：n2"]);
  });

  it("does not toast another study's notice, or one that is not 虚拟临研's", async () => {
    const held = holdInbox([]);
    draw("/app/virtual-research/std_1");
    await tick(0);
    held.set([notice("other", "std_2/trial", { projectId: "prj_other" }), { ...notice("run", null), source: { type: "run", id: "std_1/trial" } }]);
    await tick();
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("toasts in the study's conversation too: the notice's project is the one the shell is in", async () => {
    const held = holdInbox([]);
    draw("/app/chat");
    await tick(0);
    held.set([notice("n1", "std_1/trial"), notice("elsewhere", "std_2/trial", { projectId: "prj_other" })]);
    await tick();
    expect(toasts.success.mock.calls.map((call) => call[0])).toEqual(["方案模拟完成：n1"]);
  });

  it("costs nothing on a page that is not a study's, and nothing while the tab is hidden or the module is off", async () => {
    holdInbox([]);
    const { unmount } = draw("/app/files");
    await tick();
    await tick();
    expect(inbox.fetchInboxUnreadCount).not.toHaveBeenCalled();
    unmount();

    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    const hidden = draw("/app/virtual-research/std_1");
    await tick();
    expect(inbox.fetchInboxUnreadCount).not.toHaveBeenCalled();
    hidden.unmount();

    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    draw("/app/virtual-research/std_1", false);
    await tick();
    expect(inbox.fetchInboxUnreadCount).not.toHaveBeenCalled();
  });

  it("reads the notices only when the count moved: a count is two integers, a list is fifty notices", async () => {
    holdInbox([notice("a", "std_1/trial")]);
    draw("/app/virtual-research/std_1");
    await tick(0);
    await tick();
    await tick();
    await tick();
    expect(inbox.fetchInboxUnreadCount.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(inbox.listInbox).toHaveBeenCalledTimes(1);
  });

  it("keeps quiet when the inbox cannot be read, and tries again next time", async () => {
    inbox.fetchInboxUnreadCount.mockRejectedValue(new Error("down"));
    draw("/app/virtual-research/std_1");
    await tick(0);
    await tick();
    expect(toasts.success).not.toHaveBeenCalled();
    holdInbox([]);
    await tick();
    expect(inbox.fetchInboxUnreadCount).toHaveBeenCalledTimes(3);
  });
});
