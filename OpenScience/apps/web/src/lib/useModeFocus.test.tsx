import { useRef, useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { useModeFocus } from "./useModeFocus";

function Page({ initial = false, enterable = true }: { initial?: boolean; enterable?: boolean }) {
  const [mode, setMode] = useState(initial);
  const heading = useRef<HTMLHeadingElement>(null), opener = useRef<HTMLButtonElement>(null);
  useModeFocus(mode, { enter: () => enterable ? heading.current : null, exit: () => opener.current });
  return mode
    ? <section><h2 ref={heading} tabIndex={-1}>表单</h2><button onClick={() => setMode(false)}>返回</button></section>
    : <button ref={opener} onClick={() => setMode(true)}>打开</button>;
}

it("moves focus to the mode's heading on the way in and back to the control that opened it on the way out", async () => {
  render(<Page />);
  expect(document.body).toHaveFocus();
  await userEvent.click(screen.getByRole("button", { name: "打开" }));
  expect(screen.getByRole("heading", { name: "表单" })).toHaveFocus();
  await userEvent.click(screen.getByRole("button", { name: "返回" }));
  expect(screen.getByRole("button", { name: "打开" })).toHaveFocus();
});

it("does not move focus on the first render, even when the page opens in the mode", () => {
  render(<Page initial />);
  expect(document.body).toHaveFocus();
});

it("moves nothing when the entry is not one the person asked for", async () => {
  render(<Page enterable={false} />);
  await userEvent.click(screen.getByRole("button", { name: "打开" }));
  expect(screen.getByRole("heading", { name: "表单" })).not.toHaveFocus();
});
