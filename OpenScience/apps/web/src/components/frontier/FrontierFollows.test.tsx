import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { FrontierFollows } from "./FrontierFollows";
const client = vi.hoisted(() => ({ listFrontierFollows: vi.fn(), addFrontierFollow: vi.fn(), removeFrontierFollow: vi.fn() }));
vi.mock("@/lib/frontierClient", async (original) => ({ ...await original<typeof import("@/lib/frontierClient")>(), ...client }));
const followed = { id: "7", kind: "topic", key: "obesity", label: "肥胖研究", muted: false };
beforeEach(() => { vi.clearAllMocks(); client.listFrontierFollows.mockResolvedValue([followed]); client.addFrontierFollow.mockResolvedValue(followed); client.removeFrontierFollow.mockResolvedValue(undefined); });
it("selects an owned follow and creates a reader's topic only on explicit submission", async () => {
  const select = vi.fn(), change = vi.fn();
  render(<FrontierFollows selected={null} onSelect={select} onChanged={change} />);
  fireEvent.click(await screen.findByRole("button", { name: "肥胖研究" }));
  expect(select).toHaveBeenCalledWith("7");
  fireEvent.change(screen.getByLabelText("关注内容"), { target: { value: "心衰研究" } });
  expect(client.addFrontierFollow).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "添加关注" }));
  await waitFor(() => expect(client.addFrontierFollow).toHaveBeenCalledWith({ kind: "topic", key: "心衰研究", label: "心衰研究" }));
  expect(change).toHaveBeenCalled();
});
it("muting preserves identity and removes the selected filter", async () => {
  const select = vi.fn();
  render(<FrontierFollows selected="7" onSelect={select} onChanged={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "屏蔽 肥胖研究" }));
  await waitFor(() => expect(client.addFrontierFollow).toHaveBeenCalledWith({ kind: "topic", key: "obesity", label: "肥胖研究", muted: true }));
  expect(select).toHaveBeenCalledWith(null);
});
it("keeps a failed request visible with retry rather than showing an empty subscription list", async () => {
  client.listFrontierFollows.mockRejectedValueOnce(new Error("unavailable"));
  render(<FrontierFollows selected={null} onSelect={vi.fn()} onChanged={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "重试" }));
  expect(await screen.findByRole("button", { name: "肥胖研究" })).toBeInTheDocument();
});
