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
  fetchFrontierNotificationSwitch: vi.fn(),
  setFrontierNotificationSwitch: vi.fn(),
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

  it("says where the notice is delivered when it is told, and a read that failed says so in its place", async () => {
    client.fetchFrontierDigestSwitch.mockRejectedValueOnce(new WebApiError("down", { status: 503, code: null }));
    render(<FrontierDigestRow feature="on" description="每天的医学前沿日报，发到收件箱" />);
    expect(screen.getByText("每天的医学前沿日报，发到收件箱")).toBeInTheDocument();
    expect(await screen.findByText("服务暂时不可用，请稍后重试。")).toBeInTheDocument();
    expect(screen.queryByText("每天的医学前沿日报，发到收件箱")).not.toBeInTheDocument();
  });

  it("turns the push off and on through the inbox preferences", async () => {
    client.setFrontierDigestSwitch.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    client.fetchFrontierDigestSwitch.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValue(true);
    renderRow();
    const toggle = await screen.findByRole("switch", { name: "前沿日报" });
    await waitFor(() => expect(toggle).toBeEnabled());
    await userEvent.click(toggle);
    expect(client.setFrontierDigestSwitch).toHaveBeenCalledWith(false);
    await waitFor(() => expect(screen.getByRole("switch", { name: "前沿日报" })).toHaveAttribute("aria-checked", "false"));
    // The visible toast, whatever the polite announcer (which repeats it a moment later) holds by then.
    expect(screen.getAllByText("已关闭前沿日报推送").some((element) => !element.closest("[data-announcer]"))).toBe(true);
    await userEvent.click(screen.getByRole("switch", { name: "前沿日报" }));
    expect(client.setFrontierDigestSwitch).toHaveBeenLastCalledWith(true);
    await waitFor(() => expect(screen.getByRole("switch", { name: "前沿日报" })).toHaveAttribute("aria-checked", "true"));
  });

  it("says so when the preference cannot be read, and reads again on retry", async () => {
    client.fetchFrontierDigestSwitch.mockRejectedValueOnce(new WebApiError("down", { status: 503, code: null })).mockResolvedValueOnce(false);
    renderRow();
    expect(await screen.findByText("服务暂时不可用，请稍后重试。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "前沿日报" })).toHaveAttribute("aria-checked", "false"));
  });

  it("keeps the switch as it was when the write is refused", async () => {
    client.setFrontierDigestSwitch.mockRejectedValue(new WebApiError("conflict", { status: 409, code: "notification_revision_conflict" }));
    renderRow();
    const toggle = await screen.findByRole("switch", { name: "前沿日报" });
    await waitFor(() => expect(toggle).toBeEnabled());
    await userEvent.click(toggle);
    // The refusal is said once, in the switch's own line — not also as a toast.
    await waitFor(() => expect(screen.getByRole("switch", { name: "前沿日报" })).toHaveAccessibleDescription(/\S/));
    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(screen.getByRole("switch", { name: "前沿日报" })).toHaveAttribute("aria-checked", "true");
  });

  it("settles on the write's answer without reading the switch again", async () => {
    client.setFrontierDigestSwitch.mockResolvedValue(false);
    renderRow();
    const toggle = await screen.findByRole("switch", { name: "前沿日报" });
    await waitFor(() => expect(toggle).toBeEnabled());
    const reads = client.fetchFrontierDigestSwitch.mock.calls.length;
    await userEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole("switch", { name: "前沿日报" })).toHaveAttribute("aria-checked", "false"));
    expect(client.fetchFrontierDigestSwitch).toHaveBeenCalledTimes(reads);
  });
});

it("the weekly control saves only its named switch", async () => {
  client.fetchFrontierNotificationSwitch.mockResolvedValueOnce(false).mockResolvedValue(true); client.setFrontierNotificationSwitch.mockResolvedValue(true);
  render(<FrontierDigestRow feature="on" switchKey="frontierWeekly" label="前沿周刊" />);
  const control = screen.getByRole("switch", { name: "前沿周刊" }); await waitFor(() => expect(control).toBeEnabled());
  await userEvent.click(control); expect(client.setFrontierNotificationSwitch).toHaveBeenCalledWith("frontierWeekly", true);
  await waitFor(() => expect(control).toHaveAttribute("aria-checked", "true"));
});

it("preserves focus and locks a timed-out write until the explicit preference readback", async () => {
  Object.values(client).forEach(mock => mock.mockReset());
  client.fetchFrontierDigestSwitch.mockResolvedValue(true);
  let reject!: (error: unknown) => void;
  client.setFrontierDigestSwitch.mockImplementation(() => new Promise((_, no) => { reject = no; }));
  renderRow();
  const toggle = await screen.findByRole("switch", { name: "前沿日报" });
  await waitFor(() => expect(toggle).toBeEnabled());
  toggle.focus(); await userEvent.click(toggle); await userEvent.click(toggle);
  expect(toggle).toHaveFocus(); expect(toggle).not.toBeDisabled();
  expect(client.setFrontierDigestSwitch).toHaveBeenCalledOnce();
  reject(new Error("timeout"));
  const refresh = await screen.findByRole("button", { name: "刷新核对状态" });
  await userEvent.click(toggle); expect(client.setFrontierDigestSwitch).toHaveBeenCalledOnce();
  await userEvent.click(refresh);
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
});
