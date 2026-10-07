import { act, fireEvent, render as renderBare, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { FrontierFollows } from "./FrontierFollows";

// The drawer links to the zones page, so it lives in a router.
const render = (ui: ReactElement) => {
  const view = renderBare(<MemoryRouter>{ui}</MemoryRouter>);
  return { ...view, rerender: (next: ReactElement) => view.rerender(<MemoryRouter>{next}</MemoryRouter>) };
};
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

it("refreshes its rows after a card changes a follow outside this manager", async () => {
  render(<FrontierFollows selected={null} onSelect={vi.fn()} onChanged={vi.fn()} />);
  await screen.findByRole("button", { name: "肥胖研究" });
  client.listFrontierFollows.mockResolvedValue([{ ...followed, muted: true }]);
  await act(async () => { window.dispatchEvent(new Event("evimed:frontier-follows-changed")); });
  expect(await screen.findByRole("button", { name: "取消屏蔽 肥胖研究" })).toBeInTheDocument();
});

it("preserves a newer selection when an earlier mute finishes late", async () => {
  let finish!: (value: typeof followed) => void;
  client.addFrontierFollow.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const select = vi.fn(), change = vi.fn();
  const { rerender } = render(<FrontierFollows selected="7" onSelect={select} onChanged={change} />);
  fireEvent.click(await screen.findByRole("button", { name: "屏蔽 肥胖研究" }));
  rerender(<FrontierFollows selected="8" onSelect={select} onChanged={change} />);
  await act(async () => { finish({ ...followed, muted: true }); });
  await waitFor(() => expect(change).toHaveBeenCalled());
  expect(select).not.toHaveBeenCalledWith(null);
});

it("gives each kind its example, and a specialty its list", async () => {
  render(<FrontierFollows selected={null} onSelect={vi.fn()} onChanged={vi.fn()} />);
  await screen.findByRole("button", { name: "肥胖研究" });
  expect(screen.getByLabelText("关注内容")).toHaveAttribute("placeholder", "例如：房颤抗凝");
  fireEvent.change(screen.getByLabelText("关注类型"), { target: { value: "drug" } });
  expect(screen.getByLabelText("关注内容")).toHaveAttribute("placeholder", "例如：司美格鲁肽");
  fireEvent.change(screen.getByLabelText("关注类型"), { target: { value: "specialty" } });
  expect(screen.queryByLabelText("关注内容")).not.toBeInTheDocument();
  expect(screen.getByLabelText("关注专科").tagName).toBe("SELECT");
});

it("says 「已经关注了」 and makes no request when the follow is already held, whatever its case", async () => {
  render(<FrontierFollows selected={null} onSelect={vi.fn()} onChanged={vi.fn()} />);
  await screen.findByRole("button", { name: "肥胖研究" });
  fireEvent.change(screen.getByLabelText("关注内容"), { target: { value: "OBESITY" } });
  fireEvent.click(screen.getByRole("button", { name: "添加关注" }));
  expect(await screen.findByText("已经关注了“肥胖研究”")).toBeInTheDocument();
  expect(client.addFrontierFollow).not.toHaveBeenCalled();
  // Typing something else takes the message away; a muted follow is turned back on by adding it.
  fireEvent.change(screen.getByLabelText("关注内容"), { target: { value: "心衰" } });
  expect(screen.queryByText(/已经关注了/)).not.toBeInTheDocument();
});

it("turns a muted follow back on when it is added again", async () => {
  client.listFrontierFollows.mockResolvedValue([{ ...followed, muted: true }]);
  render(<FrontierFollows selected={null} onSelect={vi.fn()} onChanged={vi.fn()} />);
  await screen.findByRole("button", { name: "肥胖研究" });
  fireEvent.change(screen.getByLabelText("关注内容"), { target: { value: "obesity" } });
  fireEvent.click(screen.getByRole("button", { name: "添加关注" }));
  await waitFor(() => expect(client.addFrontierFollow).toHaveBeenCalledWith({ kind: "topic", key: "obesity", label: "obesity" }));
});

it("names the kind of each follow, and says where the followed zones are managed", async () => {
  client.listFrontierFollows.mockResolvedValue([
    followed, { id: "8", kind: "drug", key: "semaglutide", label: "司美格鲁肽", muted: false }, { id: "9", kind: "source", key: "fda", label: "FDA", muted: false },
  ]);
  render(<FrontierFollows selected={null} onSelect={vi.fn()} onChanged={vi.fn()} />);
  const row = (await screen.findByRole("button", { name: "司美格鲁肽" })).closest("tr")!;
  expect(within(row).getByText("药物")).toBeInTheDocument();
  expect(within((screen.getByRole("button", { name: "FDA" })).closest("tr")!).getByText("来源")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "已关注的证据专区在“证据专区”里管理 ›" })).toHaveAttribute("href", "/app/frontier/zones?scope=following");
});

it("says 「还没有关注。」 when nothing is followed, whatever kind is missing", async () => {
  client.listFrontierFollows.mockResolvedValue([]);
  render(<FrontierFollows selected={null} onSelect={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText("还没有关注。")).toBeInTheDocument();
});
