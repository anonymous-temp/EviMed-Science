import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECTOR_PROMPT_SNOOZE_KEY, ConnectorPrompt } from "./ConnectorPrompt";

const mocks = vi.hoisted(() => ({ fetchWebConnectors: vi.fn() }));
vi.mock("@/lib/apiClient", () => ({ fetchWebConnectors: mocks.fetchWebConnectors }));

function Location() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.hash}</div>;
}

const renderPrompt = () =>
  render(
    <MemoryRouter initialEntries={["/app/chat"]}>
      <ConnectorPrompt />
      <Location />
    </MemoryRouter>,
  );

const pending = { id: "opengwas", title: "OpenGWAS", kind: "jwt", unlocks: "孟德尔随机化所需的 GWAS 汇总数据。", obtainUrl: "https://x", capabilities: [], keyless: false, validityDays: 14, source: "none", own: null, needsAttention: true };
const served = { ...pending, id: "umls", title: "UMLS", source: "deployment", needsAttention: false };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("ConnectorPrompt", () => {
  it("names the sources nobody serves and takes the researcher to the account page", async () => {
    mocks.fetchWebConnectors.mockResolvedValue([pending, served]);
    renderPrompt();
    expect(await screen.findByRole("region", { name: "数据源凭据提示" })).toBeInTheDocument();
    expect(screen.getByText(/1 个数据源本部署没有配置凭据/)).toHaveTextContent("OpenGWAS");
    expect(screen.queryByText(/UMLS/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "去配置" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/app/account#connectors");
    expect(screen.queryByRole("region", { name: "数据源凭据提示" })).not.toBeInTheDocument();
  });

  it("stays silent when every source is served, when the store is absent, and for a week after 稍后再说", async () => {
    mocks.fetchWebConnectors.mockResolvedValue([served]);
    const { unmount } = renderPrompt();
    await waitFor(() => expect(mocks.fetchWebConnectors).toHaveBeenCalled());
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    unmount();

    mocks.fetchWebConnectors.mockRejectedValue(new Error("503"));
    const absent = renderPrompt();
    await waitFor(() => expect(mocks.fetchWebConnectors).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    absent.unmount();

    mocks.fetchWebConnectors.mockResolvedValue([pending]);
    const shown = renderPrompt();
    await userEvent.click(await screen.findByRole("button", { name: "稍后再说" }));
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(Number(localStorage.getItem(CONNECTOR_PROMPT_SNOOZE_KEY))).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
    shown.unmount();
    // Snoozed: not even asked.
    renderPrompt();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.fetchWebConnectors).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });
});
