import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { Headline } from "./Headline";
import { Note } from "./Note";

describe("Note", () => {
  it("is a sentence together with the one thing the reader can do about it", async () => {
    const add = vi.fn();
    const { container } = render(
      <Note action={<button type="button" onClick={add}>添加资料</button>}>资料还不够，再加 4 份会开始整理。</Note>,
    );
    const note = container.querySelector("[data-note]");
    expect(note).toHaveTextContent("资料还不够，再加 4 份会开始整理。添加资料");
    await userEvent.click(screen.getByRole("button", { name: "添加资料" }));
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("is a conclusion whose numbers open what they count, in place or on a page", async () => {
    const look = vi.fn();
    const { container } = render(
      <MemoryRouter>
        <Note result={["记住了你的 ", { n: 48, to: "/app/memory" }, " 件事，其中 ", { n: 4, onOpen: look, label: "4 件，只看这些" }, " 件需要看一眼。"]} />
      </MemoryRouter>,
    );
    expect(container.querySelector("[data-note]")).toHaveTextContent("记住了你的 48 件事，其中 4 件需要看一眼。");
    expect(screen.getByRole("link", { name: "48" })).toHaveAttribute("href", "/app/memory");
    await userEvent.click(screen.getByRole("button", { name: "4 件，只看这些" }));
    expect(look).toHaveBeenCalledTimes(1);
  });

  it("draws a number with nothing to open as plain text, not as a control", () => {
    render(<Note result={[{ n: 12 }, " 项已核对。"]} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("has a held-up tone for a sentence that something is waiting on", () => {
    const { container } = render(<Note tone="warn" action={<button type="button">确认预算</button>}>有 3 项计算在等预算确认。</Note>);
    expect(container.querySelector("[data-note]")).toHaveClass("bg-warn-soft");
  });

  // The point of the component: a bare sentence is not a thing a page can write. `tsc` fails the build on an unused directive.
  it("does not compile as a bare sentence, or as a result without a number", () => {
    // @ts-expect-error a note carries an action or is a result
    const bare = <Note>一句孤零零的话。</Note>;
    // @ts-expect-error a result holds a number
    const noNumber = <Note result={["没有数字的结论。"]} />;
    expect(bare).toBeTruthy();
    expect(noNumber).toBeTruthy();
  });
});

describe("Headline", () => {
  it("is one sentence in which a number can be a link to the things counted", async () => {
    const open = vi.fn();
    const { container } = render(
      <MemoryRouter>
        <Headline parts={["EviMed 记住了你的 ", { n: 48, to: "/app/memory?tab=self" }, " 件事，其中 ", { n: 4, onOpen: open }, " 件需要看一眼。"]} />
      </MemoryRouter>,
    );
    expect(container.querySelector("[data-headline]")).toHaveTextContent("EviMed 记住了你的 48 件事，其中 4 件需要看一眼。");
    expect(screen.getByRole("link", { name: "48" })).toHaveAttribute("href", "/app/memory?tab=self");
    await userEvent.click(screen.getByRole("button", { name: "4" }));
    expect(open).toHaveBeenCalled();
  });

  it("may be a sentence without a number", () => {
    const { container } = render(<Headline parts={["还没有记住什么。"]} />);
    expect(container.querySelector("[data-headline]")).toHaveTextContent("还没有记住什么。");
  });
});
