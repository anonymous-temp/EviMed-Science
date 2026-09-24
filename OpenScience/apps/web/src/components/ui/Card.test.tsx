import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Card } from "./Card";

describe("Card", () => {
  // No hint under a card's title and no rule under its header (2026-09-23
  // plan §4): a card that needs a sentence of explanation is explaining the
  // system.
  it("renders the unified surface with its title and no hint", () => {
    render(
      <Card title="外观" hint="主题保存在本浏览器中">
        内容
      </Card>,
    );
    expect(screen.getByRole("heading", { name: "外观" })).toBeInTheDocument();
    expect(screen.queryByText("主题保存在本浏览器中")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "外观" }).closest("header")?.className).not.toMatch(/border/);
    expect(screen.getByText("内容")).toBeInTheDocument();
    const section = screen.getByText("内容").closest("section");
    expect(section).toHaveClass("rounded-card", "border", "border-border", "bg-surface");
    // A static card is a hairline, not a shadow (appendix D §9.3).
    expect(section?.className).not.toMatch(/shadow/);
  });

  it("applies the padding scale to the body (16 default, 12 dense)", () => {
    const { rerender } = render(<Card title="t">正文</Card>);
    expect(screen.getByText("正文")).toHaveClass("p-4");
    rerender(
      <Card title="t" padding="p-3">
        正文
      </Card>,
    );
    expect(screen.getByText("正文")).toHaveClass("p-3");
  });

  it("renders a raw header slot instead of the title block when given", () => {
    render(
      <Card title="被替换" header={<div>自定义头部</div>}>
        正文
      </Card>,
    );
    expect(screen.getByText("自定义头部")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "被替换" })).not.toBeInTheDocument();
  });

  it("renders a footer slot without a second rule inside the card", () => {
    render(
      <Card title="t" footer={<button>保存</button>}>
        正文
      </Card>,
    );
    const footer = screen.getByRole("button", { name: "保存" }).closest("footer");
    expect(footer).toBeInTheDocument();
    expect(footer?.className).not.toMatch(/border/);
  });

  it("omits the header entirely when no title, hint or header is given", () => {
    render(<Card>正文</Card>);
    expect(screen.getByText("正文").closest("section")?.querySelector("header")).toBeNull();
  });

  it("merges caller classes on the section", () => {
    render(
      <Card title="t" className="mt-5">
        正文
      </Card>,
    );
    expect(screen.getByText("正文").closest("section")).toHaveClass("mt-5");
  });
});
