import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpsRoute } from "./OpsRoute";

const mocks = vi.hoisted(() => ({ fetchWebMe: vi.fn() }));
vi.mock("@/lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/apiClient")>("@/lib/apiClient");
  return { ...actual, fetchWebMe: mocks.fetchWebMe, hasWebApi: true };
});
vi.mock("./OpsPage", () => ({ OpsPage: () => <div>运维分区<p>循证进化</p></div> }));

const me = (operator: boolean) => ({
  user: { id: "alice", name: "Alice", tenantId: "alice" }, tenant: { id: "alice", model: "individual-account", role: "owner" },
  ...(operator ? { operator: true } : {}), project: { id: "default", name: "我的研究" }, projects: [{ id: "default", name: "我的研究" }],
});

function open() {
  return render(
    <MemoryRouter initialEntries={["/app/ops"]}>
      <Routes>
        <Route path="/app/ops" element={<OpsRoute />} />
        <Route path="/app/account" element={<p>设置页</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

// 「运维」 left 设置 for a page of its own, offered to an operator and to nobody else (R19, audit D C4/C7).
describe("运维", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("is a page of its own with the console in it, for an account the control plane says is an operator", async () => {
    mocks.fetchWebMe.mockResolvedValue(me(true));
    open();
    expect(await screen.findByText("运维分区")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "运维" })).toBeInTheDocument();
    expect(screen.getByText("循证进化")).toBeInTheDocument();
  });

  it("sends any other account to 设置, and shows the console to nobody while it does not know", async () => {
    mocks.fetchWebMe.mockResolvedValue(me(false));
    open();
    expect(await screen.findByText("设置页")).toBeInTheDocument();
    expect(screen.queryByText("运维分区")).not.toBeInTheDocument();
  });

  it("says so, with a retry, when the account cannot be read — and never draws the console on a guess", async () => {
    const user = userEvent.setup();
    mocks.fetchWebMe.mockRejectedValueOnce(new Error("network")).mockResolvedValue(me(true));
    open();
    const alert = await screen.findByRole("alert");
    expect(screen.queryByText("运维分区")).not.toBeInTheDocument();
    await user.click(within(alert).getByRole("button", { name: "重试" }));
    expect(await screen.findByText("运维分区")).toBeInTheDocument();
  });
});
