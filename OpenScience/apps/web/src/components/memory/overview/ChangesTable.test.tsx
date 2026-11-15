import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeRow } from "./memoryOverviewModel";
import { ChangesTable } from "./ChangesTable";

afterEach(cleanup);

describe("recent change titles", () => {
  it("renders file statements as plain text without Markdown heading or bullet marks", () => {
    const row: ChangeRow = {
      key: "noted:memory:mother:0", lane: "noted",
      title: "# 母亲 68 岁\n## 用药\n- 对头孢类过敏。\n- 使用氨氯地平。",
      meta: "记下 · 11月15日 · 关于你", glyph: "●", state: "current",
      target: { kind: "drawer", open: { kind: "record", id: "mother" } },
    };
    render(<ChangesTable title="最近变化" rows={[row]} label="最近变化" onOpen={vi.fn()} />);
    const item = screen.getByRole("listitem");
    expect(item).toHaveTextContent("对头孢类过敏；使用氨氯地平");
    expect(item).not.toHaveTextContent("母亲 68 岁");
    expect(item.textContent).not.toMatch(/#|- 对头孢/);
  });
});
