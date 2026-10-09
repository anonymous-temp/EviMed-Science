// The strip a conversation shows when its last run went without a data source
// (2026-10-04): it names the source, opens the credential form in place, and —
// once saved — posts one follow-up turn into the same conversation. What these
// pin: it says nothing for a run that has nothing to say, the form is the
// settings page's own, the value is never kept or shown, 继续 asks for the
// skipped part on the line the run was on, and a refusal is said as one.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebAgentRun, WebConnector } from "@/lib/apiClient";
import { CONNECTORS_CHANGED_EVENT } from "@/lib/connectorAttention";
import { continuationText } from "@/lib/runCredential";
import { useToastStore } from "@/lib/toast";
import { ConnectorNeedNotice } from "./ConnectorNeedNotice";

const mocks = vi.hoisted(() => ({
  fetchWebConnectors: vi.fn(),
  saveWebConnectorCredential: vi.fn(),
  dispatchWebAgentRun: vi.fn(),
}));
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  fetchWebConnectors: mocks.fetchWebConnectors,
  saveWebConnectorCredential: mocks.saveWebConnectorCredential,
  dispatchWebAgentRun: mocks.dispatchWebAgentRun,
}));

const connector = (id: string, title: string, source: WebConnector["source"] = "none"): WebConnector => ({
  id, title, kind: "api-key", unlocks: "", obtainUrl: `https://example.test/${id}`, capabilities: [], keyless: false,
  validityDays: null, source, own: null, needsAttention: source === "none",
});

function run(overrides: Partial<WebAgentRun> = {}): WebAgentRun {
  return {
    id: "run-1", dispatchId: null, dispatchStatus: "accepted", sessionId: "web-session-1", mode: "open-domain", agentId: null,
    agentVersion: null, runtimeAgent: null, effectiveAgentId: "open-domain-answer", model: "deepseek-flash", status: "succeeded",
    createdAt: "2026-10-04T01:00:00.000Z", startedAt: "2026-10-04T01:00:00.000Z", finishedAt: "2026-10-04T01:05:00.000Z",
    durationMs: 300_000, errorCode: null, artifacts: [], unverifiedArtifacts: [], question: "把这些术语映射到 UMLS",
    connectorNeeds: ["umls"], availableActions: [{ kind: "continue", scope: "session", targetId: "web-session-1" }], ...overrides,
  };
}

function mount(current: WebAgentRun | null) {
  return render(<MemoryRouter><ConnectorNeedNotice run={current} /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  useToastStore.setState({ toasts: [] });
  mocks.fetchWebConnectors.mockResolvedValue([connector("umls", "UMLS"), connector("core", "CORE")]);
  mocks.dispatchWebAgentRun.mockResolvedValue(run({ id: "run-2", status: "running", connectorNeeds: undefined }));
});

