import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FrontierForYou } from "@/lib/frontierClient";
import { frontierItem } from "./__fixtures__/frontierItems";
import { ForYouView, topicRuns } from "./ForYouView";
import { FrontierOnboarding, FrontierPrefsRow } from "./FrontierOnboarding";

const prefs = vi.hoisted(() => ({ fetchFrontierPrefs: vi.fn(), saveFrontierPrefs: vi.fn() }));
const tracking = vi.hoisted(() => ({ trackFrontierOnboarding: vi.fn() }));
const client = vi.hoisted(() => ({ listFrontierTags: vi.fn() }));
vi.mock("@/lib/frontierPrefs", () => prefs);
vi.mock("@/lib/frontierTracking", async (original) => ({ ...await original<typeof import("@/lib/frontierTracking")>(), ...tracking }));
vi.mock("@/lib/frontierClient", async (original) => ({ ...await original<typeof import("@/lib/frontierClient")>(), ...client }));

const EMPTY = { role: null, specialties: [], interests: [], interestTags: [], onboardedAt: null, skippedAt: null };
beforeEach(() => {
  vi.clearAllMocks();
  prefs.saveFrontierPrefs.mockResolvedValue({ ...EMPTY, onboardedAt: "2026-10-24T08:00:00Z" });
  prefs.fetchFrontierPrefs.mockResolvedValue(EMPTY);
  client.listFrontierTags.mockResolvedValue([{ slug: "sglt2", name: "SGLT2 抑制剂", count: 9, specialties: ["cardiology"] }, { slug: "hf", name: "心力衰竭", count: 7, specialties: ["cardiology"] }]);
});

describe("the onboarding card", () => {
  it("asks role, then one to three specialties, then a few tags of those specialties, and saves the answer as finished", async () => {
    const close = vi.fn();
    render(<FrontierOnboarding onClose={close} />);
    expect(tracking.trackFrontierOnboarding).toHaveBeenCalledWith("onboarding-shown");
    expect(screen.getByRole("heading", { name: "你的角色" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "跳过" })).toBeInTheDocument();
    const next = screen.getByRole("button", { name: "下一步" });
    expect(next).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "药师" }));
    expect(screen.getByRole("button", { name: "药师" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(next);
    expect(screen.getByRole("heading", { name: "你的专科" })).toBeInTheDocument();
    for (const name of ["心血管", "肿瘤", "内分泌代谢"]) fireEvent.click(screen.getByRole("button", { name }));
    expect(screen.getByRole("button", { name: "呼吸" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(await screen.findByRole("button", { name: "#SGLT2 抑制剂" })).toBeInTheDocument();
    expect(client.listFrontierTags).toHaveBeenCalledWith(expect.objectContaining({ specialties: ["cardiology", "oncology", "endocrinology"] }));
    fireEvent.click(screen.getByRole("button", { name: "#SGLT2 抑制剂" }));
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    // The answer as the server keeps it goes with the close: the page makes the first follows of it.
    await waitFor(() => expect(close).toHaveBeenCalledWith(true, expect.objectContaining({ onboardedAt: "2026-10-24T08:00:00Z" })));
    expect(prefs.saveFrontierPrefs).toHaveBeenCalledWith({ role: "pharmacist", specialties: ["cardiology", "oncology", "endocrinology"], interests: ["sglt2"], done: true });
    expect(tracking.trackFrontierOnboarding).toHaveBeenCalledWith("onboarding-done", undefined);
  });

  it("跳过 is there at every step and keeps what was chosen before it; a failed save keeps the card", async () => {
    const close = vi.fn();
    render(<FrontierOnboarding onClose={close} />);
    fireEvent.click(screen.getByRole("button", { name: "科研人员" }));
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    prefs.saveFrontierPrefs.mockRejectedValueOnce(new Error("down"));
    fireEvent.click(screen.getByRole("button", { name: "跳过" }));
    await waitFor(() => expect(prefs.saveFrontierPrefs).toHaveBeenCalledTimes(1));
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "跳过" }));
    await waitFor(() => expect(close).toHaveBeenCalledWith(true, expect.anything()));
    expect(prefs.saveFrontierPrefs).toHaveBeenLastCalledWith({ role: "researcher", skipped: true });
    expect(tracking.trackFrontierOnboarding).toHaveBeenCalledWith("onboarding-skipped", "specialties");
  });

  it("edited later from 管理关注: the answer so far, 取消 instead of 跳过, and none of it counted as onboarding", async () => {
    prefs.fetchFrontierPrefs.mockResolvedValue({ ...EMPTY, role: "clinician", specialties: ["cardiology"], interests: ["hf"], interestTags: [{ slug: "hf", name: "心力衰竭" }],
      onboardedAt: "2026-10-20T08:00:00Z" });
    render(<FrontierPrefsRow />);
    expect(await screen.findByText("临床医生 · 心血管 · 1 个标签")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "修改" }));
    expect(screen.queryByRole("button", { name: "跳过" })).toBeNull();
    expect(screen.getByRole("button", { name: "临床医生" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(await screen.findByRole("button", { name: "#心力衰竭" })).toHaveAttribute("aria-pressed", "true");
    const changed = vi.fn();
    window.addEventListener("evimed:frontier-follows-changed", changed);
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    window.removeEventListener("evimed:frontier-follows-changed", changed);
    expect(tracking.trackFrontierOnboarding).not.toHaveBeenCalled();
  });

  it("specialties with no tag in use yet: finishing is the one thing left", async () => {
    client.listFrontierTags.mockResolvedValue([]);
    render(<FrontierOnboarding onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "其他" }));
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.click(screen.getByRole("button", { name: "罕见病" }));
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(await screen.findByText("这些专科还没有常用标签")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "完成" })).toHaveLength(1);
  });
});

