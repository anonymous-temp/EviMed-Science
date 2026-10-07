import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebConnector } from "@/lib/apiClient";
import { useToastStore } from "@/lib/toast";
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

const own = (overrides: Partial<NonNullable<WebConnector["own"]>> = {}): NonNullable<WebConnector["own"]> => ({
  updatedAt: "2026-09-09T00:00:00.000Z", expiresAt: null, expired: false, check: null, ...overrides,
});

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
  useToastStore.setState({ toasts: [] });
  mocks.fetchWebConnectors.mockResolvedValue(catalogue());
});

describe("数据源", () => {
  it("says for each source whether it is 已配置 or 未配置, with 「设置」 wherever nothing serves it", async () => {
    render(<ConnectorsSection />);
    expect(await screen.findByText("OpenGWAS")).toBeInTheDocument();
    // Configured first, then what a capability needs, then what works without a key.
    const rows = screen.getAllByText(/^(Unpaywall|OpenGWAS|Semantic Scholar)$/).map((node) => node.textContent);
    expect(rows).toEqual(["Unpaywall", "OpenGWAS", "Semantic Scholar"]);
    expect(within(rowOf("Unpaywall")).getByText("已配置")).toBeInTheDocument();
    expect(within(rowOf("Unpaywall")).queryByRole("button", { name: "设置" })).not.toBeInTheDocument();
    expect(within(rowOf("OpenGWAS")).getByText("未配置")).toBeInTheDocument();
    // The capabilities that depend on it are the row's one line.
    expect(within(rowOf("OpenGWAS")).getByText("孟德尔随机化需要")).toBeInTheDocument();
    expect(within(rowOf("OpenGWAS")).getByRole("button", { name: "设置" })).toBeInTheDocument();
    // A source that works without a key is 可选, not 未配置 (which reads as something missing), says what a key of one's own gives,
    // and takes one too: a saved NCBI, openFDA or Semantic Scholar credential is used now.
    expect(within(rowOf("Semantic Scholar")).getByText("可选")).toBeInTheDocument();
    expect(within(rowOf("Semantic Scholar")).queryByText("未配置")).not.toBeInTheDocument();
    expect(within(rowOf("Semantic Scholar")).getByText("文献检索。")).toBeInTheDocument();
    expect(within(rowOf("Semantic Scholar")).getByRole("button", { name: "设置" })).toBeInTheDocument();
    // No field anywhere until one is asked for.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(document.querySelector("input[type=password]")).toBeNull();
    for (const gone of [/凭据加密保存/, /平台已配置/, /无需凭据/, /已连接/, /无需设置/, /个数据源本部署没有配置凭据/]) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }
  });

  it("never says a capability needs a source that works without a key, and has a sentence for one that says nothing", async () => {
    mocks.fetchWebConnectors.mockResolvedValue([
      connector({ id: "openfda", title: "openFDA", kind: "api-key", unlocks: "不良事件检索的更高请求配额；没有也能用。", capabilities: ["adr-analysis"], keyless: true, needsAttention: false }),
      connector({ id: "ncbi", title: "NCBI E-utilities", kind: "api-key", unlocks: "", capabilities: [], keyless: true, needsAttention: false }),
    ]);
    render(<ConnectorsSection />);
    await screen.findByText("openFDA");
    expect(within(rowOf("openFDA")).getByText("可选")).toBeInTheDocument();
    expect(within(rowOf("openFDA")).getByText("不良事件检索的更高请求配额；没有也能用。")).toBeInTheDocument();
    expect(screen.queryByText(/需要$/)).not.toBeInTheDocument();
    expect(within(rowOf("NCBI E-utilities")).getByText("不填也能用，填写自己的密钥可以提高请求上限")).toBeInTheDocument();
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
    mocks.saveWebConnectorCredential.mockResolvedValue({ expiresAt: "2026-10-07T00:00:00.000Z", check: "verified" });
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

  it("shows what the source said about the researcher's own credential beside 已配置, and warns when it refused it", async () => {
    mocks.fetchWebConnectors.mockResolvedValue([
      connector({ id: "umls", title: "UMLS", capabilities: [], source: "user", own: own({ check: { state: "verified", checkedAt: "2026-09-09T00:00:01.000Z" } }), needsAttention: false }),
      connector({ id: "core", title: "CORE", capabilities: ["mendelian-randomization"], source: "user", own: own({ check: { state: "rejected", checkedAt: "2026-09-09T00:00:01.000Z" } }), needsAttention: false }),
      connector({ id: "omim", title: "OMIM", capabilities: ["mendelian-randomization"], source: "user", own: own({ check: { state: "unreachable", checkedAt: null } }), needsAttention: false }),
      connector({ id: "addgene", title: "Addgene", capabilities: ["mendelian-randomization"], source: "user", own: own({ check: { state: "unchecked", checkedAt: null } }), needsAttention: false }),
      // The deployment's own credential is the deployment's business: no verdict shown.
      connector({ id: "biogrid", title: "BioGRID", capabilities: ["mendelian-randomization"], source: "deployment", own: own({ check: { state: "rejected", checkedAt: null } }), needsAttention: false }),
    ]);
    render(<ConnectorsSection />);
    await screen.findByText("UMLS");
    expect(within(rowOf("UMLS")).getByText("已配置")).toBeInTheDocument();
    expect(within(rowOf("UMLS")).getByText("已验证")).toBeInTheDocument();
    expect(within(rowOf("CORE")).getByText("已配置")).toBeInTheDocument();
    expect(within(rowOf("CORE")).getByText("数据源拒绝了这个凭据，请核对")).toBeInTheDocument();
    expect(within(rowOf("OMIM")).getByText("暂时无法验证")).toBeInTheDocument();
    expect(within(rowOf("Addgene")).queryByText(/验证|拒绝/)).not.toBeInTheDocument();
    expect(within(rowOf("BioGRID")).queryByText(/验证|拒绝/)).not.toBeInTheDocument();
  });

  it("says in a toast when the source refused a saved credential, and still keeps the field closed", async () => {
    const user = userEvent.setup();
    mocks.saveWebConnectorCredential.mockResolvedValue({ expiresAt: null, check: "rejected" });
    render(<ConnectorsSection />);
    await user.click(within(await screen.findByText("OpenGWAS").then(() => rowOf("OpenGWAS"))).getByRole("button", { name: "设置" }));
    await user.type(screen.getByLabelText("OpenGWAS 凭据"), "eyJ.abc.def");
    await user.click(screen.getByRole("button", { name: "保存 OpenGWAS 凭据" }));
    await waitFor(() => expect(useToastStore.getState().toasts.map((item) => item.message)).toContain("已保存，但 OpenGWAS 拒绝了这个凭据，请核对后重新填写"));
    expect(useToastStore.getState().toasts.at(-1)?.tone).toBe("error");
    await waitFor(() => expect(screen.queryByLabelText("OpenGWAS 凭据")).not.toBeInTheDocument());
  });

  it("keeps replacing and removing the researcher's own credential in the row's 「⋯」, and asks before removing", async () => {
    const user = userEvent.setup();
    mocks.fetchWebConnectors.mockResolvedValue([
      connector({ source: "user", own: own({ expiresAt: "2026-09-23T00:00:00.000Z" }), needsAttention: false }),
    ]);
    mocks.removeWebConnectorCredential.mockResolvedValue(undefined);
    render(<ConnectorsSection />);
    const row = await screen.findByText("OpenGWAS").then(() => rowOf("OpenGWAS"));
    expect(within(row).getByText("已配置")).toBeInTheDocument();
    expect(within(row).getByText(/有效期至/)).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "OpenGWAS 凭据" }));
    expect(await screen.findByRole("menuitem", { name: "更换凭据" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "移除凭据" }));
    const dialog = await screen.findByRole("alertdialog", { name: "移除你的 OpenGWAS 凭据？" });
    expect(dialog).toHaveTextContent("需要 OpenGWAS 的研究会跳过这部分");
    expect(mocks.removeWebConnectorCredential).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "移除凭据" }));
    await waitFor(() => expect(mocks.removeWebConnectorCredential).toHaveBeenCalledWith("opengwas"));
  });

  it("says when the store is unavailable rather than showing an empty list", async () => {
    mocks.fetchWebConnectors.mockRejectedValue(new Error("Connector credentials are not available on this deployment."));
    render(<ConnectorsSection />);
    expect(await screen.findByText(/无法读取数据源/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});
