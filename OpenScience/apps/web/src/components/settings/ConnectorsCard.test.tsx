import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorsCard } from "./ConnectorsCard";

const mocks = vi.hoisted(() => ({
  fetchWebConnectors: vi.fn(),
  saveWebConnectorCredential: vi.fn(),
  removeWebConnectorCredential: vi.fn(),
}));

vi.mock("@/lib/apiClient", () => ({
  fetchWebConnectors: mocks.fetchWebConnectors,
  saveWebConnectorCredential: mocks.saveWebConnectorCredential,
  removeWebConnectorCredential: mocks.removeWebConnectorCredential,
}));

const connector = (overrides: Partial<import("@/lib/apiClient").WebConnector>) => ({
  id: "opengwas",
  title: "OpenGWAS",
  kind: "jwt" as const,
  unlocks: "孟德尔随机化所需的 GWAS 汇总数据。",
  obtainUrl: "https://api.opengwas.io/profile/",
  capabilities: ["mendelian-randomization"],
  keyless: false,
  validityDays: 14,
  source: "none" as const,
  own: null,
  needsAttention: true,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchWebConnectors.mockResolvedValue([
    connector({}),
    connector({ id: "umls", title: "UMLS", kind: "api-key", unlocks: "术语归一化。", source: "deployment", needsAttention: false }),
    connector({ id: "ncbi", title: "NCBI", kind: "api-key", unlocks: "更高配额。", keyless: true, needsAttention: false }),
  ]);
});

describe("ConnectorsCard", () => {
  it("reports a source per connector and offers an input only where the deployment has none", async () => {
    render(<ConnectorsCard />);
    expect(await screen.findByText("OpenGWAS")).toBeInTheDocument();
    expect(screen.getByText(/1 个数据源本部署没有配置凭据/)).toBeInTheDocument();
    expect(screen.getByText("未配置")).toBeInTheDocument();
    expect(screen.getByText("平台已配置")).toBeInTheDocument();
    expect(screen.getByText("无需凭据")).toBeInTheDocument();
    // The deployment-served source takes nothing from the researcher.
    expect(screen.queryByLabelText("UMLS 凭据")).not.toBeInTheDocument();
    expect(screen.getByLabelText("OpenGWAS 凭据")).toHaveAttribute("type", "password");
    expect(screen.getByRole("link", { name: "获取 OpenGWAS 凭据" })).toHaveAttribute("href", "https://api.opengwas.io/profile/");
  });

  it("saves a pasted credential, clears the field, and never shows it again", async () => {
    mocks.saveWebConnectorCredential.mockResolvedValue({ expiresAt: "2026-09-23T00:00:00.000Z" });
    render(<ConnectorsCard />);
    const field = await screen.findByLabelText("OpenGWAS 凭据");
    await userEvent.type(field, "eyJ.abc.def");
    await userEvent.click(screen.getByRole("button", { name: "保存 OpenGWAS 凭据" }));
    await waitFor(() => expect(mocks.saveWebConnectorCredential).toHaveBeenCalledWith("opengwas", "eyJ.abc.def"));
    await waitFor(() => expect(field).toHaveValue(""));
    expect(mocks.fetchWebConnectors).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain("eyJ.abc.def");
  });

  it("lets the researcher remove their own credential", async () => {
    mocks.fetchWebConnectors.mockResolvedValue([
      connector({ source: "user", own: { updatedAt: "2026-09-09T00:00:00.000Z", expiresAt: "2026-09-23T00:00:00.000Z", expired: false }, needsAttention: false }),
    ]);
    mocks.removeWebConnectorCredential.mockResolvedValue(undefined);
    render(<ConnectorsCard />);
    expect(await screen.findByText("已用你的凭据")).toBeInTheDocument();
    expect(screen.getByText(/有效期至/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "移除 OpenGWAS 凭据" }));
    await waitFor(() => expect(mocks.removeWebConnectorCredential).toHaveBeenCalledWith("opengwas"));
  });

  it("says when the store is unavailable rather than showing an empty list", async () => {
    mocks.fetchWebConnectors.mockRejectedValue(new Error("Connector credentials are not available on this deployment."));
    render(<ConnectorsCard />);
    expect(await screen.findByText(/读取数据源状态失败/)).toBeInTheDocument();
  });
});
