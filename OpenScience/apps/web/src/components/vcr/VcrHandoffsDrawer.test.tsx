import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VcrHandoffsDrawer } from "./VcrHandoffsDrawer";

/** 交出去的对话 (round-2 review P1-11): the handoffs of a study, each taken back in one click with no confirmation, the session id never printed. */
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

const grants = (rows: unknown[]) => ({ continuations: rows });
const ROW = { sessionId: "sess_secret_1", grantedAt: "2026-11-09T06:30:00Z", revoked: false, revokedAt: null, mine: true };

beforeEach(() => { network.productRequest.mockReset(); toasts.success.mockReset(); toasts.error.mockReset(); });

describe("VcrHandoffsDrawer", () => {
  it("lists the conversations by when they were handed over, and prints no identifier", async () => {
    network.productRequest.mockResolvedValue(grants([ROW, { ...ROW, sessionId: "sess_secret_2", mine: false, revoked: true, revokedAt: "2026-11-09T07:00:00Z" }]));
    render(<VcrHandoffsDrawer studyId="std_1" onClose={() => undefined} />);
    expect(await screen.findAllByText(/交出的对话/)).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/sess_secret/);
    expect(screen.getByText("别的成员交出的")).toBeTruthy();
    expect(screen.getByText("已收回")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /收回第/ })).toHaveLength(1);
  });

  it("takes one back with one click, with no confirmation dialog, and reads the list again", async () => {
    let revoked = false;
    network.productRequest.mockImplementation(async (_path: string, method = "GET") => {
      if (method === "DELETE") { revoked = true; return { revoked: true }; }
      return grants([{ ...ROW, revoked }]);
    });
    render(<VcrHandoffsDrawer studyId="std_1" onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole("button", { name: "收回第 1 个对话" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies/std_1/continuations/sess_secret_1", "DELETE"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已收回。"));
    expect(await screen.findByText("已收回")).toBeTruthy();
  });

  it("says how to hand a study over when it was handed to nobody, as a recipe", async () => {
    network.productRequest.mockResolvedValue(grants([]));
    render(<VcrHandoffsDrawer studyId="std_1" onClose={() => undefined} />);
    expect(await screen.findByText("还没有交出过对话")).toBeTruthy();
    expect(within(document.body).getByText(/在新对话中继续/)).toBeTruthy();
  });
});
