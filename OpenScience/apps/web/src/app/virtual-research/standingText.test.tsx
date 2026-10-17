import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetStudies } from "@/components/vcr/useStudy";
import { fixture, installVcrServer, STUDY_ID } from "@/components/vcr/__fixtures__/serverFixtures";
import { drawStudy, standingBlocks } from "./studyPageHarness";

/**
 * What a page of the module says by itself (R19, plan §2 rule 4; audit B §2.4, §5): the 29 sentences that were back office on a
 * person's page were not on any list of banned phrases, and a list of phrases never catches the next one. This counts **structure**,
 * not words: outside what holds a record (a dialog, a table, a quotation, a row, a note with its action, an empty state) a page has at
 * most one block of text that long — its headline — and every other sentence is a `Note`, a row or a state.
 *
 * The frame (header, strip, band), the overview, the list, the empty and running states of a step, and the conversation view are
 * held here. A tab's body is held by its own package's tests, which add it to `HELD` when its page has been moved onto the framework.
 */
vi.mock("@/lib/productClient", () => network);
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
const me = vi.hoisted(() => ({ fetchWebMe: vi.fn() }));
vi.mock("@/lib/apiClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/apiClient")>()), fetchWebMe: me.fetchWebMe }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/projects", () => {
  const state = () => ({ currentId: "prj_ev201", projects: [{ id: "prj_ev201" }], select: vi.fn(async () => undefined), load: vi.fn(async () => undefined) });
  return { useProjectStore: Object.assign(<T,>(selector: (value: ReturnType<typeof state>) => T) => selector(state()), { getState: state }) };
});
vi.mock("@/lib/taskPane", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/taskPane")>()), registerTaskPane: () => () => undefined }));

const quiet = (patch: (raw: any) => void = () => undefined) => {
  const raw = fixture("ev201/study.json");
  raw.jobs = raw.jobs.filter((job: { state: string }) => job.state === "succeeded");
  raw.activity = null;
  patch(raw);
  return raw;
};

beforeEach(() => {
  forgetStudies();
  me.fetchWebMe.mockReset();
  me.fetchWebMe.mockResolvedValue({ features: { vcr: true } });
});

/** The text blocks a page stands on its own, as `read → text` pairs, for a failure that says which. */
const blocks = (root: ParentNode = document.body) => standingBlocks(root).map((block) => block.text);

describe("the frame and the views that are its own", () => {
  it("总览 has one standing sentence — its headline — and every other sentence is a note with its action", async () => {
    installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: quiet() });
    drawStudy(`/app/virtual-research/${STUDY_ID}`);
    await screen.findByRole("heading", { level: 1 });
    await screen.findByText(/已模拟 3 个方案/);
    const standing = blocks();
    // The headline is the one block; it is a `Headline`, not a paragraph written by hand.
    expect(standing, standing.join("\n")).toHaveLength(1);
    expect(standing[0]).toMatch(/已模拟 3 个方案/);
  });

  it("总览 of a study that has found nothing says nothing standing at all, and offers the way to the first sentence", async () => {
    installVcrServer(network.productRequest, { [`GET /vcr/studies/std_2`]: fixture("empty/study.json") });
    drawStudy("/app/virtual-research/std_2");
    await screen.findByRole("button", { name: "说明研究问题" });
    expect(blocks()).toEqual([]);
  });

  it("a running step says what is being done and nothing explaining it", async () => {
    installVcrServer(network.productRequest, {
      [`GET /vcr/studies/${STUDY_ID}`]: quiet((raw) => { raw.steps.trial = { ...raw.steps.trial, status: "running" }; raw.activity = {
        run: { id: "r", step: "trial", steps: ["trial"], label: "模拟试验方案", phase: "search", counts: { search: 3 }, startedAt: null, placement: "open-runtime", locked: false },
        queue: [], jobs: [], last: null }; }),
      [`GET /vcr/studies/${STUDY_ID}/trial`]: fixture("empty/trial.json"),
    });
    drawStudy(`/app/virtual-research/${STUDY_ID}/trial`);
    await screen.findByText("正在模拟试验方案", { selector: "p" });
    expect(blocks()).toEqual([]);
    expect(document.body.textContent).not.toMatch(/正在进行，做完|已安排，开始后/);
  });

  it("a step with nothing yet is a recipe — what it uses, what it gives, one button — and not a paragraph", async () => {
    installVcrServer(network.productRequest, {
      [`GET /vcr/studies/${STUDY_ID}`]: quiet((raw) => { raw.next = null; raw.steps.comparator = { ...raw.steps.comparator, status: "none", requested: false }; }),
      [`GET /vcr/studies/${STUDY_ID}/comparator`]: fixture("empty/comparator.json"),
    });
    drawStudy(`/app/virtual-research/${STUDY_ID}/comparator`);
    await screen.findByRole("button", { name: "设计对照" });
    expect(blocks()).toEqual([]);
  });

  it("the conversation view stands nothing of its own on the page: the kernel's application is the content", async () => {
    installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: quiet((raw) => { raw.conversation = { sessionId: "ses_own", exists: true }; }) });
    drawStudy(`/app/virtual-research/${STUDY_ID}/chat`);
    await screen.findByRole("region", { name: "研究对话" });
    expect(blocks()).toEqual([]);
  });
});

describe("the list", () => {
  it("is rows: a study's question and finding are the row's own, and nothing stands outside the rows", async () => {
    installVcrServer(network.productRequest);
    drawStudy("/app/virtual-research");
    await screen.findByRole("list", { name: "研究" });
    expect(blocks()).toEqual([]);
  });

  it("is a recipe in its empty state, not a paragraph", async () => {
    installVcrServer(network.productRequest, { "GET /vcr/studies": { studies: [], draftProjectIds: [] } });
    drawStudy("/app/virtual-research");
    await screen.findByText("还没有研究");
    expect(blocks()).toEqual([]);
  });
});
