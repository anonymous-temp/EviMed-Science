import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvimedSearchCategory, EvimedSearchDetail } from "@/lib/evimedSearchClient";
import { EvimedSearchReader } from "./EvimedSearchReader";
import { searchDetailFacts, structuredAbstract } from "./evimedReaderContent";

const viewport = vi.hoisted(() => ({ wide: true }));
vi.mock("@/lib/useMediaQuery", async original => ({ ...await original<typeof import("@/lib/useMediaQuery")>(), useWide: () => viewport.wide }));
const detail: EvimedSearchDetail = {
  title: "A long original study title", source: "Journal of Research", subtitle: "Journal of Research",
  url: "https://example.org/original", doi: "10.1234/research",
  metadata: [{ label: "期刊", value: "Journal of Research" }, { label: "发布日期", value: "2026" }],
  sections: [{ title: "摘要", text: "Introduction: An existing question. Methods: We enrolled 170 patients. Results: 95% CI: 1.299–1.467. Conclusions: Further research is needed." }],
};
function open(category: EvimedSearchCategory = "literature", data = detail) {
  return render(<MemoryRouter><EvimedSearchReader category={category} detail={data}
    backTo="/app/search/literature?q=heart&page=2" onSearch={vi.fn()} onCollectedChange={vi.fn()} /></MemoryRouter>);
}
afterEach(() => { viewport.wide = true; vi.restoreAllMocks(); });

describe("medical search readers", () => {
  it("only offers return to top after the reading pane scrolls and restores keyboard focus when it hides", async () => {
    open();
    const back = screen.getByRole("link", { name: "返回" });
    const scroller = back.closest<HTMLElement>(".overflow-y-auto")!;
    expect(screen.queryByRole("button", { name: "回到顶部" })).toBeNull();
    fireEvent.scroll(screen.getByRole("complementary"), { target: { scrollTop: 80 } });
    expect(screen.queryByRole("button", { name: "回到顶部" })).toBeNull();
    fireEvent.scroll(scroller, { target: { scrollTop: 150 } });
    expect(screen.getByRole("button", { name: "回到顶部" })).toBeVisible();
    back.parentElement!.scrollIntoView = () => fireEvent.scroll(scroller, { target: { scrollTop: 0 } });
    await userEvent.click(screen.getByRole("button", { name: "回到顶部" }));
    expect(screen.queryByRole("button", { name: "回到顶部" })).toBeNull();
    expect(back).toHaveFocus();
    fireEvent.scroll(scroller, { target: { scrollTop: 50 } });
    expect(screen.getByRole("button", { name: "回到顶部" })).toBeVisible();
    fireEvent.scroll(scroller, { target: { scrollTop: 0 } });
    expect(screen.queryByRole("button", { name: "回到顶部" })).toBeNull();
  });

  it("navigates the actual abstract headings, preserves numerical content and moves keyboard focus", async () => {
    open();
    expect(screen.getByRole("heading", { level: 1 })).not.toHaveClass("line-clamp-2");
    const nav = await screen.findByRole("navigation", { name: "本页目录" });
    expect(within(nav).getAllByRole("button").map(button => button.textContent)).toEqual(["摘要", "Introduction", "Methods", "Results", "Conclusions"]);
    expect(screen.getByText("95% CI: 1.299–1.467.")).toBeInTheDocument();
    const heading = screen.getByRole("heading", { name: "Results", level: 3 });
    const scroll = vi.fn(); heading.scrollIntoView = scroll;
    await userEvent.click(within(nav).getByRole("button", { name: "Results" }));
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    expect(heading).toHaveFocus();
    expect(within(nav).getByRole("button", { name: "Results" })).toHaveAttribute("aria-current", "location");
    expect(screen.getAllByText("Journal of Research")).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: "打开原文" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "返回" })).toHaveAttribute("href", "/app/search/literature?q=heart&page=2");
  });

  it("folds the drug outline above the body on narrow screens and keeps every section accessible", async () => {
    viewport.wide = false;
    open("drugs", { ...detail, sections: [
      { title: "适应症", text: "First paragraph.\n\nSecond paragraph." },
      { title: "警告", text: "<script>untrusted</script>\nDo not omit this warning." },
      { title: "用法用量", text: "Original directions." },
    ] });
    expect(screen.queryByRole("complementary")).toBeNull();
    const disclosure = screen.getByText("本页目录 · 3 节").closest("details")!;
    expect(disclosure).not.toHaveAttribute("open");
    await userEvent.click(screen.getByText("本页目录 · 3 节"));
    const nav = screen.getByRole("navigation", { name: "本页目录" });
    await userEvent.click(within(nav).getByRole("button", { name: "警告" }));
    expect(screen.getByRole("heading", { name: "警告", level: 2 })).toHaveFocus();
    expect(screen.getByText("First paragraph.").tagName).toBe("P");
    expect(screen.getByText("Second paragraph.").tagName).toBe("P");
    expect(screen.getByText(/<script>untrusted/)).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getAllByRole("heading", { name: "药品信息" })).toHaveLength(1);
  });

  it.each([
    ["literature", "这篇文献暂无可阅读的摘要。"],
    ["guidelines", "这份指南暂无可阅读的正文或内容简介。"],
    ["drugs", "这份说明书暂无可阅读的章节。"],
  ] as const)("uses an accurate empty state for %s and no unsafe source link", (category, message) => {
    open(category, { ...detail, sections: [{ title: "empty", text: " " }], url: "javascript:alert(1)", doi: null });
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "打开原文" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "本页目录" })).toBeNull();
  });

  it("preserves guideline structure instead of treating its prose as an abstract", () => {
    open("guidelines");
    expect(screen.getByText(detail.sections[0].text)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Methods" })).toBeNull();
  });

  it("refreshes outline targets when the responsive shell reparents the article", async () => {
    const view = open();
    viewport.wide = false;
    view.rerender(<MemoryRouter><EvimedSearchReader category="literature" detail={detail}
      backTo="/app/search/literature" onSearch={vi.fn()} onCollectedChange={vi.fn()} /></MemoryRouter>);
    await userEvent.click(screen.getByText("本页目录 · 5 节"));
    await userEvent.click(within(screen.getByRole("navigation", { name: "本页目录" })).getByRole("button", { name: "Results" }));
    expect(screen.getByRole("heading", { name: "Results", level: 3 })).toHaveFocus();
    expect(screen.getAllByRole("heading", { name: "文献信息" })).toHaveLength(1);
  });
});

describe("source-preserving presentation", () => {
  it("only splits an abstract with explicit, non-repeating labels from its beginning", () => {
    for (const text of ["These are the Results: an example. Methods: more text.", "Methods: Only one label.", "Methods: One. Methods: Two.", "Methods: One. Results: "]) {
      expect(structuredAbstract(text)).toBeNull();
    }
    expect(structuredAbstract("目的：研究。\n方法：保留原文。\n结果：n=20，P<0.05。"))
      .toEqual([{ title: "目的", text: "研究。" }, { title: "方法", text: "保留原文。" }, { title: "结果", text: "n=20，P<0.05。" }]);
  });
  it("uses the named metadata field before a repeated subtitle and omits placeholders", () => {
    expect(searchDetailFacts({ ...detail, source: "N/A", subtitle: "Publisher", doi: null,
      metadata: [{ label: "发布机构", value: "Publisher" }, { label: "作者", value: "暂无信息" }] }))
      .toEqual([{ label: "发布机构", value: "Publisher" }]);
  });
});
