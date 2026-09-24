import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebConnector } from "@/lib/apiClient";
import { ConnectorsSection } from "./ConnectorsSection";

const mocks = vi.hoisted(() => ({
  fetchWebConnectors: vi.fn(),
  saveWebConnectorCredential: vi.fn(),
  removeWebConnectorCredential: vi.fn(),
}));

// The error dictionary (`webErrorMessage`) lives in this module and the code
// under test calls it, so the real exports come through and only the calls
// this test drives are replaced.
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  fetchWebConnectors: mocks.fetchWebConnectors,
  saveWebConnectorCredential: mocks.saveWebConnectorCredential,
  removeWebConnectorCredential: mocks.removeWebConnectorCredential,
}));

const connector = (overrides: Partial<WebConnector>): WebConnector => ({
  id: "opengwas",
  title: "OpenGWAS",
  kind: "jwt",
  unlocks: "孟德尔随机化所需的 GWAS 汇总数据（IEU OpenGWAS）。",
  obtainUrl: "https://api.opengwas.io/profile/",
  capabilities: ["mendelian-randomization"],
  keyless: false,
  validityDays: 14,
  source: "none",
  own: null,
  needsAttention: true,
  ...overrides,
} as WebConnector);

const catalogue = () => [
  connector({}),
  connector({ id: "semantic-scholar", title: "Semantic Scholar", kind: "api-key", unlocks: "文献检索。", capabilities: [], keyless: true, needsAttention: false }),
  connector({ id: "unpaywall", title: "Unpaywall", kind: "email", unlocks: "开放获取全文。", capabilities: [], source: "deployment", needsAttention: false }),
  connector({ id: "core", title: "CORE", kind: "api-key", unlocks: "开放获取全文的检索与下载。", capabilities: [] }),
  connector({ id: "umls", title: "UMLS", kind: "api-key", unlocks: "医学术语归一化。", capabilities: [] }),
];

const rowOf = (name: string) => screen.getByText(name).closest("div.px-4") as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchWebConnectors.mockResolvedValue(catalogue());
});

describe("数据源", () => {
  it("shows each source's state, and a 「设置」 only where one is needed", async () => {
    render(<ConnectorsSection />);
    expect(await screen.findByText("OpenGWAS")).toBeInTheDocument();
    // Connected first, then what a capability needs, then what works without a key.
    const rows = screen.getAllByText(/^(Unpaywall|OpenGWAS|Semantic Scholar)$/).map((node) => node.textContent);
    expect(rows).toEqual(["Unpaywall", "OpenGWAS", "Semantic Scholar"]);
    expect(within(rowOf("Unpaywall")).getByText("已连接")).toBeInTheDocument();
    expect(within(rowOf("Semantic Scholar")).getByText("无需设置")).toBeInTheDocument();
    expect(within(rowOf("OpenGWAS")).getByText("孟德尔随机化需要")).toBeInTheDocument();
    expect(within(rowOf("OpenGWAS")).getByRole("button", { name: "设置" })).toBeInTheDocument();
    // No field anywhere until one is asked for; none ever for a served or keyless source.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(document.querySelector("input[type=password]")).toBeNull();
    for (const gone of [/凭据加密保存/, /平台已配置/, /无需凭据/, /未配置/, /个数据源本部署没有配置凭据/]) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }
  });

  it("folds the optional sources until they are asked for", async () => {
    const user = userEvent.setup();
    render(<ConnectorsSection />);
    await screen.findByText("OpenGWAS");
    expect(screen.queryByText("CORE")).not.toBeInTheDocument();
    const toggle = within(rowOf("另外 2 个可选数据源")).getByRole("button", { name: /展开/ });
    await user.click(toggle);
    expect(screen.getByText("CORE")).toBeInTheDocument();
    expect(within(rowOf("UMLS")).getByRole("button", { name: "设置" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /收起/ }));
    expect(screen.queryByText("CORE")).not.toBeInTheDocument();
  });

  it("opens the field in the row, saves, and never shows the value again", async () => {
    const user = userEvent.setup();
    mocks.saveWebConnectorCredential.mockResolvedValue({ expiresAt: "2026-10-07T00:00:00.000Z" });
    render(<ConnectorsSection />);
    await user.click(within(await screen.findByText("OpenGWAS").then(() => rowOf("OpenGWAS"))).getByRole("button", { name: "设置" }));
    const field = screen.getByLabelText("OpenGWAS 凭据");
    expect(field).toHaveAttribute("type", "password");
    expect(screen.getByRole("link", { name: "获取 OpenGWAS 凭据" })).toHaveAttribute("href", "https://api.opengwas.io/profile/");
    await user.type(field, "eyJ.abc.def");
    await user.click(screen.getByRole("button", { name: "保存 OpenGWAS 凭据" }));
    await waitFor(() => expect(mocks.saveWebConnectorCredential).toHaveBeenCalledWith("opengwas", "eyJ.abc.def"));
    await waitFor(() => expect(screen.queryByLabelText("OpenGWAS 凭据")).not.toBeInTheDocument());
    expect(mocks.fetchWebConnectors).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain("eyJ.abc.def");
  });

  it("keeps replacing and removing the researcher's own credential in the row's 「⋯」, and asks before removing", async () => {
    const user = userEvent.setup();
    mocks.fetchWebConnectors.mockResolvedValue([
      connector({ source: "user", own: { updatedAt: "2026-09-09T00:00:00.000Z", expiresAt: "2026-09-23T00:00:00.000Z", expired: false }, needsAttention: false }),
    ]);
    mocks.removeWebConnectorCredential.mockResolvedValue(undefined);
    render(<ConnectorsSection />);
    const row = await screen.findByText("OpenGWAS").then(() => rowOf("OpenGWAS"));
    expect(within(row).getByText("已连接")).toBeInTheDocument();
    expect(within(row).getByText(/有效期至/)).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "OpenGWAS 凭据" }));
    expect(await screen.findByRole("menuitem", { name: "更换凭据" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "移除凭据" }));
    const dialog = await screen.findByRole("alertdialog", { name: "移除你的 OpenGWAS 凭据？" });
    expect(dialog).toHaveTextContent("需要 OpenGWAS 的研究会报告缺少凭据");
    expect(mocks.removeWebConnectorCredential).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "移除凭据" }));
    await waitFor(() => expect(mocks.removeWebConnectorCredential).toHaveBeenCalledWith("opengwas"));
  });

  it("says when the store is unavailable rather than showing an empty list", async () => {
    mocks.fetchWebConnectors.mockRejectedValue(new Error("Connector credentials are not available on this deployment."));
    render(<ConnectorsSection />);
    expect(await screen.findByText(/读取数据源失败/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});
