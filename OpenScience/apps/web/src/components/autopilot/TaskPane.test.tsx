import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgendaRecord, EpisodeRecord } from "@/lib/autopilotClient";
import { useTaskPane } from "@/lib/taskPane";
import { boundedLock, conversationOf, TaskPane } from "./TaskPane";

const agenda = { id: "agenda-1", projectId: "p", revision: 1, createdAt: "", updatedAt: "", deletedAt: null, payload: { title: "任务", prompt: "每周五跟进", topics: [], taskTypes: [], dailyBudgetCny: 20, weeklyBudgetCny: 80, maxEpisodeCny: 8, scheduleHour: 7, timeZone: "Asia/Shanghai",
  schedule: { kind: "weekly", timeZone: "Asia/Shanghai", time: "09:00", weekdays: [5] }, nextRunAt: null, scheduleState: "scheduled", enabled: true, status: "active", pauseReason: null, outcomes: [] } } as unknown as AgendaRecord;
const episode = (id: string, payload: Record<string, unknown> = {}): EpisodeRecord => ({ id, projectId: "p", revision: 1, createdAt: "", updatedAt: "", deletedAt: null, payload: {
  agendaId: "agenda-1", taskType: "literature-sentinel", date: "2026-09-29", status: "merged", runId: `run-${id}`, sessionId: `ses-${id}`, budgetCny: 8, createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z", ...payload } } as unknown as EpisodeRecord);

function Pane() { const pane = useTaskPane(); return <p data-testid="asked">{pane ? `${pane.projectId}:${pane.sessionId}` : "none"}</p>; }

describe("which conversation a task page can ask the frame for", () => {
  it("is an ended execution's, whatever it ended as", () => {
    expect(conversationOf(episode("a"), null)).toBe("ses-a");
    expect(conversationOf(episode("a", { status: "failed" }), null)).toBe("ses-a");
    expect(conversationOf(episode("a", { status: "canceled" }), null)).toBe("ses-a");
  });

  it("is an execution that is on its way only when it runs in the researcher's own runtime", () => {
    expect(conversationOf(episode("a", { status: "running", interactive: true }), null)).toBe("ses-a");
    expect(conversationOf(episode("a", { status: "running", interactive: false }), null)).toBeNull();
    // Before the field existed every execution was bounded.
    expect(conversationOf(episode("a", { status: "running" }), null)).toBeNull();
  });

  it("is none for an execution with no conversation, a task that never ran, or a project a bounded runtime holds", () => {
    expect(conversationOf(episode("a", { sessionId: null }), null)).toBeNull();
    expect(conversationOf(null, null)).toBeNull();
    expect(conversationOf(episode("a"), episode("b", { status: "running" }))).toBeNull();
  });
});

describe("the execution that holds the project's runtime", () => {
  it("is the newest one that is running or being checked in a bounded runtime", () => {
    expect(boundedLock([])).toBeNull();
    expect(boundedLock([episode("a"), episode("b", { status: "failed" })])).toBeNull();
    expect(boundedLock([episode("a", { status: "running" }), episode("b", { status: "verifying", createdAt: "2026-10-01T00:00:00Z" })])?.id).toBe("b");
  });

  it("is not one that runs in the researcher's runtime, nor one still queued: it holds nothing yet", () => {
    expect(boundedLock([episode("a", { status: "running", interactive: true })])).toBeNull();
    expect(boundedLock([episode("a", { status: "queued", sessionId: null })])).toBeNull();
  });
});

describe("the pane", () => {
  it("asks for the frame while it has a conversation to show and withdraws the request when it goes", () => {
    const { unmount } = render(<><TaskPane agenda={agenda} execution={episode("a")} lock={null} ledgerRun={null} projectId="p" /><Pane /></>);
    expect(screen.getByTestId("asked")).toHaveTextContent("p:ses-a");
    expect(screen.getByRole("region", { name: "任务对话" })).toBeEmptyDOMElement();
    unmount();
    // A fresh probe: nothing is asked for any more.
    render(<Pane />); expect(screen.getByTestId("asked")).toHaveTextContent("none");
  });

  it("asks for the next execution's conversation when the choice changes, and for none while a bounded runtime holds the project", () => {
    const { rerender } = render(<><TaskPane agenda={agenda} execution={episode("a")} lock={null} ledgerRun={null} projectId="p" /><Pane /></>);
    rerender(<><TaskPane agenda={agenda} execution={episode("b")} lock={null} ledgerRun={null} projectId="p" /><Pane /></>);
    expect(screen.getByTestId("asked")).toHaveTextContent("p:ses-b");
    act(() => rerender(<><TaskPane agenda={agenda} execution={episode("b")} lock={episode("c", { status: "running" })} ledgerRun={null} projectId="p" /><Pane /></>));
    expect(screen.getByTestId("asked")).toHaveTextContent("none");
    expect(screen.getByRole("region", { name: "任务对话" })).toHaveAttribute("data-task-pane", "progress");
  });

  it("draws no input box of its own in any state", () => {
    const states = [
      <TaskPane key="1" agenda={agenda} execution={null} lock={null} ledgerRun={null} projectId="p" />,
      <TaskPane key="2" agenda={agenda} execution={episode("a", { status: "queued", sessionId: null })} lock={null} ledgerRun={null} projectId="p" />,
      <TaskPane key="3" agenda={agenda} execution={episode("a")} lock={episode("c", { status: "running" })} ledgerRun={null} projectId="p" />,
      <TaskPane key="4" agenda={agenda} execution={episode("a", { sessionId: null })} lock={null} ledgerRun={null} projectId="p" />,
    ];
    for (const state of states) {
      const { container, unmount } = render(state);
      expect(container.querySelector("input, textarea, [contenteditable]")).toBeNull();
      unmount();
    }
  });
});
