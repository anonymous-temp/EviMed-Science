import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SearchInput } from "./SearchInput";

it("does not clear or invoke host submission while an IME owns Enter or Escape", () => {
  const clear = vi.fn(), onKeyDown = vi.fn();
  render(<SearchInput label="搜索" value="研究" readOnly onClear={clear} onKeyDown={onKeyDown} />);
  const input = screen.getByRole("searchbox");
  fireEvent.keyDown(input, { key: "Escape", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  expect(clear).not.toHaveBeenCalled();
  expect(onKeyDown).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(clear).toHaveBeenCalledOnce();
  expect(onKeyDown).toHaveBeenCalledOnce();
});
