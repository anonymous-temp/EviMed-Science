import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

    expect(await screen.findByText("托管资源")).toBeInTheDocument();
    expect(await screen.findByText("256 KB / 1 MB")).toBeInTheDocument();
    expect(screen.getByText("已用 25%")).toBeInTheDocument();
    expect(screen.getByText("2 个进行中")).toBeInTheDocument();
    expect(screen.getByText("运行中")).toBeInTheDocument();
    expect(screen.getByText("64 MB")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "启动托管运行时" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重启托管运行时" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "停止托管运行时" })).not.toBeDisabled();
    await waitFor(() => expect(mocks.fetchWebMetrics).toHaveBeenCalledTimes(1));
  });

  it("starts a stopped hosted runtime and refreshes what it reports", async () => {
    mocks.fetchWebMetrics
      .mockResolvedValueOnce(metricsFixture({ running: false }))
      .mockResolvedValueOnce(metricsFixture({ running: true }));

    render(<WebResourcesCard />);

    expect(await screen.findByText("已停止")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "启动托管运行时" }));

    await waitFor(() => expect(mocks.startWebRuntime).toHaveBeenCalledTimes(1));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("托管运行时已启动。");
    await waitFor(() => expect(mocks.fetchWebMetrics).toHaveBeenCalledTimes(2));
  });

  it("restarts and stops a running hosted runtime", async () => {
    mocks.fetchWebMetrics
      .mockResolvedValueOnce(metricsFixture({ running: true }))
      .mockResolvedValueOnce(metricsFixture({ running: true }))
      .mockResolvedValueOnce(metricsFixture({ running: false }));

    render(<WebResourcesCard />);

    expect(await screen.findByText("运行中")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重启托管运行时" }));

    await waitFor(() => expect(mocks.restartWebRuntime).toHaveBeenCalledTimes(1));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("托管运行时已重启。");

    fireEvent.click(screen.getByRole("button", { name: "停止托管运行时" }));

    await waitFor(() => expect(mocks.stopWebRuntime).toHaveBeenCalledTimes(1));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("托管运行时已停止。");
    await waitFor(() => expect(mocks.fetchWebMetrics).toHaveBeenCalledTimes(3));
  });
});

function metricsFixture({ running }: { running: boolean }) {
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
        queued: 1,
        running: 1,
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
    },
  };
}
