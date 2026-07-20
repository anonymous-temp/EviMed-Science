import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotebookInspector as NotebookInspectorT } from "@ai4s/shared";
import { NotebookInspector } from "./NotebookInspector";

const mocks = vi.hoisted(() => ({
  kernelExecute: vi.fn(),
  kernelReset: vi.fn(),
  invokeCommand: vi.fn(),
}));

vi.mock("@/lib/apiClient", () => ({
  hasWebApi: true,
  hasCommandBackend: true,
  isTauri: false,
  invokeCommand: (...args: unknown[]) => mocks.invokeCommand(...args),
}));
vi.mock("@/lib/kernel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/kernel")>();
  return {
    ...actual,
    kernelExecute: (...args: unknown[]) => mocks.kernelExecute(...args),
    kernelReset: (...args: unknown[]) => mocks.kernelReset(...args),
  };
});

const data: NotebookInspectorT = {
  variant: "notebook",
  name: "analysis.ipynb",
  live: true,
  kernelLabel: "Python",
  kernelNote: "Server-managed notebook execution",
  cells: [],
};

describe("NotebookInspector hosted web mode", () => {
  beforeEach(() => {
    mocks.kernelExecute.mockReset();
    mocks.kernelExecute.mockResolvedValue({ ok: true, stdout: "42\n" });
    mocks.kernelReset.mockReset();
  });

  it("executes expressions in the hosted Python kernel", async () => {
    render(<NotebookInspector data={data} onClose={() => {}} />);

    fireEvent.change(screen.getByRole("textbox", { name: "计算表达式" }), { target: { value: "6 * 7" } });
    fireEvent.click(screen.getByRole("button", { name: "运行表达式" }));

    expect(mocks.kernelExecute).toHaveBeenCalledWith("6 * 7");
    expect(await screen.findByText("42")).toBeInTheDocument();
  });

  it("stops an in-flight hosted expression", async () => {
    let finish: (value: { ok: boolean; stderr: string }) => void = () => {};
    mocks.kernelExecute.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    mocks.kernelReset.mockImplementation(async () => finish({ ok: false, stderr: "Execution was aborted." }));
    render(<NotebookInspector data={data} onClose={() => {}} />);

    fireEvent.change(screen.getByRole("textbox", { name: "计算表达式" }), { target: { value: "while True: pass" } });
    fireEvent.click(screen.getByRole("button", { name: "运行表达式" }));
    fireEvent.click(await screen.findByRole("button", { name: "停止计算" }));

    expect(mocks.kernelReset).toHaveBeenCalledWith("python");
    expect(await screen.findByText(/隔离执行已停止/)).toBeInTheDocument();
  });
});
