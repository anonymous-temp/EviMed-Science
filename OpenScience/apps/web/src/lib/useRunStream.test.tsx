import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useRunStream } from "./useRunStream";
import type { RunStreamFrame, RunTranscript } from "./runStream";

/** A minimal EventSource the test drives by hand. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  listeners = new Map<string, EventListener>();
  closed = false;
  onerror: ((event: unknown) => void) | null = null;

  constructor(public url: string) {
    FakeEventSource.last = this;
  }

  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, listener);
  }

  close() {
    this.closed = true;
  }

  emit(frame: RunStreamFrame) {
    const listener = this.listeners.get(frame.type);
    listener?.(new MessageEvent(frame.type, { data: JSON.stringify(frame) }) as unknown as Event);
  }
}

function Probe({
  runId,
  transcript,
  initialState,
}: {
  runId: string | null;
  transcript?: RunTranscript | null;
  initialState?: string;
}) {
  // Deliberately inline, not memoized: a hook that re-subscribes when a caller
  // forgets to memoize is a hook that re-subscribes in production.
  const { view, status, retries } = useRunStream(runId, {
    initialState,
    fetchTranscript: async () => transcript ?? null,
    factory: (url) => new FakeEventSource(url) as unknown as EventSource,
  });
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="state">{view.state}</span>
      <span data-testid="seq">{view.seq}</span>
      <span data-testid="retries">{retries}</span>
      <span data-testid="blocks">{view.blocks.length}</span>
    </div>
  );
}

describe("subscribing to one run", () => {
  beforeEach(() => {
    // The handle is static, so a test that reads it without clearing first can
    // assert against the previous test's stream and pass for the wrong reason.
    FakeEventSource.last = null;
  });

  it("seeds from the transcript before the stream opens, so an older run is not blank", async () => {
    const transcript: RunTranscript = {
      sessionId: "s-1",
      lastSeq: 7,
      turnEnd: null,
      subagents: [],
      messages: [
        {
          role: "user",
          source: "user",
          seq: 1,
          time: 1,
          turn: 1,
          step: 1,
          parts: [{ type: "text", text: "分析这个问题" }],
          usage: null,
          interrupted: false,
        },
      ],
    };
    render(<Probe runId="run-1" transcript={transcript} />);
    await waitFor(() => expect(screen.getByTestId("seq").textContent).toBe("7"));
    expect(Number(screen.getByTestId("blocks").textContent)).toBeGreaterThan(0);
    // And the stream resumes from where the transcript ended rather than from
    // zero: replaying a run from the beginning re-applies frames whose effects
    // are not idempotent.
    expect(FakeEventSource.last?.url).toContain("since=7");
  });

  it("closes its own stream once the run has settled", async () => {
    render(<Probe runId="run-2" />);
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    const source = FakeEventSource.last!;
    act(() => source.emit({ type: "run/state", seq: 1, state: "running", attempts: 1 } as RunStreamFrame));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("live"));
    act(() => source.emit({ type: "run/state", seq: 2, state: "succeeded", attempts: 1 } as RunStreamFrame));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("settled"));
    expect(source.closed).toBe(true);
  });

  it("does not open a stream for a run the ledger already finished", async () => {
    // The status comes from the run record, not from the transcript: a
    // transcript records a kernel session, and a session that ended is not the
    // same fact as a run that was delivered.
    const transcript: RunTranscript = {
      sessionId: "s-3",
      lastSeq: 3,
      turnEnd: { kind: "completed" },
      subagents: [],
      messages: [],
    };
    render(<Probe runId="run-3" transcript={transcript} initialState="succeeded" />);
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("settled"));
    expect(FakeEventSource.last).toBeNull();
  });

  it("counts reconnects instead of retrying silently", async () => {
    render(<Probe runId="run-4" />);
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    const source = FakeEventSource.last!;
    act(() => source.onerror?.(new Error("dropped")));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("error"));
    expect(screen.getByTestId("retries").textContent).toBe("1");
  });

  it("holds nothing open for a page with no run", async () => {
    FakeEventSource.last = null;
    render(<Probe runId={null} />);
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("idle"));
    expect(FakeEventSource.last).toBeNull();
  });
});
