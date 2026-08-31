/**
 * The decoder, folded over frames a real kernel actually sent.
 *
 * runStream.test.ts replays frames written by hand, which proves the reducer
 * against the shapes we believed the publisher emits. That is the half that
 * cannot catch a publisher which emits something else — and a hand-authored
 * wire fixture has already certified a shape the wire never produced once in
 * this repo's history.
 *
 * So these frames are recorded, not written: captured off the live SSE
 * connection during the F0 acceptance on 2026-08-31 — a real research question
 * ("二甲双胍用于非糖尿病的肥胖成人减重…") answered by the DSH kernel 0.1.1-rc.2
 * in image evimed-runtime-dsh:acceptance-j-20260831, run
 * run_d523b4d2dee58d6fea7cc2bd6a2fdea9, terminal state `succeeded`.
 *
 * The recording held 3981 frames and 1.8 MB, of which 3927 were streaming text
 * deltas. What is committed here is a bounded selection of it: every distinct
 * frame shape the run produced, all of them verbatim, with the repetitive
 * kinds capped (deltas at 30, tool results at 2, user messages at 2) and the
 * duplicated raw `data` string dropped because `parsed` is the same bytes
 * decoded. Nothing was edited, reshaped or invented; frames were only omitted.
 * Regenerate with `scripts/ops/session-stream-acceptance.mjs`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RUN_STREAM_FRAME_TYPES, applyRunFrame, emptyRunView, type RunStreamFrame } from "./runStream";

const here = path.dirname(fileURLToPath(import.meta.url));
const recorded: { connection: number; id: number; event: string; parsed: Record<string, unknown> }[] =
  readFileSync(path.join(here, "__fixtures__", "run-stream-live-20260831.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

/** The wire's `event:` name plus its decoded payload is exactly a frame. */
const frames = recorded.map((entry) => ({ type: entry.event, ...entry.parsed }) as unknown as RunStreamFrame);

describe("frames a real DSH kernel sent", () => {
  it("is a recording with something in it", () => {
    // A fixture that failed to load folds to an empty view, and an empty view
    // satisfies almost everything asserted below by saying nothing.
    expect(frames.length).toBeGreaterThan(50);
    const kinds = new Set(recorded.map((entry) =>
      entry.event === "run/event" ? `run/event:${(entry.parsed as any).event?.type}` : entry.event));
    expect(kinds.size).toBeGreaterThanOrEqual(10);
  });

  it("sends nothing the browser is not listening for", () => {
    // EventSource delivers a named event only to a listener registered for that
    // name, so a frame type absent from this list is not mishandled — it never
    // arrives at all.
    for (const entry of recorded) {
      expect(RUN_STREAM_FRAME_TYPES, `the wire sent "${entry.event}"`).toContain(entry.event as never);
    }
  });

  it("folds into a conversation a reader could follow", () => {
    const view = frames.reduce(applyRunFrame, emptyRunView("run_d523b4d2dee58d6fea7cc2bd6a2fdea9"));

    expect(view.state).toBe("succeeded");
    expect(view.blocks.length).toBeGreaterThan(0);

    // Each of these is a card the session view exists to render. A run that
    // produced none of them still reports success.
    const kinds = view.blocks.map((block) => block.kind);
    expect(kinds).toContain("user");
    expect(kinds).toContain("agent");
    expect(kinds).toContain("tool-call");

    const answer = view.blocks.filter((block) => block.kind === "agent")
      .map((block) => (block as { markdown?: string }).markdown ?? "").join("");
    expect(answer.length).toBeGreaterThan(200);

    // The run's own facts rode the same channel as the kernel's, which is the
    // property that let the page stop polling for them.
    expect(view.evidence.total).toBeGreaterThan(0);
    expect(view.budget.tokens).toBeGreaterThan(0);

    // The first connection was cut at seq 40 and resumed with ?since=40; a gap
    // would mean the replay buffer had already dropped frames the page needed.
    expect(view.missedRange).toBeNull();
  });

  it("shows what it could not decode instead of dropping it", () => {
    const view = frames.reduce(applyRunFrame, emptyRunView("run_d523b4d2dee58d6fea7cc2bd6a2fdea9"));
    // Nine of 3966 run events were kernel internals the pump does not map. They
    // are surfaced by raw name and counted, which is the designed behaviour —
    // the assertion is that they are visible, not that they are absent.
    expect(Object.keys(view.unknownEvents).sort()).toEqual([
      "agent/inbox/spliced",
      "request/context",
      "request/header",
      "session/title",
      "session/title-llm-request",
    ]);
    const total = Object.values(view.unknownEvents).reduce((sum, count) => sum + count, 0);
    expect(total).toBe(9);
  });
});
