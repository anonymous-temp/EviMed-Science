// A hung cell must be stoppable from the UI (P0-7 acceptance: a
// `while True: pass` cell can be reset without restarting the app).
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotebookEditor } from "./NotebookEditor";

const mocks = vi.hoisted(() => ({
  kernelExecute: vi.fn(),
  kernelReset: vi.fn(),
}));

const NOTEBOOK = JSON.stringify({
  cells: [{ cell_type: "code", source: ["while True: pass"], outputs: [] }],
  metadata: { kernelspec: { name: "python3", language: "python" } },
  nbformat: 4,
  nbformat_minor: 5,
});

vi.mock("@/lib/artifactFile", () => ({
  readArtifact: async () => ({ encoding: "utf8", data: NOTEBOOK }),
  writeWorkspaceFile: async () => {},
}));
vi.mock("@/lib/kernel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/kernel")>();
  return {
    ...actual,
    kernelExecute: (...args: unknown[]) => mocks.kernelExecute(...args),
    kernelReset: (...args: unknown[]) => mocks.kernelReset(...args),
  };
});
vi.mock("@/components/inspector/ProvenancePanel", () => ({
  ProvenancePanel: () => null,
}));

describe("NotebookEditor · stopping a hung cell", () => {
  beforeEach(() => {
    mocks.kernelExecute.mockReset();
    mocks.kernelReset.mockReset();
  });

  it("a running cell shows Stop; clicking it resets the kernel and marks the cell interrupted", async () => {
    // The cell hangs until the kernel is killed — exactly the real backend
    // contract: kernel_reset makes the blocked execute fail with an error.
    let rejectExec: (e: Error) => void = () => {};
    mocks.kernelExecute.mockImplementation(
      () => new Promise((_, reject) => (rejectExec = reject)),
    );
    mocks.kernelReset.mockImplementation(async () => {
      rejectExec(new Error("kernel exited unexpectedly"));
    });

    render(<NotebookEditor path="analysis.ipynb" />);
    await userEvent.click(await screen.findByLabelText("运行单元格 1"));

    // While running, the cell offers Stop (and it is clickable).
    const stop = await screen.findByLabelText("停止单元格 1");
    await userEvent.click(stop);

    // Stop resets exactly THIS notebook's kernel…
    expect(mocks.kernelReset).toHaveBeenCalledWith("python", "analysis.ipynb", undefined);
    // …and the cell reports the interruption, not a raw kernel error.
    expect(await screen.findByText(/已中断——内核已重启/)).toBeInTheDocument();
    // The cell is runnable again.
    expect(await screen.findByLabelText("运行单元格 1")).toBeInTheDocument();
  });

  it("a genuine kernel crash still reports the error, not an interruption", async () => {
    mocks.kernelExecute.mockRejectedValue(new Error("kernel exited unexpectedly"));
    render(<NotebookEditor path="analysis.ipynb" />);
    await userEvent.click(await screen.findByLabelText("运行单元格 1"));
    expect(await screen.findByText(/内核错误：kernel exited unexpectedly/)).toBeInTheDocument();
  });

  it("reports a missing kernel backend without desktop-only wording", async () => {
    mocks.kernelExecute.mockResolvedValue(null);
    render(<NotebookEditor path="analysis.ipynb" />);
    await userEvent.click(await screen.findByLabelText("运行单元格 1"));
    expect(await screen.findByText(/未配置计算内核/)).toBeInTheDocument();
    expect(screen.queryByText(/desktop app/)).not.toBeInTheDocument();
  });
});
