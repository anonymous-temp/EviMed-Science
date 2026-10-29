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
it("selects an owned follow, and makes a zone of one's own where a typed follow used to be added", async () => {
  const select = vi.fn(), change = vi.fn(), create = vi.fn();
  render(<FrontierFollows selected={null} onSelect={select} onChanged={change} onCreateZone={create} />);
  fireEvent.click(await screen.findByRole("button", { name: "肥胖研究" }));
  expect(select).toHaveBeenCalledWith("7");
  expect(screen.queryByLabelText("关注一个药物、试验或问题")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "新建专区" }));
  expect(create).toHaveBeenCalledTimes(1);
  expect(client.addFrontierFollow).not.toHaveBeenCalled();
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

it("has a specialty its list, no typed input, and no 「新建专区」 where the page opens nothing", async () => {
  render(<FrontierFollows selected={null} onSelect={vi.fn()} onChanged={vi.fn()} />);
  await screen.findByRole("button", { name: "肥胖研究" });
  expect(screen.queryByLabelText("关注一个药物、试验或问题")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "新建专区" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("按专科关注").tagName).toBe("SELECT");
  expect(screen.queryByLabelText("关注类型")).not.toBeInTheDocument();
});

it("turns a muted specialty back on when it is added again, and says so when it is already followed", async () => {
  client.listFrontierFollows.mockResolvedValue([{ id: "5", kind: "specialty", key: "cardiology", label: "心血管内科", muted: true }]);
  render(<FrontierFollows selected={null} onSelect={vi.fn()} onChanged={vi.fn()} />);
  await screen.findByText("心血管内科");
  fireEvent.change(screen.getByLabelText("按专科关注"), { target: { value: "cardiology" } });
  fireEvent.click(screen.getByRole("button", { name: "关注专科" }));
  await waitFor(() => expect(client.addFrontierFollow).toHaveBeenCalledWith({ kind: "specialty", key: "cardiology", label: "心血管" }));
  client.listFrontierFollows.mockResolvedValue([{ id: "5", kind: "specialty", key: "cardiology", label: "心血管内科", muted: false }]);
  await act(async () => { window.dispatchEvent(new Event("evimed:frontier-follows-changed")); });
  await screen.findByText("心血管内科");
  client.addFrontierFollow.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "关注专科" }));
  expect(await screen.findByText("已经关注了“心血管内科”")).toBeInTheDocument();
  expect(client.addFrontierFollow).not.toHaveBeenCalled();
});

it("says how a typed follow was read and how many items are new, and offers no mute for it", async () => {
  client.listFrontierFollows.mockResolvedValue([
    { id: "11", kind: "query", key: "glp-1 和胰腺炎", label: "GLP-1 和胰腺炎", muted: false, newItems: 3,
      query: { kind: "question", concepts: [["GLP-1受体激动剂", "司美格鲁肽"], ["胰腺炎", "pancreatitis"]] } },
    { id: "12", kind: "query", key: "司美格鲁肽", label: "司美格鲁肽", muted: false, newItems: 99, query: { kind: "drug", concepts: [["司美格鲁肽", "semaglutide"]] } },
  ]);
  render(<FrontierFollows selected={null} onSelect={vi.fn()} onChanged={vi.fn()} />);
  const row = (await screen.findByRole("button", { name: "GLP-1 和胰腺炎" })).closest("tr")!;
  expect(within(row).getByText("匹配：GLP-1受体激动剂、司美格鲁肽 ＋ 胰腺炎、pancreatitis")).toBeInTheDocument();
  expect(within(row).getByText("关注词 · 问题")).toBeInTheDocument();
  expect(within(row).getByText("3 条新动态")).toBeInTheDocument();
  expect(within(row).getByText("关注中")).toBeInTheDocument();
  expect(within(row).queryByRole("button", { name: /屏蔽/ })).not.toBeInTheDocument();
  expect(within(row).getByRole("button", { name: "移除 GLP-1 和胰腺炎" })).toBeInTheDocument();
  expect(screen.getByText("99+ 条新动态")).toBeInTheDocument();
});

it("names the kind of each follow, and says where the reader's own and followed zones are managed", async () => {
  client.listFrontierFollows.mockResolvedValue([
    followed, { id: "8", kind: "drug", key: "semaglutide", label: "司美格鲁肽", muted: false }, { id: "9", kind: "source", key: "fda", label: "FDA", muted: false },
  ]);
  render(<FrontierFollows selected={null} onSelect={vi.fn()} onChanged={vi.fn()} />);
  const row = (await screen.findByRole("button", { name: "司美格鲁肽" })).closest("tr")!;
  expect(within(row).getByText("药物")).toBeInTheDocument();
  expect(within((screen.getByRole("button", { name: "FDA" })).closest("tr")!).getByText("来源")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "我的专区和关注的专区在“证据专区”里管理 ›" })).toHaveAttribute("href", "/app/frontier?view=zones&scope=mine");
});

it("says 「还没有关注。」 when nothing is followed, whatever kind is missing", async () => {
  client.listFrontierFollows.mockResolvedValue([]);
  render(<FrontierFollows selected={null} onSelect={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText("还没有关注。")).toBeInTheDocument();
});
