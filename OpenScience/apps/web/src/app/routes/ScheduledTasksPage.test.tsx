import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeUiIntentFromState } from "@/lib/runtimeUiNavigation";
import { ScheduledTasksPage } from "./ScheduledTasksPage";

/** Where the browser ended up, and the state it carried there. */
function Landed() {
  const location = useLocation();
  return <output data-testid="landed">{JSON.stringify({ path: `${location.pathname}${location.search}`, state: location.state })}</output>;
}
function open(address: string) {
  render(<MemoryRouter initialEntries={[address]}><Routes>
    <Route path="/app/autopilot/:taskId?" element={<ScheduledTasksPage />} />
    <Route path="/app/chat" element={<Landed />} />
  </Routes></MemoryRouter>);
  return JSON.parse(screen.getByTestId("landed").textContent ?? "{}") as { path: string; state: { runtimeUiIntent?: Record<string, unknown> } };
}

describe("定时任务", () => {
  afterEach(cleanup);

  it("opens the kernel's own page in the frame: a new conversation on screen, asked to show the scheduled tasks over it", () => {
    const landed = open("/app/autopilot");
    expect(landed.path).toBe("/app/chat");
    expect(landed.state.runtimeUiIntent).toMatchObject({ kind: "create", panel: "schedules", projectId: "default" });
    // What the frame will read of it: accepted for this project, with the panel.
    expect(runtimeUiIntentFromState(landed.state, "default")).toMatchObject({ panel: "schedules" });
  });

  it("takes an old task link there too, and carries nothing of it into the address", () => {
    for (const address of ["/app/autopilot/task_123", "/app/autopilot?task=task_123", "/app/autopilot?digest=d1"]) {
      cleanup();
      const landed = open(address);
      expect(landed.path, address).toBe("/app/chat");
      expect(landed.state.runtimeUiIntent?.panel, address).toBe("schedules");
    }
  });

  it("is a conversation of its own each time, so one visit does not take over another's draft", () => {
    const first = open("/app/autopilot");
    cleanup();
    const second = open("/app/autopilot");
    expect(second.state.runtimeUiIntent?.sessionId).not.toBe(first.state.runtimeUiIntent?.sessionId);
    expect(second.state.runtimeUiIntent?.requestId).not.toBe(first.state.runtimeUiIntent?.requestId);
  });
});
