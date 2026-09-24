import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { useState } from "react";
import { Pencil } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { FilterChip, FilterChips, FilterSelect } from "./FilterChips";
import { IconButton } from "./IconButton";
import { List, ListRow } from "./ListRow";
import { Menu } from "./Menu";
import { Panel, PanelRow } from "./Panel";
import { SearchInput } from "./SearchInput";
import { Switch } from "./Switch";
import { Tabs } from "./Tabs";
import { Tag } from "./Tag";

/**
 * The component set of the 2026-09-23 plan (§4, WP1). Each primitive is held
 * to the one rule it exists for — no border on a chip, the title as the row's
 * target, one row of filters with the rest in 「更多」 — so a page that uses it
 * cannot drift back into the variant it replaced.
 */

const BORDER = /(^|\s)border(\s|$)/;

describe("Tag", () => {
  it("is a 20 px, borderless label, red only for safety", () => {
    render(<><Tag>RCT</Tag><Tag tone="safety">安全警示</Tag></>);
    const tag = screen.getByText("RCT");
    expect(tag).toHaveClass("h-5", "rounded-tag", "text-meta", "bg-surface-2");
    expect(tag.className).not.toMatch(BORDER);
    expect(screen.getByText("安全警示")).toHaveClass("bg-danger-soft", "text-danger-strong");
  });
});

describe("IconButton", () => {
  it("is named by its label, as its tooltip too", async () => {
    const onClick = vi.fn();
    render(<IconButton icon={Pencil} label="编辑" onClick={onClick} size="sm" />);
    const button = screen.getByRole("button", { name: "编辑" });
    expect(button).toHaveAttribute("title", "编辑");
    expect(button).toHaveClass("h-6", "w-6");
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("FilterChips", () => {
  function Harness() {
    const [value, setValue] = useState("all");
    const options = ["all", "a", "b", "c", "d", "e", "f", "g"].map((key) => ({ value: key, label: key === "all" ? "全部" : `栏目${key}` }));
    return (
      <>
        <FilterChips label="栏目" options={options} value={value} onChange={setValue} trailing={<FilterChip pressed={false}>收藏</FilterChip>} />
        <output>{value}</output>
      </>
    );
  }

  it("keeps one row: six chips, the rest behind 「更多」, no borders", async () => {
    render(<Harness />);
    const group = screen.getByRole("group", { name: "栏目" });
    const chips = within(group).getAllByRole("button");
    // Six inline chips and the 「更多」 chip.
    expect(chips).toHaveLength(7);
    for (const chip of chips) expect(chip.className).not.toMatch(BORDER);
    expect(screen.getByRole("button", { name: "全部" })).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByRole("button", { name: /更多/ }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "栏目g" }));
    expect(screen.getByRole("status")).toHaveTextContent("g");
    // The chosen overflow option names the 「更多」 chip, and it reads as selected.
    expect(within(group).getByRole("button", { name: /栏目g/ })).toHaveClass("bg-surface-2");
  });

  it("offers another dimension as a chip that opens a single-choice menu", async () => {
    const onChange = vi.fn();
    render(<FilterSelect label="专科" allLabel="全部专科" options={[{ value: "cardio", label: "心血管" }]} value={null} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "专科" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "心血管" }));
    expect(onChange).toHaveBeenCalledWith("cardio");
  });
});

describe("Tabs", () => {
  function Harness() {
    const [value, setValue] = useState("selected");
    return (
      <Tabs
        label="视图"
        value={value}
        onChange={setValue}
        items={[{ value: "selected", label: "精选" }, { value: "hot", label: "热榜" }, { value: "daily", label: "日报" }]}
      />
    );
  }

  it("is a tab list moved by the arrow keys, with one tab in the tab order", async () => {
    render(<Harness />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    tabs[0].focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "热榜" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "热榜" })).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "日报" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("ListRow", () => {
  it("makes the title the row's target and keeps its actions clickable", async () => {
    const onEdit = vi.fn();
    render(
      <MemoryRouter>
        <List label="记忆">
          <ListRow title="偏好结论先行的回答" to="/app/memory/1" meta="关于你" actions={<IconButton icon={Pencil} label="编辑" size="sm" onClick={onEdit} />} />
        </List>
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: "偏好结论先行的回答" });
    expect(link).toHaveAttribute("href", "/app/memory/1");
    // The stretched pseudo-element makes the whole row the link's target.
    expect(link.className).toMatch(/after:absolute/);
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(onEdit).toHaveBeenCalledOnce();
    expect(screen.getByRole("listitem").className).not.toMatch(BORDER);
  });
});

describe("Panel", () => {
  it("names the group outside one box, one item per row", () => {
    render(
      <Panel title="账户">
        <PanelRow label="用户名" control="cdss-access" />
        <PanelRow label="密码" control={<button type="button">修改</button>} />
      </Panel>,
    );
    const heading = screen.getByRole("heading", { name: "账户" });
    const box = screen.getByText("用户名").closest(".rounded-card");
    expect(box).not.toBeNull();
    expect(box?.contains(heading)).toBe(false);
    expect(screen.getByText("cdss-access")).toBeInTheDocument();
  });
});

describe("Switch", () => {
  it("is a switch that says its state by position, named by its label", async () => {
    const onChange = vi.fn();
    render(<Switch checked label="记忆" onChange={onChange} />);
    const control = screen.getByRole("switch", { name: "记忆" });
    expect(control).toHaveAttribute("aria-checked", "true");
    await userEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(false);
  });
});

describe("Menu", () => {
  it("opens from the quiet 「⋯」, focuses the first item and runs the chosen one", async () => {
    const onDelete = vi.fn();
    render(<Menu label="更多操作" items={[{ label: "重命名", onSelect: vi.fn() }, "separator", { label: "删除", destructive: true, onSelect: onDelete }]} />);
    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    const first = await screen.findByRole("menuitem", { name: "重命名" });
    await vi.waitFor(() => expect(first).toHaveFocus());
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "删除" })).toHaveFocus();
    expect(screen.getByRole("menuitem", { name: "删除" })).toHaveClass("text-danger");
    await userEvent.keyboard("{Enter}");
    expect(onDelete).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("SearchInput", () => {
  it("is a searchbox named and placeheld by one word", () => {
    render(<SearchInput label="搜索工具" />);
    const box = screen.getByRole("searchbox", { name: "搜索工具" });
    expect(box).toHaveAttribute("placeholder", "搜索工具");
    expect(box).toHaveClass("h-8", "bg-surface-2");
  });
});
