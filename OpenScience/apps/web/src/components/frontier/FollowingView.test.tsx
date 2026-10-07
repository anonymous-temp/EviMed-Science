import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { FollowingView, followControls, useFollowing, type FollowingState } from "./FollowingView";

const client = vi.hoisted(() => ({ listFrontierFollows: vi.fn() }));
vi.mock("@/lib/frontierClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/frontierClient")>()), ...client }));
const zones = vi.hoisted(() => ({ listEvidenceZones: vi.fn(), listFollowedEvidence: vi.fn() }));
vi.mock("@/lib/evidenceZoneClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceZoneClient")>()), ...zones }));

const topic = { id: "7", kind: "topic", key: "obesity", label: "肥胖研究", muted: false } as const;
const state = (overrides: Partial<FollowingState> = {}): FollowingState => ({ loading: false, error: null, topics: [], zones: [], cards: [], retry: () => {}, ...overrides });
const zone = { id: "ez_1", title: "房颤抗凝", evidenceCount: 4 } as FollowingState["zones"][number];

beforeEach(() => {
  client.listFrontierFollows.mockReset().mockResolvedValue([topic, { ...topic, id: "8", key: "x", label: "已屏蔽的", muted: true }]);
  zones.listEvidenceZones.mockReset().mockResolvedValue({ items: [zone], nextCursor: null });
  zones.listFollowedEvidence.mockReset().mockResolvedValue({ items: [], nextCursor: null });
});

describe("which controls the view has something to offer", () => {
  it("is the filters with a topic, the way to add with only zones, and nothing with nothing or a failed read", () => {
    expect(followControls(state({ topics: [topic] }))).toBe("full");
    expect(followControls(state({ topics: [topic], zones: [zone] }))).toBe("full");
    expect(followControls(state({ zones: [zone] }))).toBe("manage");
    expect(followControls(state())).toBe("none");
    expect(followControls(state({ error: "读不到", topics: [topic] }))).toBe("none");
  });
});

describe("the view", () => {
  const show = (current: FollowingState, onAdd = vi.fn()) => render(<MemoryRouter><FollowingView state={current} feed={<p>关注的动态</p>} onAdd={onAdd} /></MemoryRouter>);

  it("is one sentence, one button and one link when nothing is followed", async () => {
    const onAdd = vi.fn();
    show(state(), onAdd);
    expect(screen.getByText("关注药物、主题、专科或证据专区，它们的新动态会汇总在这里。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "添加关注" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "浏览证据专区" })).toHaveAttribute("href", "/app/frontier/zones");
    expect(screen.queryByText("关注的动态")).not.toBeInTheDocument();
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

describe("reading what the reader follows", () => {
  it("counts only the follows that bring items in, and the zones, once", async () => {
    const { result } = renderHook(() => useFollowing(true));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.topics.map((follow) => follow.label)).toEqual(["肥胖研究"]);
    expect(result.current.zones).toEqual([zone]);
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
