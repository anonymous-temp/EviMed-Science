import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactBlock } from "@ai4s/shared";
import { ArtifactCard } from "./ArtifactCard";

const block: ArtifactBlock = {
  kind: "artifact",
  artifact: "figure",
  path: "outputs/km_curve.png",
  filename: "km_curve.png",
  tool: "run_python",
};

describe("ArtifactCard", () => {
  it("opens via click and via Enter/Space on the focused card", async () => {
    const onOpen = vi.fn();
    render(<ArtifactCard block={block} onOpen={onOpen} />);
    const card = screen.getByRole("button");

    await userEvent.click(card);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenLastCalledWith(block);

    card.focus();
    await userEvent.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledTimes(2);

    await userEvent.keyboard(" ");
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it("is a plain row without an onOpen handler", () => {
    render(<ArtifactCard block={block} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("km_curve.png")).toBeInTheDocument();
  });
});
