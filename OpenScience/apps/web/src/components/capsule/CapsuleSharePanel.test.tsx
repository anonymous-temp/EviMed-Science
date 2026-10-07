import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapsuleSharePanel, recipientsOf } from "./CapsuleSharePanel";

const client = vi.hoisted(() => ({
  createShareLink: vi.fn(), deliverCapsule: vi.fn(), downloadMethodPack: vi.fn(), listSentDeliveries: vi.fn(), listShareLinks: vi.fn(), revokeShareLink: vi.fn(),
}));
vi.mock("@/lib/capsuleShareClient", () => client);
vi.mock("@/lib/productClient", () => ({ productErrorMessage: (error: { message?: string }) => error?.message ?? "操作未完成，请重试。" }));

describe("分享给平台里的人", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.listSentDeliveries.mockResolvedValue([]);
    client.listShareLinks.mockResolvedValue([]);
  });
  afterEach(cleanup);

  it("reads names separated by commas or lines, each once, never more than thirty-two", () => {
    expect(recipientsOf("Alice Reader, Bob，Alice Reader\n\ncarol、dave")).toEqual(["Alice Reader", "Bob", "carol", "dave"]);
    expect(recipientsOf(Array.from({ length: 40 }, (_, index) => `u${index}`).join(","))).toHaveLength(32);
    expect(recipientsOf("  ,  ")).toEqual([]);
  });

  it("sends to the names typed and says how many arrived — the same words whatever kept the others", async () => {
    client.deliverCapsule.mockResolvedValue({ delivered: 1, notDelivered: 2, snapshot: null });
    render(<CapsuleSharePanel capsuleId="cap-1" />);
    const send = screen.getByRole("button", { name: "发送" });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByLabelText("发给平台内的账号"), "Alice Reader, nobody, 另一个人");
    await userEvent.click(send);
    await waitFor(() => expect(client.deliverCapsule).toHaveBeenCalledWith("cap-1", { recipients: ["Alice Reader", "nobody", "另一个人"] }));
    expect(await screen.findByText("已发给 1 位；其余 2 位没有送达（名字没有对上，或对方不能接收）。")).toBeInTheDocument();
  });

  it("says nothing arrived without saying why, and shows what an unsuccessful send said", async () => {
    client.deliverCapsule.mockResolvedValueOnce({ delivered: 0, notDelivered: 1, snapshot: null });
    render(<CapsuleSharePanel capsuleId="cap-1" />);
    await userEvent.type(screen.getByLabelText("发给平台内的账号"), "ghost");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText("没有送达任何人：名字没有对上，或对方现在不能接收。")).toBeInTheDocument();
    client.deliverCapsule.mockRejectedValueOnce(new Error("还没有可以分享的内容。"));
    await userEvent.type(screen.getByLabelText("发给平台内的账号"), "alice");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("还没有可以分享的内容。");
  });

  it("lists what became of each delivery, per recipient, in words", async () => {
    client.listSentDeliveries.mockResolvedValue([
      { id: "d1", state: "imported", createdAt: "2026-10-05T01:00:00Z", recipient: { name: "Alice Reader" } },
      { id: "d2", state: "declined", createdAt: "2026-10-05T01:00:00Z", recipient: { name: "Bob Reader" } },
      { id: "d3", state: "taken_down", createdAt: "2026-10-05T01:00:00Z", recipient: { name: "Carol Reader" } },
    ]);
    render(<CapsuleSharePanel capsuleId="cap-1" />);
    await userEvent.click(await screen.findByText("发出的分享 3 条"));
    expect(screen.getByText(/已收下/)).toBeInTheDocument();
    expect(screen.getByText(/已拒收/)).toBeInTheDocument();
    expect(screen.getByText(/已下架/)).toBeInTheDocument();
  });

  it("shows a new link once, lists links with their uses and expiry, and revokes one after asking", async () => {
    client.createShareLink.mockResolvedValue({ token: "t".repeat(32), path: `/app/memory/shared/${"t".repeat(32)}`, link: {}, snapshot: {} });
    client.listShareLinks.mockResolvedValue([
      { id: "l1", state: "active", uses: 2, maxUses: 20, importedCount: 1, expiresAt: "2026-11-04T00:00:00Z", createdAt: "2026-10-05T00:00:00Z", revokedAt: null },
      { id: "l2", state: "expired", uses: 5, maxUses: 20, importedCount: 0, expiresAt: "2026-09-01T00:00:00Z", createdAt: "2026-08-01T00:00:00Z", revokedAt: null },
    ]);
    client.revokeShareLink.mockResolvedValue({});
    render(<CapsuleSharePanel capsuleId="cap-1" />);
    await userEvent.click(screen.getByRole("button", { name: "创建分享链接" }));
    expect(await screen.findByText(new RegExp(`/app/memory/shared/${"t".repeat(32)}$`))).toBeInTheDocument();
    expect(screen.getByText("链接只显示这一次，请现在复制：")).toBeInTheDocument();
    await userEvent.click(await screen.findByText("分享链接 2 个"));
    expect(screen.getByText(/有效 · 已用 2 \/ 20 次 · 已收下 1 人/)).toBeInTheDocument();
    expect(screen.getByText(/已过期 · 已用 5 \/ 20 次/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "撤回" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "撤回" }));
    expect(client.revokeShareLink).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "撤回链接" }));
    await waitFor(() => expect(client.revokeShareLink).toHaveBeenCalledWith("cap-1", "l1"));
  });

  it("exports the method pack and says it holds text only", async () => {
    client.downloadMethodPack.mockResolvedValue(undefined);
    render(<CapsuleSharePanel capsuleId="cap-1" />);
    expect(screen.getByText("已学到的做法按通用的技能格式导出；脚本不会随它分享。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "导出做法" }));
    await waitFor(() => expect(client.downloadMethodPack).toHaveBeenCalledWith("cap-1"));
    expect(await screen.findByText(/只含文字/)).toBeInTheDocument();
  });

  it("does nothing without a capsule", () => {
    render(<CapsuleSharePanel capsuleId={null} />);
    expect(screen.getByRole("button", { name: "创建分享链接" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "导出做法" })).toBeDisabled();
    expect(client.listSentDeliveries).not.toHaveBeenCalled();
  });
});
