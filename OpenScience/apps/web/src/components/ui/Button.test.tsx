import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button, buttonClasses } from "./Button";

describe("Button", () => {
  it("renders a button that defaults to type=button (never an accidental submit)", () => {
    render(<Button>保存</Button>);
    const btn = screen.getByRole("button", { name: "保存" });
    expect(btn).toHaveAttribute("type", "button");
  });

  it("keeps an explicit type=submit when asked", () => {
    render(<Button type="submit">登录</Button>);
    expect(screen.getByRole("button", { name: "登录" })).toHaveAttribute("type", "submit");
  });

  it("fires onClick and forwards refs", async () => {
    const onClick = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    render(
      <Button ref={ref} onClick={onClick}>
        确定
      </Button>,
    );
    await userEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it("applies variant and size classes", () => {
    render(
      <>
        <Button variant="primary">主按钮</Button>
        <Button variant="ghost">次按钮</Button>
        <Button variant="danger" size="sm">
          删除
        </Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "主按钮" })).toHaveClass("bg-accent", "text-accent-fg", "h-9");
    expect(screen.getByRole("button", { name: "次按钮" })).toHaveClass("border", "border-border", "bg-surface");
    expect(screen.getByRole("button", { name: "删除" })).toHaveClass("bg-error", "text-error-fg", "h-8");
  });

  it("merges caller classes with conflict resolution", () => {
    render(<Button className="h-11 w-full">宽按钮</Button>);
    expect(screen.getByRole("button", { name: "宽按钮" })).toHaveClass("h-11", "w-full");
    expect(screen.getByRole("button", { name: "宽按钮" })).not.toHaveClass("h-9");
  });

  it("loading shows a spinner, sets aria-busy and disables the button", () => {
    render(<Button loading>保存中</Button>);
    const btn = screen.getByRole("button", { name: "保存中" });
    // disabled is what blocks clicks — native button semantics, no JS needed.
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
    expect(btn.querySelector(".animate-spin")).not.toBeNull();
  });

  it("disabled blocks interaction without showing a spinner", () => {
    render(<Button disabled>不可用</Button>);
    const btn = screen.getByRole("button", { name: "不可用" });
    expect(btn).toBeDisabled();
    expect(btn).not.toHaveAttribute("aria-busy");
    expect(btn.querySelector(".animate-spin")).toBeNull();
  });
});

describe("buttonClasses", () => {
  it("exposes the same look as a class string for non-button elements", () => {
    expect(buttonClasses({ variant: "ghost" })).toContain("bg-surface");
    expect(buttonClasses({ variant: "danger", size: "sm" })).toContain("bg-error");
    expect(buttonClasses({ className: "w-full" })).toContain("w-full");
    expect(buttonClasses()).toContain("bg-accent");
  });
});