describe("when the strip speaks", () => {
  it("does not offer continuation when the server has not advertised it", async () => {
    mocks.fetchWebConnectors.mockResolvedValue([connector("umls", "UMLS", "user")]);
    mount(run({ availableActions: [] }));
    await screen.findByRole("status");
    expect(screen.queryByRole("button", { name: "继续" })).not.toBeInTheDocument();
  });
  it("names the source a finished run went without, with 去配置 and no 继续 yet", async () => {
    mount(run());
    expect(await screen.findByText("UMLS 还没有配置，相关部分已跳过。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "去配置" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "继续" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("data-connector-need");
  });

  it("says it for a run that ended with nothing to hand over, because its only path needed the source", async () => {
    mocks.fetchWebConnectors.mockResolvedValue([connector("opengwas", "OpenGWAS")]);
    mount(run({ status: "failed", errorCode: "specialist_required_output_missing", connectorNeeds: ["opengwas"] }));
    expect(await screen.findByText("OpenGWAS 还没有配置，相关部分已跳过。")).toBeInTheDocument();
  });

  it("says nothing for a run that is going or was stopped, left nothing out, or has no conversation yet", () => {
    for (const quiet of [run({ status: "running" }), run({ status: "canceled" }), run({ connectorNeeds: [] }), run({ connectorNeeds: undefined }), null]) {
      const { container, unmount } = mount(quiet);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
    // Nothing left out, so nothing was asked of the server either.
    expect(mocks.fetchWebConnectors).not.toHaveBeenCalled();
  });

  it("lists every source the run left out, and offers a field for each on its own", async () => {
    mount(run({ connectorNeeds: ["umls", "core"] }));
    expect(await screen.findByText("UMLS 还没有配置，相关部分已跳过。")).toBeInTheDocument();
    expect(screen.getByText("CORE 还没有配置，相关部分已跳过。")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "去配置" })).toHaveLength(2);
  });
});

describe("去配置 and the form", () => {
  it("opens the same credential form the settings page uses, in place, and never keeps or shows the value", async () => {
    const user = userEvent.setup();
    mocks.saveWebConnectorCredential.mockResolvedValue({ expiresAt: null, check: "verified" });
    mount(run());
    await user.click(await screen.findByRole("button", { name: "去配置" }));
    const field = screen.getByLabelText("UMLS 凭据");
    expect(field).toHaveAttribute("type", "password");
    expect(screen.getByRole("link", { name: "获取 UMLS 凭据" })).toHaveAttribute("href", "https://example.test/umls");
    await user.type(field, "umls-secret-key-123");
    await user.click(screen.getByRole("button", { name: "保存 UMLS 凭据" }));
    await waitFor(() => expect(mocks.saveWebConnectorCredential).toHaveBeenCalledWith("umls", "umls-secret-key-123"));
    await waitFor(() => expect(screen.queryByLabelText("UMLS 凭据")).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain("umls-secret-key-123");
  });

  it("is 继续 once the list says the source is served, and 去配置 is gone", async () => {
    const user = userEvent.setup();
    mocks.saveWebConnectorCredential.mockResolvedValue({ expiresAt: null, check: "verified" });
    mount(run());
    await user.click(await screen.findByRole("button", { name: "去配置" }));
    await user.type(screen.getByLabelText("UMLS 凭据"), "k");
    // What the settings page does after a save: the list is re-read, and says so.
    mocks.fetchWebConnectors.mockResolvedValue([connector("umls", "UMLS", "user"), connector("core", "CORE")]);
    await user.click(screen.getByRole("button", { name: "保存 UMLS 凭据" }));
    expect(await screen.findByText("UMLS 已配置。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "去配置" })).not.toBeInTheDocument();
    expect(mocks.dispatchWebAgentRun).not.toHaveBeenCalled();
  });

  it("warns that the source refused a saved credential, which is kept, and still offers 继续", async () => {
    const user = userEvent.setup();
    mocks.saveWebConnectorCredential.mockResolvedValue({ expiresAt: null, check: "rejected" });
    mount(run());
    await user.click(await screen.findByRole("button", { name: "去配置" }));
    await user.type(screen.getByLabelText("UMLS 凭据"), "wrong-key");
    mocks.fetchWebConnectors.mockResolvedValue([connector("umls", "UMLS", "user")]);
    await user.click(screen.getByRole("button", { name: "保存 UMLS 凭据" }));
    expect(await screen.findByText("UMLS 已保存，但数据源拒绝了这个凭据，请核对。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续" })).toBeInTheDocument();
  });

  it("is a link to the settings page where the connector list cannot be read", async () => {
    mocks.fetchWebConnectors.mockRejectedValue(new Error("unavailable"));
    mount(run());
    const link = await screen.findByRole("link", { name: "去配置" });
    expect(link).toHaveAttribute("href", "/app/account?tab=connectors");
  });

  it("re-reads the list when the settings page changes it", async () => {
    mount(run());
    await screen.findByText("UMLS 还没有配置，相关部分已跳过。");
    mocks.fetchWebConnectors.mockResolvedValue([connector("umls", "UMLS", "user")]);
    window.dispatchEvent(new Event(CONNECTORS_CHANGED_EVENT));
    expect(await screen.findByText("UMLS 已配置。")).toBeInTheDocument();
  });
});

describe("继续", () => {
  it("posts one follow-up turn into the same conversation, on the line the run was on, and puts the strip away", async () => {
    const user = userEvent.setup();
    mocks.fetchWebConnectors.mockResolvedValue([connector("umls", "UMLS", "user")]);
    const announced = vi.fn();
    window.addEventListener("evimed:runs-changed", announced);
    mount(run());
    await user.click(await screen.findByRole("button", { name: "继续" }));
    await waitFor(() => expect(mocks.dispatchWebAgentRun).toHaveBeenCalledTimes(1));
    const [sessionId, text, dispatchId, line] = mocks.dispatchWebAgentRun.mock.calls[0];
    expect(sessionId).toBe("web-session-1");
    expect(text).toBe(continuationText(["UMLS"]));
    expect(dispatchId).toMatch(/^web-[0-9a-f]{32}$/);
    expect(line).toBe("answer");
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(announced).toHaveBeenCalled();
    window.removeEventListener("evimed:runs-changed", announced);
  });

  it("stays on the capability an open conversation was routed to, and leaves a bound one to its own", async () => {
    const user = userEvent.setup();
    mocks.fetchWebConnectors.mockResolvedValue([connector("umls", "UMLS", "user")]);
    const first = mount(run({ effectiveAgentId: "clinical-evidence-synthesis" }));
    await user.click(await screen.findByRole("button", { name: "继续" }));
    await waitFor(() => expect(mocks.dispatchWebAgentRun).toHaveBeenCalledTimes(1));
    expect(mocks.dispatchWebAgentRun.mock.calls[0][3]).toBe("clinical-evidence-synthesis");
    first.unmount();
    mocks.dispatchWebAgentRun.mockClear();
    mount(run({ id: "run-3", mode: "specialist", agentId: "mendelian-randomization", effectiveAgentId: "mendelian-randomization" }));
    await user.click(await screen.findByRole("button", { name: "继续" }));
    await waitFor(() => expect(mocks.dispatchWebAgentRun).toHaveBeenCalledTimes(1));
    expect(mocks.dispatchWebAgentRun.mock.calls[0][3]).toBeUndefined();
  });

  it("names only the sources that are configured now", async () => {
    const user = userEvent.setup();
    mocks.fetchWebConnectors.mockResolvedValue([connector("umls", "UMLS", "deployment"), connector("core", "CORE")]);
    mount(run({ connectorNeeds: ["umls", "core"] }));
    await user.click(await screen.findByRole("button", { name: "继续" }));
    await waitFor(() => expect(mocks.dispatchWebAgentRun).toHaveBeenCalledTimes(1));
    expect(mocks.dispatchWebAgentRun.mock.calls[0][1]).toBe(continuationText(["UMLS"]));
    // CORE is still missing and keeps its 去配置.
  });

  it("says why it could not, and stays", async () => {
    const user = userEvent.setup();
    mocks.fetchWebConnectors.mockResolvedValue([connector("umls", "UMLS", "user")]);
    mocks.dispatchWebAgentRun.mockRejectedValue(new Error("offline"));
    mount(run());
    await user.click(await screen.findByRole("button", { name: "继续" }));
    await waitFor(() => expect(useToastStore.getState().toasts.some((item) => item.tone === "error" && item.message.startsWith("无法继续："))).toBe(true));
    expect(screen.getByRole("button", { name: "继续" })).toBeInTheDocument();
  });
});

describe("关闭提示", () => {
  it("puts the strip away for that run, and remembers it, but not for a later run", async () => {
    const user = userEvent.setup();
    const first = mount(run());
    await user.click(await screen.findByRole("button", { name: "关闭提示" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    first.unmount();
    // The same run, remounted: still away.
    const again = mount(run());
    expect(again.container).toBeEmptyDOMElement();
    again.unmount();
    // A later run that left a source out is a new thing to say.
    mount(run({ id: "run-9" }));
    expect(within(await screen.findByRole("status")).getByText("UMLS 还没有配置，相关部分已跳过。")).toBeInTheDocument();
  });
});
