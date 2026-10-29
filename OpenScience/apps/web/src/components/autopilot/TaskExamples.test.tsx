import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TaskExamples } from "./TaskExamples";
import { RECOMMENDATIONS } from "./taskPresentation";

describe("the examples in the list column", () => {
  it("are every template as a row, in order, each with a line of its instruction, and press fills nothing by themselves", async () => {
    const choose = vi.fn();
    render(<TaskExamples onChoose={choose} />);
    const group = screen.getByRole("region", { name: "从示例开始" });
    expect(within(group).getAllByRole("button").map(button => button.textContent)).toEqual(RECOMMENDATIONS.map(item => item.title));
    expect(group).toHaveTextContent(RECOMMENDATIONS[0].prompt);
    expect(within(group).getByRole("button", { name: RECOMMENDATIONS[2].title }).closest("li")).toHaveClass("hover:bg-surface-2");
    await userEvent.click(within(group).getByRole("button", { name: RECOMMENDATIONS[2].title }));
    expect(choose).toHaveBeenCalledWith(RECOMMENDATIONS[2]);
  });

  it("stand on the column's text edge when its title does (bleed), the rows' ground hanging 8 px outside, and as a group of their own otherwise", () => {
    const { container, rerender } = render(<TaskExamples bleed onChoose={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "从示例开始" })).not.toHaveClass("px-2");
    expect(container.querySelector("section > .-mx-2 ul")).not.toBeNull();
    rerender(<TaskExamples onChoose={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "从示例开始" })).toHaveClass("px-2");
    expect(container.querySelector(".-mx-2")).toBeNull();
  });

  it("mark the one the form was started from, and are pressed by nobody while the form is saving", async () => {
    const choose = vi.fn();
    const view = render(<TaskExamples selectedId={RECOMMENDATIONS[1].id} onChoose={choose} />);
    expect(screen.getByRole("button", { name: RECOMMENDATIONS[1].title })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: RECOMMENDATIONS[1].title }).closest("li")).toHaveClass("bg-accent-soft");
    expect(screen.getByRole("button", { name: RECOMMENDATIONS[0].title })).not.toHaveAttribute("aria-current");
    view.rerender(<TaskExamples selectedId={RECOMMENDATIONS[1].id} locked onChoose={choose} />);
    expect(screen.getByRole("button", { name: RECOMMENDATIONS[0].title })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: RECOMMENDATIONS[0].title }));
    expect(choose).not.toHaveBeenCalled();
  });
});
