import type { ReactNode } from "react";
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { FollowList, FollowingView, followAnswers, followChoiceParam, readFollowChoice, useFollowing, type FollowingState } from "./FollowingView";
import type { FollowChoice } from "./FrontierControls";

const client = vi.hoisted(() => ({ listFrontierFollows: vi.fn(), addFrontierFollow: vi.fn() }));
vi.mock("@/lib/frontierClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/frontierClient")>()), ...client }));
const zones = vi.hoisted(() => ({ listEvidenceZones: vi.fn(), listFollowedEvidence: vi.fn() }));
vi.mock("@/lib/evidenceZoneClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceZoneClient")>()), ...zones }));
const prefs = vi.hoisted(() => ({ fetchFrontierPrefs: vi.fn(), saveFrontierPrefs: vi.fn() }));
vi.mock("@/lib/frontierPrefs", () => prefs);

const topic = { id: "7", kind: "topic", key: "obesity", label: "肥胖研究", muted: false } as const;
const state = (overrides: Partial<FollowingState> = {}): FollowingState => ({ loading: false, error: null, topics: [], zones: [], cards: [], answered: true, retry: () => {}, ...overrides });
const zone = { id: "ez_1", title: "房颤抗凝", evidenceCount: 4 } as FollowingState["zones"][number];
const answer = { role: "physician", specialties: ["oncology"], interests: ["hcc"], interestTags: [{ slug: "hcc", name: "肝细胞癌" }], onboardedAt: "2026-10-25T00:00:00Z", skippedAt: null };

beforeEach(() => {
  client.listFrontierFollows.mockReset().mockResolvedValue([topic, { ...topic, id: "8", key: "x", label: "已屏蔽的", muted: true }]);
  client.addFrontierFollow.mockReset().mockImplementation(async (input: Record<string, unknown>) => ({ id: "new", muted: false, ...input }));
  zones.listEvidenceZones.mockReset().mockResolvedValue({ items: [zone], nextCursor: null });
  zones.listFollowedEvidence.mockReset().mockResolvedValue({ items: [], nextCursor: null });
  prefs.fetchFrontierPrefs.mockReset().mockResolvedValue({ ...answer });
  prefs.saveFrontierPrefs.mockReset().mockResolvedValue({ ...answer });
});

describe("the entry an address names", () => {
  it("is 与我相关 when it names none, and reads 全部关注, one follow and one zone back as it writes them", () => {
    expect(readFollowChoice(null)).toEqual({ kind: "foryou" });
    expect(readFollowChoice("foryou")).toEqual({ kind: "foryou" });
    for (const choice of [{ kind: "all" }, { kind: "follow", id: "7" }, { kind: "zone", id: "ez_1" }] as FollowChoice[]) {
      expect(readFollowChoice(followChoiceParam(choice))).toEqual(choice);
    }
  });
});

