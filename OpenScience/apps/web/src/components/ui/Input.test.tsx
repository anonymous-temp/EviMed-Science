import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { Input, inputClasses, Textarea, textareaClasses } from "./Input";

describe("Input trailing", () => {
  it("holds a control inside the field's right edge, and the text stops before it", () => {
    render(<Input label="密码" type="password" trailing={<button type="button">显示密码</button>} />);
    const input = screen.getByLabelText("密码");
    expect(input).toHaveClass("pr-11");
    expect(input.parentElement).toContainElement(screen.getByRole("button", { name: "显示密码" }));
    // The control is not inside the label's text or the error line.
    expect(screen.getByText("密码").tagName).toBe("LABEL");
    expect(screen.getByText("密码")).not.toContainElement(screen.getByRole("button", { name: "显示密码" }));
  });

  it("is the bare control when there is nothing trailing: no wrapper, no extra padding", () => {
    const { container } = render(<Input aria-label="账号" />);
    expect(container.firstElementChild?.tagName).toBe("INPUT");
    expect(screen.getByLabelText("账号")).not.toHaveClass("pr-11");
  });

  it("keeps a caller's class and the error styling beside the trailing control", () => {
    render(<Input label="密码" error="太短" className="font-mono" trailing={<span>x</span>} />);
    const input = screen.getByLabelText("密码");
    expect(input).toHaveClass("font-mono", "pr-11", "border-error");
    expect(screen.getByRole("alert")).toHaveTextContent("太短");
  });
});

describe("Input", () => {
  it("associates the label with the control via id", () => {
    render(<Input label="账号" placeholder="请输入账号" />);
    const input = screen.getByLabelText("账号");
    expect(input).toHaveAttribute("placeholder", "请输入账号");
    expect(input.id).toBeTruthy();
  });

  it("honors an explicit id for the label association", () => {
    render(<Input id="login-name" label="账号" />);
    expect(screen.getByLabelText("账号")).toHaveAttribute("id", "login-name");
  });

  it("shows the error below and wires aria-invalid + aria-errormessage", () => {
    render(<Input label="密码" error="密码不能为空" />);
    const input = screen.getByLabelText("密码");
    expect(input).toHaveAttribute("aria-invalid", "true");
    const errorId = input.getAttribute("aria-errormessage");
    expect(errorId).toBeTruthy();
    const message = screen.getByRole("alert");
    expect(message).toHaveTextContent("密码不能为空");
    expect(message).toHaveAttribute("id", errorId);
    expect(input).toHaveClass("border-error");
  });

  it("without label/error renders the bare control (no wrapper) and normal border", () => {
    const { container } = render(<Input aria-label="搜索" />);
    const input = screen.getByRole("textbox", { name: "搜索" });
    expect(container.firstElementChild).toBe(input);
    expect(input).not.toHaveAttribute("aria-invalid");
    // The control boundary token (3:1), not the decorative hairline.
    expect(input).toHaveClass("border-border-control");
    // Focus is an outline forced colours can paint, never a ring shadow
    // (appendix E #1).
    expect(input).toHaveClass("focus:outline-focus", "focus:outline-1", "focus:-outline-offset-2");
    expect(input.className).not.toMatch(/ring-/);
  });

  it("forwards refs, values and change handlers", async () => {
    const ref = createRef<HTMLInputElement>();
    const onChange = vi.fn();
    render(<Input ref={ref} label="名称" defaultValue="旧值" onChange={onChange} />);
    const input = screen.getByLabelText("名称");
    expect(ref.current).toBe(input);
    expect(input).toHaveValue("旧值");
    await userEvent.type(input, "x");
    expect(onChange).toHaveBeenCalled();
  });

  it("passes through disabled", () => {
    render(<Input label="只读" disabled />);
    expect(screen.getByLabelText("只读")).toBeDisabled();
  });
});

describe("Textarea", () => {
  it("renders a labelled multiline control with ref forwarding", async () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<Textarea ref={ref} label="备注" placeholder="记录…" />);
    const area = screen.getByLabelText("备注");
    expect(area.tagName).toBe("TEXTAREA");
    expect(ref.current).toBe(area);
    await userEvent.type(area, "一行");
    expect(area).toHaveValue("一行");
  });

  it("supports the error state like Input", () => {
    render(<Textarea label="内容" error="内容过长" />);
    const area = screen.getByLabelText("内容");
    expect(area).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("内容过长");
  });
});

describe("class helpers", () => {
  it("share the control look for selects and custom controls", () => {
    // 36 on a page, 28 in a table or a toolbar (appendix E #9).
    expect(inputClasses()).toContain("h-control");
    expect(inputClasses({ size: "sm" })).toContain("h-sm");
    expect(inputClasses({ size: "sm" })).not.toContain("h-control");
    // A caller's own height replaces the primitive's rather than sitting beside it.
    expect(inputClasses({ className: "h-7" })).not.toContain("h-control");
    expect(inputClasses({ error: true })).toContain("border-error");
    expect(textareaClasses()).toContain("resize-y");
    expect(inputClasses({ className: "pl-9" })).toContain("pl-9");
  });
});

it('native select shares the field label, error association and control height with text input', async () => {
  const {Select} = await import('./Input');
  render(<><Input label="时间" value="07:00" readOnly/><Select label="重复" error="请选择频率" defaultValue="daily"><option value="daily">每天</option></Select></>);
  const select = screen.getByRole('combobox',{name:'重复'}), input=screen.getByLabelText('时间');
  expect(select).toHaveClass('h-control');expect(input).toHaveClass('h-control');expect(select).toHaveAttribute('aria-invalid','true');
  expect(document.getElementById(select.getAttribute('aria-errormessage')!)).toHaveTextContent('请选择频率');
  expect(select.parentElement?.querySelector('label')).toHaveAttribute('for',select.id);
});
