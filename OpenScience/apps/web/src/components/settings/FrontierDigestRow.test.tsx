import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import type { FrontierFeature } from "@/lib/frontierClient";
import { useToastStore } from "@/lib/toast";
import { Toaster } from "@/components/ui/Toaster";
import { FrontierDigestRow } from "./FrontierDigestRow";

const client = vi.hoisted(() => ({
  fetchFrontierDigestSwitch: vi.fn(),
  setFrontierDigestSwitch: vi.fn(),
}));
// Partial: the parsers stay real; the error words are the shared dictionary's.
vi.mock("@/lib/frontierClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/frontierClient")>()),
  ...client,
}));

function renderRow(feature: FrontierFeature = "on") {
  return render(<><FrontierDigestRow feature={feature} /><Toaster /></>);
}

describe("the daily's switch under 通知", () => {
  beforeEach(() => {
    Object.values(client).forEach((mock) => mock.mockReset());
    useToastStore.setState({ toasts: [] });
    client.fetchFrontierDigestSwitch.mockResolvedValue(true);
  });

  it("is not there where the feed is not offered, and asks nothing", () => {
    const { container } = renderRow("off");
    expect(container.textContent).toBe("");
    expect(client.fetchFrontierDigestSwitch).not.toHaveBeenCalled();
  });

  it("is one row with a switch, and no sentence about what the push carries", async () => {
    renderRow();
    expect(screen.getByText("前沿日报")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("switch", { name: "前沿日报" })).toHaveAttribute("aria-checked", "true"));
    expect(screen.queryByText(/不含你的个人信息|只推给近两周/)).not.toBeInTheDocument();
  });

  it("turns the push off and on through the inbox preferences", async () => {
    client.setFrontierDigestSwitch.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    renderRow();
    const toggle = await screen.findByRole("switch", { name: "前沿日报" });
    await waitFor(() => expect(toggle).toBeEnabled());
    await userEvent.click(toggle);
    expect(client.setFrontierDigestSwitch).toHaveBeenCalledWith(false);
    await waitFor(() => expect(screen.getByRole("switch", { name: "前沿日报" })).toHaveAttribute("aria-checked", "false"));
    expect(screen.getByText("已关闭前沿日报推送")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch", { name: "前沿日报" }));
    expect(client.setFrontierDigestSwitch).toHaveBeenLastCalledWith(true);
    await waitFor(() => expect(screen.getByRole("switch", { name: "前沿日报" })).toHaveAttribute("aria-checked", "true"));
  });

  it("says so when the preference cannot be read, and reads again on retry", async () => {
    client.fetchFrontierDigestSwitch.mockRejectedValueOnce(new WebApiError("down", { status: 503, code: null })).mockResolvedValueOnce(false);
    renderRow();
    expect(await screen.findByRole("alert")).toHaveTextContent("服务暂时不可用，请稍后重试。");
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "前沿日报" })).toHaveAttribute("aria-checked", "false"));
  });

  it("keeps the switch as it was when the write is refused", async () => {
    client.setFrontierDigestSwitch.mockRejectedValue(new WebApiError("conflict", { status: 409, code: "notification_revision_conflict" }));
    renderRow();
    const toggle = await screen.findByRole("switch", { name: "前沿日报" });
    await waitFor(() => expect(toggle).toBeEnabled());
    await userEvent.click(toggle);
    await waitFor(() => expect(useToastStore.getState().toasts.length).toBeGreaterThan(0));
    expect(screen.getByRole("switch", { name: "前沿日报" })).toHaveAttribute("aria-checked", "true");
  });
});
