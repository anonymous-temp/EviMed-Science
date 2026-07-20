import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactInspector as ArtifactInspectorT } from "@ai4s/shared";
import { ArtifactInspector } from "./ArtifactInspector";

const data: ArtifactInspectorT = {
  variant: "artifact",
  title: "atlas_fig1a.png",
  versions: [{ label: "v1" }, { label: "v2" }],
  activeVersion: "v2",
  reviewPassed: true,
  inputs: ["a.csv"],
  language: "python",
  code: "print('hi')",
  executionLog: "log line one",
  environment: "python 3.11",
  messages: ["a message"],
};

describe("ArtifactInspector", () => {
  it("shows the Code tab by default and switches tabs", async () => {
    render(<ArtifactInspector data={data} onClose={() => {}} />);
    expect(screen.getByText("下载脚本")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "执行记录" }));
    expect(screen.getByText("log line one")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /核查/ }));
    expect(screen.getByText(/核查通过/)).toBeInTheDocument();
  });

  it("fires onClose from the close button", async () => {
    const onClose = vi.fn();
    render(<ArtifactInspector data={data} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
