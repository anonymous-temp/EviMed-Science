import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotebookInspector as NotebookInspectorT } from "@ai4s/shared";
import { NotebookInspector } from "./NotebookInspector";

const mocks = vi.hoisted(() => ({
  kernelExecute: vi.fn(),
}));

vi.mock("@/lib/kernel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/kernel")>();
  return {
    ...actual,
    kernelExecute: (...args: unknown[]) => mocks.kernelExecute(...args),
  };
});

const data: NotebookInspectorT = {
  variant: "notebook",
  name: "analysis.ipynb",
  live: true,
  kernelLabel: "Python",
  kernelNote: "Shared kernel",
  cells: [],
};

describe("NotebookInspector", () => {
  beforeEach(() => {
    mocks.kernelExecute.mockReset();
  });

  it("reports a missing kernel backend without desktop-only wording", async () => {
    mocks.kernelExecute.mockResolvedValue(null);
    render(<NotebookInspector data={data} onClose={() => {}} />);

    await userEvent.type(screen.getByRole("textbox", { name: "计算表达式" }), "1 + 1");
    await userEvent.click(screen.getByRole("button", { name: "运行表达式" }));

    expect(await screen.findByText(/未配置计算内核/)).toBeInTheDocument();
    expect(screen.queryByText(/desktop app/)).not.toBeInTheDocument();
  });

  it("renders hosted kernel stderr output", async () => {
    mocks.kernelExecute.mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "Traceback\nboom\n",
      artifacts: [],
    });
    render(<NotebookInspector data={data} onClose={() => {}} />);

    await userEvent.type(screen.getByRole("textbox", { name: "计算表达式" }), "raise");
    await userEvent.click(screen.getByRole("button", { name: "运行表达式" }));

    expect(await screen.findByText(/Traceback/)).toBeInTheDocument();
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });
});
