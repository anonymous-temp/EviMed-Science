import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebReadinessCard } from "./WebReadinessCard";

const mocks = vi.hoisted(() => ({
  fetchWebReadiness: vi.fn(),
}));

vi.mock("@/lib/apiClient", () => ({
  fetchWebReadiness: mocks.fetchWebReadiness,
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

describe("WebReadinessCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders passing and failing deployment readiness checks", async () => {
    mocks.fetchWebReadiness.mockResolvedValue({
      ok: false,
      checks: {
        dataDir: { ok: true },
        publicUrl: { ok: false, code: "public_url_https_required" },
        auth: { ok: true, mode: "local", users: 2 },
        observability: { ok: true, mode: "protected", required: true },
        release: {
          ok: true,
          tracked: true,
          releaseId: "2026.07.10-release.1",
          appVersion: "0.1.3",
          revision: "1234567890ab",
        },
        resources: {
          ok: true,
          maxFileBytes: 52428800,
          maxProjectBytes: 1073741824,
          maxConcurrentTasks: 2,
          maxRuntimeProxyConnections: 64,
          runtimeQuotaCheckIntervalMs: 30000,
        },
        backup: {
          ok: true,
          mode: "local",
          retentionDays: 30,
          encrypted: true,
          restoreDrill: true,
        },
        runtime: {
          ok: true,
          mode: "opencode",
          sandboxMode: "docker",
          networkMode: "bridge",
          networkEgress: "explicitly_allowed",
          networkPolicy: "acknowledged",
        },
        kernel: { ok: true, mode: "disabled" },
        saasProfile: {
          ok: true,
          profile: "individual-saas",
          tenantModel: "individual-account",
          technicalSaas: true,
        },
      },
    });

    render(<WebReadinessCard />);

    expect(await screen.findByText("部署就绪检查")).toBeInTheDocument();
    expect(await screen.findByText("未就绪")).toBeInTheDocument();
    expect(screen.getByText("数据卷")).toBeInTheDocument();
    expect(screen.getByText("公开 URL")).toBeInTheDocument();
    expect(screen.getByText("资源限额")).toBeInTheDocument();
    expect(screen.getByText("可观测性")).toBeInTheDocument();
    expect(screen.getByText("发布溯源")).toBeInTheDocument();
    expect(screen.getByText("备份")).toBeInTheDocument();
    expect(screen.getByText("public_url_https_required")).toBeInTheDocument();
    expect(screen.getByText("local · 2 个用户")).toBeInTheDocument();
    expect(screen.getByText("protected · 必需")).toBeInTheDocument();
    expect(screen.getByText("2026.07.10-release.1 · v0.1.3 · 1234567890ab")).toBeInTheDocument();
    expect(screen.getByText("50 MiB 文件 · 1 GiB 项目 · 2 任务 · 64 代理 · 30s 配额检查")).toBeInTheDocument();
    expect(screen.getByText("local · 保留 30 天 · 已加密 · 恢复演练")).toBeInTheDocument();
    expect(screen.getByText("opencode · docker · bridge · explicitly_allowed · acknowledged")).toBeInTheDocument();
    expect(screen.getByText("SaaS Profile")).toBeInTheDocument();
    expect(screen.getByText("individual-saas · individual-account · SaaS 技术边界通过")).toBeInTheDocument();
    await waitFor(() => expect(mocks.fetchWebReadiness).toHaveBeenCalledTimes(1));
  });

  it("renders skipped readiness checks", async () => {
    mocks.fetchWebReadiness.mockResolvedValue({
      ok: true,
      checks: {
        staticDir: { ok: true, skipped: true },
      },
    });

    render(<WebReadinessCard />);

    expect(await screen.findByText("就绪")).toBeInTheDocument();
    expect(screen.getByText("静态资源")).toBeInTheDocument();
    expect(screen.getByText("已跳过")).toBeInTheDocument();
    expect(screen.getByText("未配置")).toBeInTheDocument();
  });
});
