import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { readVcrStudy } from "@/lib/vcrClient";
import { announceVcrStudyRefresh, forgetStudies, useStudy } from "./useStudy";
import { ACTIVITY_POLL_MS, CONVERSATION_POLL_MS, isMoving, pollInterval, studyVersion } from "./vcrActivity";
import { fixture, installVcrServer, STUDY_ID } from "./__fixtures__/serverFixtures";

const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);

/** One answer of the study route, built from the fixture with what the test is about put in. */
function answer(patch: (raw: any) => void = () => undefined) {
  const raw = fixture("ev201/study.json");
  raw.jobs = raw.jobs.filter((job: { state: string }) => job.state === "succeeded");
  raw.activity = null;
  patch(raw);
  return raw;
}
const RUN = { id: "run_1", step: "patients", steps: ["patients"], label: "生成虚拟患者", phase: null, counts: {}, startedAt: null, placement: "open-runtime", locked: false };
const reads = () => network.productRequest.mock.calls.filter(([path]) => path === `/vcr/studies/${STUDY_ID}`).length;

/** Lets the in-flight promise chain settle without moving the clock. */
const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  vi.useFakeTimers();
  forgetStudies();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});
afterEach(() => { vi.useRealTimers(); });

describe("when the study is read again", () => {
  it("reads every four seconds while a run, a step in line or an engine job moves, and stops when nothing does", async () => {
    let step = 0;
    installVcrServer(network.productRequest, {
      [`GET /vcr/studies/${STUDY_ID}`]: () => {
        step += 1;
        // Two answers with a run out, then a quiet one with the run's tail, then a quiet one.
        if (step <= 2) return answer((raw) => { raw.activity = { run: RUN, queue: [], jobs: [], last: null }; });
        if (step === 3) return answer((raw) => { raw.activity = { run: null, queue: [], jobs: [], last: { step: "patients", endedAt: new Date().toISOString(), outcome: "succeeded" } }; });
        return answer();
      },
    });
    const { result } = renderHook(() => useStudy(STUDY_ID, true, "overview"));
    await settle();
    expect(result.current.loaded.kind).toBe("ready");
    expect(reads()).toBe(1);
    await tick(ACTIVITY_POLL_MS);
    expect(reads()).toBe(2);
    await tick(ACTIVITY_POLL_MS);
    expect(reads()).toBe(3);
    // The run has ended and its tail is up: it is read once more to be sure of what it left, then not at all.
    await tick(ACTIVITY_POLL_MS + 1_000);
    expect(reads()).toBe(4);
    await tick(120_000);
    expect(reads()).toBe(4);
  });

  it("does not read for a job that waits only for the lead's budget: nothing will change until a person acts", async () => {
    installVcrServer(network.productRequest, {
      [`GET /vcr/studies/${STUDY_ID}`]: answer((raw) => {
        raw.activity = { run: null, queue: [], jobs: [{ id: "j", kind: "design_grid", state: "awaiting_budget", step: "trial", done: null, total: null }], last: null };
      }),
    });
    renderHook(() => useStudy(STUDY_ID, true, "overview"));
    await settle();
    await tick(60_000);
    expect(reads()).toBe(1);
  });

  it("reads more slowly while the conversation is open, for the sentence that names the study — and a draft the same", async () => {
    installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: answer() });
    renderHook(() => useStudy(STUDY_ID, true, "chat"));
    await settle();
    expect(reads()).toBe(1);
    await tick(CONVERSATION_POLL_MS - 100);
    expect(reads()).toBe(1);
    await tick(200);
    expect(reads()).toBe(2);
  });

  it("does not read while the tab is hidden, and reads at once when it is brought back", async () => {
    installVcrServer(network.productRequest, {
      [`GET /vcr/studies/${STUDY_ID}`]: answer((raw) => { raw.activity = { run: RUN, queue: [], jobs: [], last: null }; }),
    });
    renderHook(() => useStudy(STUDY_ID, true, "overview"));
    await settle();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    await tick(ACTIVITY_POLL_MS * 3);
    expect(reads()).toBe(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    expect(reads()).toBe(2);
  });

  it("keeps the study that is on screen when a read fails, and says why only for one it never had", async () => {
    let fail = false;
    installVcrServer(network.productRequest, {
      [`GET /vcr/studies/${STUDY_ID}`]: () => {
        if (fail) throw new WebApiError("down", { status: 503, code: "vcr_unavailable" });
        return answer((raw) => { raw.activity = { run: RUN, queue: [], jobs: [], last: null }; });
      },
    });
    const { result } = renderHook(() => useStudy(STUDY_ID, true, "overview"));
    await settle();
    const first = result.current.loaded;
    expect(first.kind).toBe("ready");
    fail = true;
    await tick(ACTIVITY_POLL_MS);
    expect(result.current.loaded).toBe(first);
    // The study is gone, though: that replaces it.
    installVcrServer(network.productRequest, {
      [`GET /vcr/studies/${STUDY_ID}`]: () => { throw new WebApiError("gone", { status: 404, code: "vcr_study_not_found" }); },
    });
    await tick(ACTIVITY_POLL_MS);
    expect(result.current.loaded.kind).toBe("missing");
  });

  it("holds the same object for an answer that found nothing new, so what is memoized on the study holds still", async () => {
    installVcrServer(network.productRequest, {
      [`GET /vcr/studies/${STUDY_ID}`]: answer((raw) => { raw.activity = { run: RUN, queue: [], jobs: [], last: null }; }),
    });
    const { result } = renderHook(() => useStudy(STUDY_ID, true, "overview"));
    await settle();
    const first = result.current.loaded;
    await tick(ACTIVITY_POLL_MS);
    expect(reads()).toBe(2);
    expect(result.current.loaded).toBe(first);
  });

  it("reads again when something that knows says the study moved", async () => {
    installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: answer() });
    renderHook(() => useStudy(STUDY_ID, true, "overview"));
    await settle();
    expect(reads()).toBe(1);
    // Another study's news is not this page's.
    act(() => announceVcrStudyRefresh("std_other"));
    await settle();
    expect(reads()).toBe(1);
    act(() => announceVcrStudyRefresh(STUDY_ID));
    await settle();
    expect(reads()).toBe(2);
  });

  it("paints the last answer at once when the page is mounted again, as it is when the shell moves to the study's project", async () => {
    installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: answer() });
    const first = renderHook(() => useStudy(STUDY_ID, true, "overview"));
    await settle();
    first.unmount();
    const second = renderHook(() => useStudy(STUDY_ID, true, "overview"));
    // Before any answer: the previous one, not the skeleton.
    expect(second.result.current.loaded.kind).toBe("ready");
  });
});

