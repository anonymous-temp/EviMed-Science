import fs from "node:fs";
import path from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

/** The server's own word for a row lives in its tooltip, hidden until the pointer or the keyboard asks: never in the row. */
function codeOnlyInTooltip(code: string) {
  const places = screen.getAllByText(code);
  expect(places.every((place) => place.getAttribute("role") === "tooltip")).toBe(true);
  for (const place of places) expect(place).not.toBeVisible();
}

/** The page as a reader has it: tooltips (hidden descriptions) taken out. */
function visibleText() {
  const copy = document.body.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[role="tooltip"]').forEach((node) => node.remove());
  return copy.textContent ?? "";
}

describe("WebReadinessCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("says it checks configuration and not whether research works, failed rows first and what passed folded", async () => {
    mocks.fetchWebReadiness.mockResolvedValue({
      ok: false,
      checks: {
        dataDir: { ok: true },
        publicUrl: { ok: false, code: "public_url_https_required" },
        auth: { ok: true, mode: "local", users: 2 },
        observability: { ok: true, mode: "protected", required: true },
        release: { ok: true, tracked: true, releaseId: "2026.07.10-release.1", appVersion: "0.1.3", revision: "1234567890ab" },
        resources: {
          ok: true, maxFileBytes: 52428800, maxProjectBytes: 1073741824, maxConcurrentTasks: 2, maxRuntimeProxyConnections: 64, runtimeQuotaCheckIntervalMs: 30000,
        },
        backup: { ok: true, mode: "local", retentionDays: 30, encrypted: true, restoreDrill: true },
        runtime: { ok: true, mode: "kernel", sandboxMode: "docker", networkMode: "bridge", networkEgress: "explicitly_allowed", networkPolicy: "acknowledged" },
        saasProfile: { ok: true, profile: "individual-saas", tenantModel: "individual-account", technicalSaas: true },
      },
    });

    render(<WebReadinessCard />);

    expect(await screen.findByText("部署配置检查")).toBeInTheDocument();
    expect(screen.getByText("只检查配置和依赖服务，不代表当前研究能用")).toBeInTheDocument();
    expect(screen.getByText("需要关注")).toBeInTheDocument();
    // The word 「就绪」 alone claimed more than a configuration check knows.
    expect(screen.queryByText(/就绪/)).not.toBeInTheDocument();
    // The failed one is in view, in the registry's Chinese, with the server's code only in a tooltip.
    expect(screen.getByText("公开 URL")).toBeInTheDocument();
    expect(screen.getByText("失败")).toBeInTheDocument();
    expect(screen.getByText("公开网址必须使用 https。")).toBeInTheDocument();
    codeOnlyInTooltip("public_url_https_required");
    // What passed is folded under one line, and says it in numbers and words — not in the configuration's enum values.
    const folded = screen.getByText("已通过 8 项");
    const passed = folded.closest("details")!;
    expect(passed).not.toHaveAttribute("open");
    await userEvent.click(folded);
    expect(within(passed).getByText("2 个用户")).toBeInTheDocument();
    expect(within(passed).getByText("必需")).toBeInTheDocument();
    expect(within(passed).getByText("v0.1.3 · 2026.07.10-release.1")).toBeInTheDocument();
    expect(within(passed).getByText("50 MB 文件 · 1 GB 项目 · 2 任务 · 64 代理 · 30s 配额检查")).toBeInTheDocument();
    expect(within(passed).getByText("保留 30 天 · 已加密 · 恢复演练")).toBeInTheDocument();
    expect(within(passed).getByText("SaaS 技术边界通过")).toBeInTheDocument();
    for (const label of ["数据卷", "资源限额", "可观测性", "发布溯源", "备份", "SaaS 配置档", "运行时沙箱", "身份认证"]) {
      expect(within(passed).getByText(label)).toBeInTheDocument();
    }
    expect(visibleText()).not.toMatch(/explicitly_allowed|individual-saas|kernel|[a-z]+_[a-z_]+/);
    await waitFor(() => expect(mocks.fetchWebReadiness).toHaveBeenCalledTimes(1));
  });

  it("names the warning of a check that passes degraded, in words, as something to look at", async () => {
    // Audit I3-4: OpenList answering with no storage mounted is a green check with `warning: openlist_storage_missing`;
    // the row used to print that code beside a green tick.
    mocks.fetchWebReadiness.mockResolvedValue({
      ok: true,
      checks: {
        openList: { ok: true, required: true, state: "degraded", storage: "missing", namespaces: 0, warning: "openlist_storage_missing" },
        geo: { ok: true, required: true, enabled: true, warning: "geo_market_unconfigured", warnings: ["geo_market_unconfigured"] },
        dataDir: { ok: true },
      },
    });

    render(<WebReadinessCard />);

    expect(await screen.findByText("网盘接入")).toBeInTheDocument();
    expect(screen.getAllByText("需要留意")).toHaveLength(2);
    expect(screen.getByText("这个账户还没有接入网盘，无法从网盘导入。可以先直接上传文件。")).toBeInTheDocument();
    expect(screen.getByText("循证 GEO 没有配置媒体采买服务，下单这一步暂时用不了；其余步骤照常。")).toBeInTheDocument();
    codeOnlyInTooltip("openlist_storage_missing");
    codeOnlyInTooltip("geo_market_unconfigured");
    expect(visibleText()).not.toMatch(/[a-z]+_[a-z_]+/);
    // A deployment with a note is not one that passed clean.
    expect(screen.getByText("需要关注")).toBeInTheDocument();
    expect(screen.queryByText("配置通过")).not.toBeInTheDocument();
  });

  it("puts a code the registry has no sentence for into a plain one, and the code into the tooltip", async () => {
    mocks.fetchWebReadiness.mockResolvedValue({
      ok: false,
      checks: {
        backup: { ok: false, code: "backup_from_the_future" },
        jev: { ok: true, warning: "something_new_happened" },
      },
    });
    render(<WebReadinessCard />);
    expect(await screen.findByText("检查没有通过，详情见日志")).toBeInTheDocument();
    expect(screen.getByText("有提示，详情见日志")).toBeInTheDocument();
    codeOnlyInTooltip("backup_from_the_future");
    codeOnlyInTooltip("something_new_happened");
    expect(visibleText()).not.toMatch(/[a-z]+_[a-z_]+/);
    await userEvent.hover(screen.getByText("检查没有通过，详情见日志"));
    await waitFor(() => expect(screen.getByText("backup_from_the_future")).toBeVisible());
  });

  it("shows a clean deployment as 配置通过 with a folded list, and what it does not run as 未启用", async () => {
    mocks.fetchWebReadiness.mockResolvedValue({
      ok: true,
      checks: {
        staticDir: { ok: true, skipped: true },
        documentParser: { ok: true, required: false, configured: false },
        dataDir: { ok: true },
        stateStore: { ok: true, mode: "postgres", required: true },
      },
    });

    render(<WebReadinessCard />);

    expect(await screen.findByText("配置通过")).toBeInTheDocument();
    expect(screen.getAllByText("未启用")).toHaveLength(2);
    expect(screen.getByText("静态资源")).toBeInTheDocument();
    expect(screen.getByText("文档解析")).toBeInTheDocument();
    expect(screen.getByText("已通过 2 项")).toBeInTheDocument();
    expect(screen.queryByText("已跳过")).not.toBeInTheDocument();
    expect(screen.queryByText("未配置")).not.toBeInTheDocument();
  });

  it("has a name for every check the server reports, so none prints its own camelCase key", async () => {
    const server = fs.readFileSync(path.resolve(__dirname, "../../../../server/src/server.mjs"), "utf8");
    const body = server.slice(server.indexOf("async function readinessStatus("));
    const block = body.slice(body.indexOf("const checks = {"), body.indexOf("checks.saasProfile"));
    const keys = [...block.matchAll(/^ {4}([a-zA-Z]+):/gm)].map((match) => match[1]);
    // A walk that finds nothing passes forever.
    expect(keys.length).toBeGreaterThan(20);
    mocks.fetchWebReadiness.mockResolvedValue({ ok: false, checks: Object.fromEntries([...keys, "saasProfile"].map((key) => [key, { ok: false, code: "x_y" }])) });
    render(<WebReadinessCard />);
    await screen.findByText("需要关注");
    for (const key of keys) expect(visibleText(), `${key} has no label`).not.toContain(key);
  });
});