describe("与我相关", () => {
  const answer = (overrides: Partial<FrontierForYou> = {}): FrontierForYou => ({
    state: "available", basis: null, paused: false, listId: "0f8fad5b-d9cb-469f-a165-70867728950e", onboarding: false,
    items: [
      { item: frontierItem({ id: "aaaaaaaaaaaa", title: "Recall" }), reason: { text: "安全警示", topic: "安全警示", memoryId: null }, slot: "must-see" },
      { item: frontierItem({ id: "bbbbbbbbbbbb", title: "Trial" }), reason: { text: "因为你关注：心血管", topic: "心血管", memoryId: null }, slot: "personal" },
      { item: frontierItem({ id: "cccccccccccc", title: "Other" }), reason: { text: "其他领域精选", topic: "其他领域精选", memoryId: null }, slot: "explore" },
      { item: frontierItem({ id: "dddddddddddd", title: "Trial 2" }), reason: { text: "因为你关注：心血管", topic: "心血管", memoryId: null }, slot: "personal" },
    ],
    ...overrides,
  });

  it("shows the entries in the order served, a heading wherever the topic changes, inside the list container the tracking reads", () => {
    const { container } = render(<ForYouView state={{ kind: "ready", forYou: answer() }} renderItem={(item) => <li key={item.id}>{item.title}</li>} onRetry={vi.fn()} />);
    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["安全警示", "心血管", "其他领域精选", "心血管"]);
    const list = container.querySelector("[data-frontier-list='for-you']");
    expect(list?.getAttribute("data-frontier-list-id")).toBe("0f8fad5b-d9cb-469f-a165-70867728950e");
    expect(screen.queryByRole("heading", { name: "你的角色" })).toBeNull();
    expect(topicRuns(answer()).map((run) => run.items.length)).toEqual([1, 1, 1, 1]);
  });

  it("puts the onboarding card above the entries while the server asks for it, and reads the block again once it is done", async () => {
    const reload = vi.fn();
    render(<ForYouView state={{ kind: "ready", forYou: answer({ onboarding: true }) }} renderItem={(item) => <li key={item.id}>{item.title}</li>}
      onRetry={vi.fn()} onOnboarded={reload} />);
    const card = screen.getByRole("heading", { name: "你的角色" });
    expect(card.compareDocumentPosition(screen.getByText("Recall")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "跳过" })); });
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });
});
