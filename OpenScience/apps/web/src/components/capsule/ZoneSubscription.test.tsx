import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZoneSubscription } from "./ZoneSubscription";

const client = vi.hoisted(() => ({ subscribeZone: vi.fn(), unsubscribeZone: vi.fn(), zoneSubscriptionStatus: vi.fn() }));
vi.mock("@/lib/capsuleShareClient", () => client);
vi.mock("@/lib/productClient", () => ({ productErrorMessage: (error: { message?: string }) => error?.message ?? "操作未完成，请重试。" }));
vi.mock("@/lib/projects", () => {
  const state = { currentId: "project-a", projects: [{ id: "project-a", name: "房颤研究" }] };
  return { useProjectStore: (select: (value: typeof state) => unknown) => select(state) };
});

const active = { zoneId: "ez_1", projectId: "project-a", subscribedAt: "", title: "房颤抗凝", kind: "official", cards: 4, status: "active", reason: null, message: null };

describe("订阅到当前项目", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(cleanup);

  it("subscribes the project the shell is in", async () => {
    client.zoneSubscriptionStatus.mockResolvedValue({ subscribed: false, subscription: null });
    client.subscribeZone.mockResolvedValue(active);
    render(<ZoneSubscription zoneId="ez_1" />);
    await userEvent.click(await screen.findByRole("button", { name: "订阅到当前项目" }));
    await waitFor(() => expect(client.subscribeZone).toHaveBeenCalledWith("project-a", "ez_1"));
    expect(await screen.findByText(/已订阅到“房颤研究”：这个项目的对话会把专区里的卡片当作线索，引用时只引用原始来源。/)).toBeInTheDocument();
  });

  it("unsubscribing is one click and takes effect at once", async () => {
    client.zoneSubscriptionStatus.mockResolvedValue({ subscribed: true, subscription: active });
    client.unsubscribeZone.mockResolvedValue({ unsubscribed: true });
    render(<ZoneSubscription zoneId="ez_1" />);
    await userEvent.click(await screen.findByRole("button", { name: "取消订阅" }));
    await waitFor(() => expect(client.unsubscribeZone).toHaveBeenCalledWith("project-a", "ez_1"));
    expect(await screen.findByRole("button", { name: "订阅到当前项目" })).toBeInTheDocument();
  });

  it("a zone that was unpublished or deleted says so, and can still be unsubscribed", async () => {
    client.zoneSubscriptionStatus.mockResolvedValue({ subscribed: true, subscription: { ...active, status: "unavailable", reason: "deleted", message: "这个证据专区已经删除，订阅里不再有内容。" } });
    render(<ZoneSubscription zoneId="ez_1" />);
    expect(await screen.findByText(/这个证据专区已经删除，订阅里不再有内容。/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消订阅" })).toBeInTheDocument();
  });

  it("renders nothing where the module is off", async () => {
    client.zoneSubscriptionStatus.mockRejectedValue(Object.assign(new Error("off"), { code: "evidence_zone_subscription_not_enabled" }));
    const { container } = render(<ZoneSubscription zoneId="ez_1" />);
    await waitFor(() => expect(client.zoneSubscriptionStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("says why a subscription was refused", async () => {
    client.zoneSubscriptionStatus.mockResolvedValue({ subscribed: false, subscription: null });
    client.subscribeZone.mockRejectedValue(new Error("这个项目订阅的证据专区已经够多了，先取消不用的再订阅。"));
    render(<ZoneSubscription zoneId="ez_1" />);
    await userEvent.click(await screen.findByRole("button", { name: "订阅到当前项目" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("已经够多了");
  });
});
