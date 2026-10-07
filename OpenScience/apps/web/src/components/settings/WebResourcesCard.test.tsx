import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebResourcesCard } from "./WebResourcesCard";

const mocks = vi.hoisted(() => ({
  fetchWebMetrics: vi.fn(),
  startWebRuntime: vi.fn(),
  restartWebRuntime: vi.fn(),
  stopWebRuntime: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/apiClient", () => ({
  fetchWebMetrics: mocks.fetchWebMetrics,
  startWebRuntime: mocks.startWebRuntime,
  restartWebRuntime: mocks.restartWebRuntime,
  stopWebRuntime: mocks.stopWebRuntime,
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: mocks.toastSuccess },
}));

describe("WebResourcesCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startWebRuntime.mockResolvedValue("https://science.example/api/runtime");
    mocks.restartWebRuntime.mockResolvedValue("https://science.example/api/runtime");
    mocks.stopWebRuntime.mockResolvedValue(undefined);
  });

  it("renders hosted resource metrics", async () => {
    mocks.fetchWebMetrics.mockResolvedValue(metricsFixture({ running: true }));

    render(<WebResourcesCard />);

    expect(await screen.findByText("运行状况")).toBeInTheDocument();
    expect(await screen.findByText("256 KB / 1 MB")).toBeInTheDocument();
    expect(screen.getByText("已用 25%")).toBeInTheDocument();
    expect(screen.getByText("2 个进行中")).toBeInTheDocument();
    expect(screen.getByText("运行中")).toBeInTheDocument();
    expect(screen.getByText("64 MB")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "启动研究运行时" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重启研究运行时" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "停止研究运行时" })).not.toBeDisabled();
    await waitFor(() => expect(mocks.fetchWebMetrics).toHaveBeenCalledTimes(1));
  });

  it("calls a runtime 失联 only when tasks are waiting on it — and says how many", async () => {
    mocks.fetchWebMetrics.mockResolvedValue(metricsFixture({ running: false, stale: true, queued: 2, running_tasks: 1 }));
    render(<WebResourcesCard />);
    const tile = (await screen.findByText("失联")).closest("div.rounded-input") as HTMLElement;
    expect(within(tile).getByText("有 3 个任务在等它")).toBeInTheDocument();
    // It is the one tile in the warn tone.
    expect(tile).toHaveClass("border-warn");
    expect(screen.queryByText(/已停止/)).not.toBeInTheDocument();
  });

  it("reads a runtime that exited with nothing waiting as stopped, and says it starts again by itself", async () => {
    mocks.fetchWebMetrics.mockResolvedValue(metricsFixture({ running: false, stale: true, queued: 0, running_tasks: 0 }));
    render(<WebResourcesCard />);
    const tile = (await screen.findByText("已停止")).closest("div.rounded-input") as HTMLElement;
    expect(within(tile).getByText("意外退出，下次打开任务会自动启动")).toBeInTheDocument();
    expect(tile).not.toHaveClass("border-warn");
    expect(screen.queryByText("失联")).not.toBeInTheDocument();
  });

  it("reads a runtime that is simply not up as stopped, started when it is used", async () => {
    mocks.fetchWebMetrics.mockResolvedValue(metricsFixture({ running: false }));
    render(<WebResourcesCard />);
    expect(await screen.findByText("用到时自动启动")).toBeInTheDocument();
    expect(screen.queryByText("失联")).not.toBeInTheDocument();
  });

  it("starts a stopped hosted runtime and refreshes what it reports", async () => {
    mocks.fetchWebMetrics
      .mockResolvedValueOnce(metricsFixture({ running: false }))
      .mockResolvedValueOnce(metricsFixture({ running: true }));

    render(<WebResourcesCard />);

    expect(await screen.findByText("已停止")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "启动研究运行时" }));

    await waitFor(() => expect(mocks.startWebRuntime).toHaveBeenCalledTimes(1));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("研究运行时已启动。");
    await waitFor(() => expect(mocks.fetchWebMetrics).toHaveBeenCalledTimes(2));
  });

  it("restarts and stops a running hosted runtime, each only after a confirmation", async () => {
    mocks.fetchWebMetrics
      .mockResolvedValueOnce(metricsFixture({ running: true }))
      .mockResolvedValueOnce(metricsFixture({ running: true }))
      .mockResolvedValueOnce(metricsFixture({ running: false }));

    render(<WebResourcesCard />);

    expect(await screen.findByText("运行中")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重启研究运行时" }));
    // One click used to end a running analysis. It asks first now.
    expect(mocks.restartWebRuntime).not.toHaveBeenCalled();
    const restart = screen.getByRole("alertdialog", { name: "重启研究运行时？" });
    expect(restart).toHaveTextContent("正在进行的研究会立即中断");
    fireEvent.click(screen.getByRole("button", { name: "重启运行时" }));

    await waitFor(() => expect(mocks.restartWebRuntime).toHaveBeenCalledTimes(1));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("研究运行时已重启。");

    fireEvent.click(screen.getByRole("button", { name: "停止研究运行时" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(mocks.stopWebRuntime).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "停止研究运行时" }));
    fireEvent.click(screen.getByRole("button", { name: "停止运行时" }));

    await waitFor(() => expect(mocks.stopWebRuntime).toHaveBeenCalledTimes(1));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("研究运行时已停止。");
    await waitFor(() => expect(mocks.fetchWebMetrics).toHaveBeenCalledTimes(3));
  });
});

function metricsFixture({ running, stale = false, queued = 1, running_tasks = 1 }: { running: boolean; stale?: boolean; queued?: number; running_tasks?: number }) {
  return {
    createdAt: "2026-01-01T12:00:00.000Z",
    server: {
      pid: 123,
      uptimeSeconds: 60,
      memory: {
        rssBytes: 64 * 1024 * 1024,
        heapUsedBytes: 16 * 1024 * 1024,
        heapTotalBytes: 32 * 1024 * 1024,
        externalBytes: 1024,
      },
      cpu: { userMicros: 100, systemMicros: 50 },
      loadAverage: [0.1, 0.2, 0.3],
    },
    project: {
      id: "paper1",
      name: "Paper 1",
      storage: { usedBytes: 256 * 1024, maxBytes: 1024 * 1024 },
    },
    tasks: {
      total: 3,
      active: 1,
      queued: 1,
      byStatus: {
        queued,
        running: running_tasks,
        canceling: 0,
        succeeded: 1,
        failed: 0,
        canceled: 0,
        timed_out: 0,
      },
    },
    runtime: {
      running,
      kind: running ? "mock" : null,
      startedAt: running ? "2026-01-01T12:00:00.000Z" : null,
      pid: null,
      exitedAt: running ? null : "2026-01-01T12:05:00.000Z",
      sandboxMode: running ? "mock" : null,
      networkMode: null,
      containerName: null,
      ...(stale ? { stale: true } : {}),
    },
  };
}
