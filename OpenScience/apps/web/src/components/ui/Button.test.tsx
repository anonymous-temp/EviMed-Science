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
        <Button variant="secondary">次按钮</Button>
        <Button variant="ghost">旧名</Button>
        <Button variant="text" destructive>移除</Button>
        <Button variant="danger" size="sm">
          删除
        </Button>
      </>,
    );
    // 36 is a page's control height (md); `sm` is 28 with 14 px text, inside a
    // row (spec §16.3, appendix E #9).
    expect(screen.getByRole("button", { name: "主按钮" })).toHaveClass("bg-accent", "text-accent-fg", "h-control", "text-ui");
    // No outline buttons: the secondary look is a grey ground, and `ghost` is its retired name.
    for (const name of ["次按钮", "旧名"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveClass("bg-surface-2", "text-text");
      expect(button.className).not.toMatch(/(^|\s)border(\s|$)/);
    }
    expect(screen.getByRole("button", { name: "移除" })).toHaveClass("bg-transparent", "text-danger");
    expect(screen.getByRole("button", { name: "删除" })).toHaveClass("bg-error", "text-error-fg", "h-sm", "text-ui");
  });

  it("merges caller classes with conflict resolution", () => {
    render(<Button className="h-11 w-full">宽按钮</Button>);
    expect(screen.getByRole("button", { name: "宽按钮" })).toHaveClass("h-11", "w-full");
    expect(screen.getByRole("button", { name: "宽按钮" })).not.toHaveClass("h-control");
  });

  it("loading shows a spinner, sets aria-busy and disables the button", () => {
    render(<Button loading>保存中</Button>);
    const btn = screen.getByRole("button", { name: "保存中" });
    // disabled is what blocks clicks — native button semantics, no JS needed.
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveAttribute("aria-disabled", "true");
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
    // 44 px is a form's primary action and nothing else.
    expect(buttonClasses({ size: "lg" })).toContain("h-form-primary");
  });
});

it("guards busy mouse, keyboard and submit activation while preserving focus and name", async () => {
 const click=vi.fn(),submit=vi.fn(e=>e.preventDefault());
 const view=render(<form onSubmit={submit}><Button type="submit" onClick={click}>Save</Button></form>);
 const button=screen.getByRole("button",{name:"Save"});button.focus();
 view.rerender(<form onSubmit={submit}><Button type="submit" loading onClick={click}>Save</Button></form>);
 expect(button).toHaveFocus();await userEvent.click(button);await userEvent.keyboard("{Enter} ");
 expect(click).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled();
});

it("draws the spinner's room only while it spins, keeps a long label visible beside it, and leaves a resting button centred",()=>{
 const label="Save this deliberately long action label";const view=render(<Button loading>{label}</Button>);
 const button=screen.getByRole('button',{name:label});expect(button).toHaveTextContent(label);expect(button.querySelector('.invisible')).toBeNull();
 expect(button.querySelector('.w-4 .animate-spin')).not.toBeNull();
 // At rest — whether `loading` is false or absent — there is no empty slot pushing the label off centre.
 view.rerender(<Button loading={false}>{label}</Button>);expect(button.querySelector('.w-4')).toBeNull();expect(button.querySelector('svg')).toBeNull();
 view.rerender(<Button>{label}</Button>);expect(button.querySelector('.w-4')).toBeNull();
});

it("loading takes temporary disabled ownership for legacy disabled=busy callers",async()=>{
 const click=vi.fn();const view=render(<Button loading={false} disabled={false} onClick={click}>Save</Button>);
 const button=screen.getByRole('button',{name:'Save'});button.focus();view.rerender(<Button loading disabled onClick={click}>Save</Button>);
 expect(button).toHaveFocus();expect(button).not.toBeDisabled();expect(button).toHaveAttribute('aria-disabled','true');
 await userEvent.click(button);await userEvent.keyboard('{Enter} ');expect(click).not.toHaveBeenCalled();
 view.rerender(<Button loading={false} disabled onClick={click}>Save</Button>);expect(button).toBeDisabled();
});
