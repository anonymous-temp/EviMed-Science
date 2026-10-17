import { useRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Outline, useOutline } from "./Outline";

function Reader({ layout, sections = 4, refresh = [], skip }: { layout: "column" | "folded"; sections?: number; refresh?: unknown[]; skip?: string }) {
  const body = useRef<HTMLDivElement>(null);
  const { entries, active, select } = useOutline(body, { idPrefix: "t", refresh, skip });
  return (
    <div>
      <Outline layout={layout} entries={entries} active={active} onSelect={select} />
      <div ref={body}>
        {Array.from({ length: sections }, (_, index) => (
          <section key={index}>
            <h2>{`第 ${index + 1} 节`}</h2>
            {index === 1 && <h3 id="own">子节</h3>}
            <p>正文。</p>
          </section>
        ))}
        {skip && <div data-skip=""><h2>正文自带的标题</h2></div>}
      </div>
    </div>
  );
}

describe("Outline", () => {
  it("reads the headings the page rendered, keeps an id a heading already has, and indents a part of a section", async () => {
    render(<Reader layout="column" />);
    const nav = await screen.findByRole("navigation", { name: "目录" });
    const buttons = [...nav.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["第 1 节", "第 2 节", "子节", "第 3 节", "第 4 节"]);
    expect(buttons[2].closest("li")).toHaveClass("pl-3");
    expect(document.getElementById("own")).toHaveTextContent("子节");
    expect(document.querySelector("h2")?.id).toMatch(/^t-sec-/);
    await userEvent.click(buttons[3]);
    expect(buttons[3]).toHaveAttribute("aria-current", "location");
  });

  it("leaves out the headings inside a part the page says are not its sections", async () => {
    render(<Reader layout="column" skip="[data-skip]" />);
    const nav = await screen.findByRole("navigation", { name: "目录" });
    expect([...nav.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["第 1 节", "第 2 节", "子节", "第 3 节", "第 4 节"]);
  });

  it("is a column beside the page, sticky below the band the page publishes, with the way back to the top", () => {
    const { container } = render(<Reader layout="column" />);
    const column = container.querySelector("[data-outline]") as HTMLElement;
    expect(column.tagName).toBe("ASIDE");
    expect(column.className).toContain("var(--page-chrome-h");
    expect(screen.getByRole("button", { name: "回到顶部" })).toBeInTheDocument();
  });

  it("is folded above the page on a narrow one, with its count, and has no way back to the top of its own", () => {
    const { container } = render(<Reader layout="folded" />);
    const holder = container.querySelector("[data-outline]") as HTMLElement;
    expect(holder.querySelector("details")).not.toBeNull();
    expect(screen.getByText("目录 · 5 节")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "回到顶部" })).toBeNull();
  });

  it("reads the page again when what re-renders it changes", () => {
    const { rerender } = render(<Reader layout="column" sections={2} refresh={["a"]} />);
    expect(screen.getByRole("navigation", { name: "目录" }).querySelectorAll("button")).toHaveLength(3);
    rerender(<Reader layout="column" sections={3} refresh={["b"]} />);
    expect(screen.getByRole("navigation", { name: "目录" }).querySelectorAll("button")).toHaveLength(4);
  });

  it("draws nothing for a page with no headings", () => {
    const { container } = render(<Outline layout="column" entries={[]} active={null} onSelect={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
