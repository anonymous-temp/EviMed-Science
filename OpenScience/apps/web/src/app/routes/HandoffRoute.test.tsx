import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handoffFragment, handoffFromFragment, type HandoffInput } from "@/lib/researchHandoff";
import { HandoffRoute } from "./HandoffRoute";

const client = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/productClient")>()),
  ...client,
}));

const store = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("@/lib/projects", () => ({
  useProjectStore: { getState: () => store },
}));

const handoff: HandoffInput = {
  question: "司美格鲁肽对肥胖成人的体重下降幅度如何？",
  premises: ["成人", "非妊娠"],
  sources: [{ title: "Once-Weekly Semaglutide in Adults with Overweight or Obesity", doi: "10.1056/NEJMoa2032183", quote: "−14.9%" }],
};

function Probe() {
  const location = useLocation();
  const intent = (location.state as { runtimeUiIntent?: { kind: string; projectId: string; sessionId: string; draft?: string } } | null)?.runtimeUiIntent;
  return <div data-testid="location">{location.pathname}{intent ? `|${intent.kind}|${intent.projectId}|${intent.sessionId}|${intent.draft}` : ""}</div>;
}

function renderAt(hash: string) {
  return render(
    <MemoryRouter initialEntries={[`/app/handoff${hash}`]}>
      <Routes>
        <Route path="/app/handoff" element={<HandoffRoute />} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("转为深度研究", () => {
  beforeEach(() => {
    client.productRequest.mockReset();
    store.select.mockReset();
    // The shell moves to the project first, then lands where the switch was for.
    store.select.mockImplementation(async (_projectId: string, land?: () => void) => { land?.(); });
  });

  it("round-trips a hand-off through the address fragment, Chinese included", () => {
    expect(handoffFromFragment(handoffFragment(handoff))).toEqual(handoff);
    expect(handoffFromFragment("")).toBeNull();
    expect(handoffFromFragment("#not base64!")).toBeNull();
    expect(handoffFromFragment(handoffFragment({ question: "" } as HandoffInput))).toBeNull();
  });

  it("opens a new conversation in the chosen project with the card in its composer, and sends nothing", async () => {
    client.productRequest.mockResolvedValue({ projectId: "study", sessionId: "handoff-abc", draft: "司美格鲁肽…\n\n> **来自 AI 搜索**" });
    renderAt(handoffFragment({ ...handoff, projectId: "study" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/app/chat|create|study|handoff-abc|司美格鲁肽…\n\n> **来自 AI 搜索**"));
    expect(client.productRequest).toHaveBeenCalledTimes(1);
    expect(client.productRequest).toHaveBeenCalledWith("/research/handoffs", "POST", { ...handoff, projectId: "study" });
    expect(store.select).toHaveBeenCalledWith("study", expect.any(Function));
  });

  it("says what went wrong and tries again on request", async () => {
    client.productRequest.mockRejectedValueOnce(new Error("offline"));
    client.productRequest.mockResolvedValueOnce({ projectId: "default", sessionId: "handoff-def", draft: "问" });
    renderAt(handoffFragment(handoff));
    expect(await screen.findByText("无法转入深度研究。")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/app/chat|create|default|handoff-def|问"));
    expect(client.productRequest).toHaveBeenCalledTimes(2);
  });

  it("without a hand-off in the address it offers a blank conversation, exactly as 「新对话」 does, and creates nothing", async () => {
    renderAt("");
    expect(screen.getByText("没有要转入的问题")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "开始新对话" }));
    const where = screen.getByTestId("location").textContent ?? "";
    expect(where).toMatch(/^\/app\/chat\|create\|[^|]*\|[A-Za-z0-9_-]+\|undefined$/);
    expect(client.productRequest).not.toHaveBeenCalled();
  });

  it("a link whose fragment cannot be read says it is no good, with the same one action and no way back to an origin it does not know", async () => {
    renderAt("#not%20a%20payload!");
    expect(screen.getByText("这条转入链接已失效")).toBeTruthy();
    expect(screen.queryByText("没有要转入的问题")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(client.productRequest).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "开始新对话" }));
    expect(screen.getByTestId("location").textContent).toMatch(/^\/app\/chat\|create\|/);
  });

  it("a fragment that decodes to no question is a damaged link too", () => {
    renderAt(handoffFragment({ question: "" } as HandoffInput));
    expect(screen.getByText("这条转入链接已失效")).toBeTruthy();
    expect(client.productRequest).not.toHaveBeenCalled();
  });
});
