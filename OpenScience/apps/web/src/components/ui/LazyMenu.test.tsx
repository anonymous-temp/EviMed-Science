import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// The menu behind a sidebar row loads after the row is drawn (LazyMenu.tsx):
// a click on the stand-in must not be lost, and a chunk that never arrives
// must not take the shell down with it.
describe("LazyMenu", () => {
  afterEach(() => {
    vi.doUnmock("@/components/ui/Menu");
    vi.resetModules();
  });

  it("opens the menu a click asked for before the menu's code arrived", async () => {
    vi.resetModules();
    const { LazyMenu } = await import("./LazyMenu");
    const onSelect = vi.fn();
    render(<LazyMenu label="“题目”的操作" items={[{ label: "重命名", onSelect }]} />);

    // The first render is the stand-in: the chunk is still in flight.
    const standIn = screen.getByRole("button", { name: "“题目”的操作" });
    expect(standIn).toHaveAttribute("aria-haspopup", "menu");
    expect(screen.queryByRole("menuitem")).toBeNull();
    await userEvent.click(standIn);

    await userEvent.click(await screen.findByRole("menuitem", { name: "重命名" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("leaves a disabled trigger, not a broken page, when the menu's code will not load", async () => {
    vi.resetModules();
    vi.doMock("@/components/ui/Menu", () => {
      throw new Error("Failed to fetch dynamically imported module: /assets/Menu-stale.js");
    });
    const { LazyMenu } = await import("./LazyMenu");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(
        <div>
          <p>侧栏其余部分</p>
          <LazyMenu label="“题目”的操作" items={[{ label: "重命名", onSelect: () => {} }]} />
        </div>,
      );
      await vi.waitFor(() => expect(screen.getByRole("button", { name: "“题目”的操作" })).toBeDisabled());
      expect(screen.getByText("侧栏其余部分")).toBeInTheDocument();
    } finally {
      quiet.mockRestore();
    }
  });
});
