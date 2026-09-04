import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotebookEditor } from "./NotebookEditor";

const mocks = vi.hoisted(() => ({
  kernelExecute: vi.fn(),
  kernelReset: vi.fn(),
  invokeCommand: vi.fn(),
  notebook: "",
}));

const NOTEBOOK = JSON.stringify({
  cells: [{ cell_type: "code", source: ["print(1)"], outputs: [] }],
  metadata: { kernelspec: { name: "python3", language: "python" } },
  nbformat: 4,
  nbformat_minor: 5,
});

vi.mock("@/lib/apiClient", () => ({
  hasWebApi: true,
  invokeCommand: (...args: unknown[]) => mocks.invokeCommand(...args),
}));
vi.mock("@/lib/artifactFile", () => ({
  readArtifact: async () => ({ encoding: "utf8", data: mocks.notebook }),
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

describe("NotebookEditor hosted web mode", () => {
  beforeEach(() => {
    mocks.notebook = NOTEBOOK;
    mocks.kernelExecute.mockReset();
    mocks.kernelExecute.mockResolvedValue({ ok: true, stdout: "1\n" });
    mocks.kernelReset.mockReset();
    mocks.invokeCommand.mockReset();
  });

  it("runs Python cells through the hosted command backend", async () => {
    render(<NotebookEditor path="analysis.ipynb" />);

    const cell = await screen.findByLabelText("单元格 1");
    expect(screen.getByText(/服务端隔离内核/)).toBeInTheDocument();
    expect(screen.getByLabelText("运行单元格 1")).toBeInTheDocument();
    fireEvent.keyDown(cell, { key: "Enter", shiftKey: true });
    await waitFor(() =>
      expect(mocks.kernelExecute).toHaveBeenCalledWith("print(1)", "python", "analysis.ipynb", undefined),
    );
    expect(await screen.findByText("1")).toBeInTheDocument();
  });

  it("runs R cells through the hosted command backend", async () => {
    mocks.notebook = JSON.stringify({
      cells: [{ cell_type: "code", source: ["mean(c(1,2,3))"], outputs: [] }],
      metadata: { kernelspec: { name: "ir", language: "R" } },
      nbformat: 4,
      nbformat_minor: 5,
    });
    mocks.kernelExecute.mockResolvedValue({ ok: true, stdout: "2\n" });
    render(<NotebookEditor path="analysis-r.ipynb" />);

    const cell = await screen.findByLabelText("单元格 1");
    expect(screen.getByLabelText("运行单元格 1")).toBeInTheDocument();
    fireEvent.keyDown(cell, { key: "Enter", shiftKey: true });
    await waitFor(() =>
      expect(mocks.kernelExecute).toHaveBeenCalledWith("mean(c(1,2,3))", "r", "analysis-r.ipynb", undefined),
    );
    expect(await screen.findByText("2")).toBeInTheDocument();
  });

  it("stops an in-flight hosted cell through kernel_reset", async () => {
    let finish: (value: { ok: boolean; stderr: string }) => void = () => {};
    mocks.kernelExecute.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    mocks.kernelReset.mockImplementation(async () => finish({ ok: false, stderr: "Execution was aborted." }));

    render(<NotebookEditor path="analysis.ipynb" />);
    fireEvent.click(await screen.findByLabelText("运行单元格 1"));
    fireEvent.click(await screen.findByLabelText("停止单元格 1"));

    expect(mocks.kernelReset).toHaveBeenCalledWith("python", "analysis.ipynb", undefined);
    expect(await screen.findByText(/服务端隔离执行已停止/)).toBeInTheDocument();
  });
});
