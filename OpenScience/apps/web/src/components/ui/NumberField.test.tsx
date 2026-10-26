import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { NumberField } from "./NumberField";
function Form() {
  const [value, setValue] = useState<number | string | undefined>(.25);
  return <form><NumberField label="概率" policy={{ scale: "percent", unit: "%", min: 0, max: 1, exponent: true }} example="25" value={value} onValueChange={setValue} required /><output>{JSON.stringify(value)}</output><button type="submit">保存</button></form>;
}
describe("NumberField", () => {
  it("clears obsolete feedback when an authoritative scenario replaces an invalid draft", () => {
    function Resettable() {
      const [value, setValue] = useState<number | string | undefined>(0.25);
      return <><NumberField label="重设概率" policy={{ scale: "percent", unit: "%", min: 0, max: 1 }} example="25" value={value} onValueChange={setValue} /><button onClick={() => setValue(0.75)}>载入场景</button></>;
    }
    render(<Resettable />);
    const field = screen.getByRole("textbox", { name: "重设概率" });
    fireEvent.change(field, { target: { value: "abc" } });
    expect(field).toHaveAttribute("aria-invalid", "true");
    fireEvent.click(screen.getByRole("button", { name: "载入场景" }));
    expect(field).toHaveValue("75");
    expect(field).not.toHaveAttribute("aria-invalid");
    expect((field as HTMLInputElement).validity.valid).toBe(true);
  });

  it("does not invalidate an untouched optional absence during submit", () => {
    const { container } = render(<form><NumberField label="可选数量" policy={{ scale: "scalar", unit: "次" }} example="2" value={undefined} onValueChange={() => {}} /></form>);
    const field = screen.getByRole("textbox", { name: "可选数量" }) as HTMLInputElement;
    expect(field.validity.valid).toBe(true);
    fireEvent.submit(container.querySelector("form")!);
    expect(field.validity.valid).toBe(true);
    expect(field).not.toHaveAttribute("aria-invalid");
  });
  it("retains invalid raw parent state, blocks submit, and reparses blur without double conversion", () => {
    render(<Form />);
    const input = screen.getByRole("textbox", { name: "概率" }) as HTMLInputElement;
    expect(input.value).toBe("25");
    fireEvent.change(input, { target: { value: "1e" } });
    expect(input.value).toBe("1e");
    expect(input.validity.valid).toBe(false);
    expect(screen.getByRole("status")).toHaveTextContent('"1e"');
    fireEvent.blur(input);
    expect(input.value).toBe("1e");
    fireEvent.change(input, { target: { value: "50" } });
    fireEvent.blur(input);
    expect(input.value).toBe("50");
    expect(input.validity.valid).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("0.5");
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByRole("status")).toHaveTextContent('""');
    expect(input.validity.valid).toBe(false);
  });
});

it("keeps optional absence valid on blur and clear and revalidates required/policy changes", () => {
  const changed = vi.fn();
  const { rerender } = render(<NumberField label="Optional" value={undefined} onValueChange={changed} policy={{ scale: "scalar", unit: "" }} example="2" />);
  const input = screen.getByRole("textbox") as HTMLInputElement;
  fireEvent.focus(input); fireEvent.blur(input);
  expect(input.validity.valid).toBe(true);
  expect(changed).toHaveBeenLastCalledWith(undefined);
  expect(changed).not.toHaveBeenCalledWith(0);
  expect(changed).not.toHaveBeenCalledWith("");
  rerender(<NumberField label="Optional" value={2} onValueChange={changed} policy={{ scale: "scalar", unit: "" }} example="2" />);
  fireEvent.change(input, { target: { value: "" } });
  expect(changed).toHaveBeenLastCalledWith(undefined);
  rerender(<NumberField label="Optional" value={undefined} onValueChange={changed} policy={{ scale: "scalar", unit: "" }} example="2" />);
  fireEvent.blur(input);
  expect(input.validity.valid).toBe(true);
  rerender(<NumberField label="Optional" required value={undefined} onValueChange={changed} policy={{ scale: "scalar", unit: "" }} example="2" />);
  expect(input.validity.valid).toBe(false);
  rerender(<NumberField label="Optional" value={2} onValueChange={changed} policy={{ scale: "scalar", unit: "", max: 1 }} example="1" />);
  expect(input.validity.valid).toBe(false);
  rerender(<NumberField label="Optional" value={2} onValueChange={changed} policy={{ scale: "scalar", unit: "", max: 3 }} example="2" />);
  expect(input.validity.valid).toBe(true);
});