describe("the list of follows", () => {
  const href = (choice: FollowChoice) => `/app/frontier?view=following&follow=${followChoiceParam(choice)}`;
  const list = (current: FollowingState, choice: FollowChoice = { kind: "foryou" }, onManage = vi.fn(), onPick = vi.fn()) =>
    render(<MemoryRouter><FollowList state={current} choice={choice} hrefFor={href} onManage={onManage} onPick={onPick} /></MemoryRouter>);

  it("is 与我相关, 全部关注, then each follow under its kind and the zones, every entry an address, the open one current", () => {
    list(state({
      topics: [topic, { id: "9", kind: "tag", key: "hcc", label: "肝细胞癌", muted: false }, { id: "10", kind: "specialty", key: "oncology", label: "肿瘤", muted: false, newItems: 12 }],
      zones: [zone],
    }), { kind: "follow", id: "9" });
    const nav = screen.getByRole("navigation", { name: "我的关注" });
    expect(within(nav).getAllByRole("link").map((link) => link.textContent)).toEqual(["与我相关", "全部关注", "肿瘤12", "#肝细胞癌", "肥胖研究", "房颤抗凝"]);
    expect(within(nav).getByRole("link", { name: "#肝细胞癌" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "#肝细胞癌" })).toHaveAttribute("href", "/app/frontier?view=following&follow=9");
    expect(within(nav).getByRole("link", { name: "房颤抗凝" })).toHaveAttribute("href", "/app/frontier?view=following&follow=zone:ez_1");
    expect(within(nav).getByLabelText("12 条新动态")).toBeInTheDocument();
    expect(within(nav).getAllByRole("group").map((group) => group.getAttribute("aria-label"))).toEqual(["专科", "标签", "主题", "证据专区"]);
  });

  it("shows no number for a follow the server does not count, and opens 管理关注 from its foot", async () => {
    const onManage = vi.fn();
    const onPick = vi.fn();
    list(state({ topics: [topic] }), { kind: "foryou" }, onManage, onPick);
    expect(screen.getByRole("link", { name: "肥胖研究" }).textContent).toBe("肥胖研究");
    await userEvent.click(screen.getByRole("button", { name: "添加关注 · 管理" }));
    expect(onManage).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("link", { name: "全部关注" }));
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});

describe("the view", () => {
  const show = (current: FollowingState, choice: FollowChoice = { kind: "all" }, { onAdd = vi.fn(), onAnswered = vi.fn(), list = null as ReactNode } = {}) => render(
    <MemoryRouter>
      <FollowingView state={current} choice={choice} list={list} forYou={<p>与我相关的动态</p>} feed={<p>关注的动态</p>} onAdd={onAdd} onAnswered={onAnswered} />
    </MemoryRouter>,
  );

  it("is one sentence, one button and one link when nothing is followed and the reader answered the card", async () => {
    const onAdd = vi.fn();
    show(state(), { kind: "all" }, { onAdd });
    expect(screen.getByText("关注药物、主题、专科或证据专区，它们的新动态会汇总在这里。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "添加关注" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "浏览证据专区" })).toHaveAttribute("href", "/app/frontier?view=zones");
    expect(screen.queryByText("关注的动态")).not.toBeInTheDocument();
  });

  it("is the onboarding card when nothing is followed and the card was never answered, and hands its answer on", async () => {
    const onAnswered = vi.fn();
    show(state({ answered: false }), { kind: "all" }, { onAnswered });
    expect(screen.queryByRole("button", { name: "添加关注" })).toBeNull();
    expect(screen.getByRole("heading", { name: "你的角色" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "跳过" }));
    await waitFor(() => expect(onAnswered).toHaveBeenCalledWith(expect.objectContaining({ specialties: ["oncology"] })));
  });

  it("draws the zones group only when a zone is followed, and the feed only when a topic is", () => {
    const { unmount } = show(state({ zones: [zone] }));
    expect(screen.getByRole("region", { name: "关注的证据专区" })).toBeInTheDocument();
    expect(screen.queryByText("关注的动态")).not.toBeInTheDocument();
    unmount();
    show(state({ topics: [topic] }));
    expect(screen.queryByRole("region", { name: "关注的证据专区" })).not.toBeInTheDocument();
    expect(screen.getByText("关注的动态")).toBeInTheDocument();
  });

  it("opens 与我相关, one follow's feed and one zone's cards, and says so where the zone is no longer followed", () => {
    const { unmount } = show(state({ topics: [topic] }), { kind: "foryou" });
    expect(screen.getByText("与我相关的动态")).toBeInTheDocument();
    unmount();
    const second = show(state({ topics: [topic] }), { kind: "follow", id: "7" });
    expect(screen.getByText("关注的动态")).toBeInTheDocument();
    second.unmount();
    const third = show(state({ zones: [zone] }), { kind: "zone", id: "ez_1" });
    expect(screen.getByRole("region", { name: "关注的证据专区" })).toBeInTheDocument();
    third.unmount();
    show(state({ zones: [zone] }), { kind: "zone", id: "gone" });
    expect(screen.getByText("这个专区已不在关注里")).toBeInTheDocument();
  });

  it("puts the list in a column beside the entry when the page gives one", () => {
    show(state({ topics: [topic] }), { kind: "all" }, { list: <nav aria-label="我的关注" /> });
    const nav = screen.getByRole("navigation", { name: "我的关注" });
    expect(nav.parentElement).toHaveClass("sticky");
    expect(nav.compareDocumentPosition(screen.getByText("关注的动态")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is a skeleton while reading, and an error with 「重试」 where it could not read", async () => {
    const retry = vi.fn();
    const { container, unmount } = show(state({ loading: true }));
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    expect(screen.queryByText("添加关注")).not.toBeInTheDocument();
    unmount();
    show(state({ error: "暂时读不到。", retry }));
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe("the onboarding answer as the first follows", () => {
  it("follows each chosen specialty and tag that is not followed already", async () => {
    await followAnswers({ ...answer, specialties: ["oncology", "cardiology"] }, [{ id: "1", kind: "specialty", key: "cardiology", label: "心血管", muted: false }]);
    expect(client.addFrontierFollow.mock.calls.map(([input]) => input)).toEqual([
      { kind: "specialty", key: "oncology", label: "肿瘤" },
      { kind: "tag", key: "hcc", label: "肝细胞癌" },
    ]);
  });

  it("makes none for an answer that was let go of", async () => {
    await followAnswers(undefined, []);
    expect(client.addFrontierFollow).not.toHaveBeenCalled();
  });
});

describe("reading what the reader follows", () => {
  it("counts only the follows that bring items in, and the zones, once", async () => {
    const { result } = renderHook(() => useFollowing(true));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.topics.map((follow) => follow.label)).toEqual(["肥胖研究"]);
    expect(result.current.zones).toEqual([zone]);
    expect(result.current.answered).toBe(true);
  });

  it("knows a reader who never answered the card, and counts a server without the answer's route as answered", async () => {
    prefs.fetchFrontierPrefs.mockResolvedValue({ ...answer, onboardedAt: null, skippedAt: null });
    const { result, unmount } = renderHook(() => useFollowing(true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.answered).toBe(false);
    unmount();
    prefs.fetchFrontierPrefs.mockRejectedValue(new WebApiError("missing", { status: 404 }));
    const other = renderHook(() => useFollowing(true));
    await waitFor(() => expect(other.result.current.loading).toBe(false));
    expect(other.result.current.answered).toBe(true);
  });

  it("reads nothing while the view is not open, and again when a follow changes", async () => {
    const { result, rerender } = renderHook(({ on }) => useFollowing(on), { initialProps: { on: false } });
    expect(client.listFrontierFollows).not.toHaveBeenCalled();
    rerender({ on: true });
    await waitFor(() => expect(result.current.loading).toBe(false));
    client.listFrontierFollows.mockResolvedValue([]);
    await act(async () => { window.dispatchEvent(new Event("evimed:frontier-follows-changed")); });
    await waitFor(() => expect(result.current.topics).toEqual([]));
  });

  it("keeps the zones when the recent cards cannot be read, and says nothing is known when the follows cannot", async () => {
    zones.listFollowedEvidence.mockRejectedValue(new Error("offline"));
    const { result, unmount } = renderHook(() => useFollowing(true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.zones).toEqual([zone]);
    unmount();
    client.listFrontierFollows.mockRejectedValue(new WebApiError("down", { status: 502 }));
    const failed = renderHook(() => useFollowing(true));
    await waitFor(() => expect(failed.result.current.error).toBe("服务暂时不可用，请稍后重试。"));
    expect(failed.result.current.loading).toBe(false);
  });
});
