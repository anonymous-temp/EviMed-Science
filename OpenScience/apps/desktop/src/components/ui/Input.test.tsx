import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { Input, inputClasses, Textarea, textareaClasses } from "./Input";

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
    expect(input).toHaveClass("border-border");
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
    expect(inputClasses()).toContain("h-9");
    expect(inputClasses({ error: true })).toContain("border-error");
    expect(textareaClasses()).toContain("resize-y");
    expect(inputClasses({ className: "pl-9" })).toContain("pl-9");
  });
});
