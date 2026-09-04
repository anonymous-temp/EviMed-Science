import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "./SegmentedControl";

const options = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
] as const;

function Harness({ initial = "light", onChange = vi.fn() }: { initial?: string; onChange?: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <SegmentedControl
      aria-label="外观主题"
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
      options={[...options]}
    />
  );
}

describe("SegmentedControl", () => {
  it("exposes radiogroup semantics: radio roles + aria-checked", () => {
    render(<Harness initial="dark" />);
    expect(screen.getByRole("radiogroup", { name: "外观主题" })).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "深色" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "浅色" })).toHaveAttribute("aria-checked", "false");
  });

  it("roving tabindex: only the checked option is tabbable", () => {
    render(<Harness initial="dark" />);
    expect(screen.getByRole("radio", { name: "深色" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "浅色" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("radio", { name: "跟随系统" })).toHaveAttribute("tabindex", "-1");
  });

  it("click selects an option (controlled round-trip)", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole("radio", { name: "跟随系统" }));
    expect(onChange).toHaveBeenCalledWith("system");
    expect(screen.getByRole("radio", { name: "跟随系统" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "跟随系统" })).toHaveAttribute("tabindex", "0");
  });

  it("ArrowRight/ArrowLeft move selection and focus, wrapping at the ends", () => {
    const onChange = vi.fn();
    render(<Harness initial="light" onChange={onChange} />);
    const group = screen.getByRole("radiogroup", { name: "外观主题" });

    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("dark");
    expect(screen.getByRole("radio", { name: "深色" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: "深色" })).toHaveAttribute("aria-checked", "true");

    fireEvent.keyDown(group, { key: "ArrowRight" });
    fireEvent.keyDown(group, { key: "ArrowRight" }); // wraps: system -> light
    expect(onChange).toHaveBeenLastCalledWith("light");
    expect(screen.getByRole("radio", { name: "浅色" })).toHaveFocus();

    fireEvent.keyDown(group, { key: "ArrowLeft" }); // wraps: light -> system
    expect(onChange).toHaveBeenLastCalledWith("system");
    expect(screen.getByRole("radio", { name: "跟随系统" })).toHaveFocus();
  });

  it("ArrowUp/ArrowDown mirror Left/Right; Home/End jump to the edges", () => {
    const onChange = vi.fn();
    render(<Harness initial="dark" onChange={onChange} />);
    const group = screen.getByRole("radiogroup", { name: "外观主题" });

    fireEvent.keyDown(group, { key: "ArrowDown" });
    expect(onChange).toHaveBeenLastCalledWith("system");
    fireEvent.keyDown(group, { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith("dark");
    fireEvent.keyDown(group, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("light");
    fireEvent.keyDown(group, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("system");
    expect(screen.getByRole("radio", { name: "跟随系统" })).toHaveFocus();
  });

  it("ignores unrelated keys", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("radiogroup", { name: "外观主题" }), { key: "a" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stays controlled: a parent that ignores onChange keeps the old value", () => {
    render(
      <SegmentedControl aria-label="外观主题" value="light" onChange={() => {}} options={[...options]} />,
    );
    fireEvent.keyDown(screen.getByRole("radiogroup", { name: "外观主题" }), { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "浅色" })).toHaveAttribute("aria-checked", "true");
  });
});
