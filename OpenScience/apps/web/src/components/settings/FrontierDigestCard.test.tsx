import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { useToastStore } from "@/lib/toast";
import { Toaster } from "@/components/ui/Toaster";
import { FrontierDigestCard } from "./FrontierDigestCard";

const client = vi.hoisted(() => ({
  useFrontierFeature: vi.fn(),
  fetchFrontierDigestSwitch: vi.fn(),
  setFrontierDigestSwitch: vi.fn(),
}));
// Partial: the parsers stay real; the error words are the shared dictionary's.
vi.mock("@/lib/frontierClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/frontierClient")>()),
  ...client,
}));

function renderCard() {
  return render(<><FrontierDigestCard /><Toaster /></>);
}

describe("the daily's switch under 通知", () => {
  beforeEach(() => {
    Object.values(client).forEach((mock) => mock.mockReset());
    useToastStore.setState({ toasts: [] });
    client.useFrontierFeature.mockReturnValue("on");
    client.fetchFrontierDigestSwitch.mockResolvedValue(true);
  });

  it("is not there where the feed is not offered, and asks nothing", () => {
    client.useFrontierFeature.mockReturnValue("off");
    const { container } = renderCard();
    expect(container.textContent).toBe("");
    expect(client.fetchFrontierDigestSwitch).not.toHaveBeenCalled();
  });

  it("shows the switch as the inbox has it and says the push carries nothing personal", async () => {
    renderCard();
    expect(screen.getByText("前沿动态日报")).toBeInTheDocument();
    expect(screen.getByText("推送里只有当天的条数和头条，不含你的个人信息。")).toBeInTheDocument();
    const button = await screen.findByRole("button", { name: "已开启" });
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
  });

  it("turns the push off and on through the inbox preferences", async () => {
    client.setFrontierDigestSwitch.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    renderCard();
    await waitFor(() => expect(screen.getByRole("button", { name: "已开启" })).toHaveAttribute("aria-pressed", "true"));
    await userEvent.click(screen.getByRole("button", { name: "已开启" }));
    expect(client.setFrontierDigestSwitch).toHaveBeenCalledWith(false);
    expect(await screen.findByRole("button", { name: "已关闭" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("已关闭前沿日报的推送，前沿动态页面照常可看。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "已关闭" }));
    expect(client.setFrontierDigestSwitch).toHaveBeenLastCalledWith(true);
    expect(await screen.findByRole("button", { name: "已开启" })).toHaveAttribute("aria-pressed", "true");
  });

  it("says so when the preference cannot be read, and reads again on retry", async () => {
    client.fetchFrontierDigestSwitch.mockRejectedValueOnce(new WebApiError("down", { status: 503, code: null })).mockResolvedValueOnce(false);
    renderCard();
    expect(await screen.findByRole("alert")).toHaveTextContent("服务暂时不可用，请稍后重试。");
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("button", { name: "已关闭" })).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps the switch as it was when the write is refused", async () => {
    client.setFrontierDigestSwitch.mockRejectedValue(new WebApiError("conflict", { status: 409, code: "notification_revision_conflict" }));
    renderCard();
    await waitFor(() => expect(screen.getByRole("button", { name: "已开启" })).toHaveAttribute("aria-pressed", "true"));
    await userEvent.click(screen.getByRole("button", { name: "已开启" }));
    await waitFor(() => expect(useToastStore.getState().toasts.length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: "已开启" })).toHaveAttribute("aria-pressed", "true");
  });
});
