import { render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router";
import { Button } from "@/components/ui/Button";
import { EvimedSearchResultList } from "./EvimedSearchResultList";
import { EvimedSearchResults } from "./EvimedSearchResults";
import type { EvimedSearchItem, EvimedSearchResult } from "@/lib/evimedSearchClient";

const item: EvimedSearchItem = {
  id: "one", title: "A complete study title", subtitle: "Journal of Medicine", source: "Journal of Medicine",
  summary: "A short evidence preview.", authors: ["Author One"], publishedAt: "2026", tags: [],
  url: "https://example.org/study", detailRef: "detail-one", doi: null,
};
const result: EvimedSearchResult = { category: "literature", query: "heart", page: 1, pageSize: 5, total: 12, items: [item] };

it("switches summary and selection controls in place and returns focus after clearing", async () => {
  const selectable = { ...item, actionRef: "selectable-one" };
  function Harness({ pending = false }: { pending?: boolean }) {
    const [selected, setSelected] = useState<EvimedSearchItem[]>([]);
    return <EvimedSearchResults category="literature" result={pending ? null : { ...result, items: [selectable] }} pending={pending} page={1}
      selection={{ items: selected, limit: 20, onChange: (items, value) => setSelected(value ? items : []), onClear: () => setSelected([]) }} />;
  }
  const view = render(<Harness />);
  const checkbox = screen.getByRole("checkbox", { name: "选择本页" });
  const heading = screen.getByRole("heading", { name: "检索结果" });
  const count = view.container.querySelector("[data-search-count]");
  await userEvent.click(checkbox);
  expect(screen.getByRole("button", { name: "导出已选 1 篇" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "检索结果" })).toBeNull();
  expect(heading).toBeInTheDocument();
  expect(view.container.querySelector("[data-search-count]")).toBe(count);
  expect(screen.getByRole("checkbox", { name: "选择本页" })).toBe(checkbox);
  await userEvent.click(screen.getByRole("button", { name: "清空选择" }));
  await waitFor(() => expect(checkbox).toHaveFocus());
  expect(screen.getByRole("heading", { name: "检索结果" })).toBe(heading);
  expect(screen.queryByRole("group", { name: "已选文献操作" })).toBeNull();
  view.rerender(<Harness pending />);
  expect(screen.getByRole("checkbox", { name: "选择本页" })).toBe(checkbox);
  expect(checkbox).toBeDisabled();
  expect(checkbox).not.toBeChecked();
});

function Location() {
  const location = useLocation();
  return <output data-testid="destination">{location.pathname}|{location.state?.returnTo}</output>;
}

it("reuses standalone rows outside the search route with host destinations, origin state and independent actions", async () => {
  const action = vi.fn();
  render(<MemoryRouter initialEntries={["/app/library"]}>
    <EvimedSearchResultList items={[item]} getDetailLink={record => ({ to: `/app/library/${record.id}`, state: { returnTo: "/app/library" } })}
      renderActions={() => <Button onClick={action}>添加到项目</Button>} /><Location />
  </MemoryRouter>);
  expect(screen.getAllByText("Journal of Medicine")).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "添加到项目" }));
  expect(action).toHaveBeenCalledOnce();
  expect(screen.getByTestId("destination")).toHaveTextContent("/app/library|");
  await userEvent.click(screen.getByRole("link", { name: item.title }));
  expect(screen.getByTestId("destination")).toHaveTextContent("/app/library/one|/app/library");
});

it("falls back to safe external sources without inventing a search destination", () => {
  render(<EvimedSearchResultList items={[item, { ...item, id: "unsafe", title: "Unsafe source", url: "javascript:alert(1)" }]} />);
  expect(screen.getByRole("link", { name: item.title })).toHaveAttribute("href", item.url);
  expect(screen.queryByRole("link", { name: "Unsafe source" })).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
});

it("composes results without a filter rail and paginates using the supplied page size", async () => {
  const onPageChange = vi.fn();
  const props = { category: "literature" as const, result, pending: false, page: 1, onPageChange };
  const view = render(<EvimedSearchResults {...props} />);
  expect(screen.queryByRole("complementary", { name: "筛选条件" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "收起筛选栏" })).not.toBeInTheDocument();
  expect(screen.getByText("第 1 / 3 页")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(onPageChange).toHaveBeenLastCalledWith(2);
  view.rerender(<EvimedSearchResults {...props} page={3} result={{ ...result, page: 3 }} />);
  expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
  view.rerender(<EvimedSearchResults {...props} onPageChange={undefined} />);
  expect(screen.queryByRole("navigation", { name: "结果分页" })).not.toBeInTheDocument();
});

it("keeps pending, recovery and empty states distinct in a host without search routing", async () => {
  const onPageChange = vi.fn();
  const retry = vi.fn();
  const props = { category: "guidelines" as const, result: null, pending: true, page: 2, onPageChange };
  const view = render(<EvimedSearchResults {...props} />);
  expect(screen.getByRole("status", { name: "正在检索" })).toBeInTheDocument();
  expect(screen.queryByText("共 0 条")).not.toBeInTheDocument();
  view.rerender(<EvimedSearchResults {...props} pending={false} error={<Button onClick={retry}>重新连接</Button>} />);
  await userEvent.click(screen.getByRole("button", { name: "重新连接" }));
  expect(retry).toHaveBeenCalledOnce();
  expect(screen.queryByRole("list", { name: "检索结果" })).not.toBeInTheDocument();
  view.rerender(<EvimedSearchResults {...props} pending={false} result={{ ...result, category: "guidelines", items: [] }} />);
  await userEvent.click(screen.getByRole("button", { name: "返回第一页" }));
  expect(onPageChange).toHaveBeenCalledWith(1);
});