describe("the version a tab reads on", () => {
  const study = (patch: (raw: any) => void = () => undefined) => readVcrStudy(answer(patch));

  it("changes when a step's state, an engine job's state or the end of a run moves — and not for a job's count", () => {
    const base = study();
    expect(studyVersion(study())).toBe(studyVersion(base));
    expect(studyVersion(study((raw) => { raw.steps.trial = { ...raw.steps.trial, status: "stale" }; }))).not.toBe(studyVersion(base));
    expect(studyVersion(study((raw) => { raw.jobs[0] = { ...raw.jobs[0], state: "failed" }; }))).not.toBe(studyVersion(base));
    expect(studyVersion(study((raw) => { raw.activity = { run: null, queue: [], jobs: [], last: { step: "trial", endedAt: "2026-10-14T01:00:00.000Z", outcome: "succeeded" } }; }))).not.toBe(studyVersion(base));
    const running = study((raw) => { raw.activity = { run: null, queue: [], jobs: [{ id: "j", kind: "design_simulation", state: "running", step: "trial", done: 3, total: 10 }], last: null }; });
    const later = study((raw) => { raw.activity = { run: null, queue: [], jobs: [{ id: "j", kind: "design_simulation", state: "running", step: "trial", done: 4, total: 10 }], last: null }; });
    expect(studyVersion(later)).toBe(studyVersion(running));
  });

  it("knows what moves: a run, a step in line, an engine job under way — not a wait for a budget, not a tail", () => {
    expect(isMoving(null)).toBe(false);
    expect(isMoving({ run: null, queue: [], jobs: [], last: null })).toBe(false);
    expect(isMoving({ run: null, queue: [], jobs: [{ id: "j", kind: "k", state: "awaiting_budget", step: null, done: null, total: null }], last: null })).toBe(false);
    expect(isMoving({ run: null, queue: [{ step: "trial", waitingFor: "allowance" }], jobs: [], last: null })).toBe(true);
    expect(isMoving({ run: null, queue: [], jobs: [{ id: "j", kind: "k", state: "queued", step: null, done: null, total: null }], last: null })).toBe(true);
    expect(pollInterval({ activity: null, status: "active" }, "overview")).toBeNull();
    expect(pollInterval({ activity: null, status: "draft" }, "overview")).toBe(CONVERSATION_POLL_MS);
  });
});
