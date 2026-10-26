import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetStudies } from "@/components/vcr/useStudy";
import { fixture, installVcrServer, STUDY_ID } from "@/components/vcr/__fixtures__/serverFixtures";
import { drawStudy } from "./studyPageHarness";

/**
 * Task starts and continuations open the study's existing conversation without submitting a programme step (VCR reset,
 * 2026-10-25/26). Export remains an explicit operation whose activity appears on the current result page.
 */
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);
const me = vi.hoisted(() => ({ fetchWebMe: vi.fn() }));
vi.mock("@/lib/apiClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/apiClient")>()), fetchWebMe: me.fetchWebMe }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const shell = vi.hoisted(() => ({
  select: vi.fn(async (_projectId: string, land?: () => void) => { land?.(); }),
  load: vi.fn(async () => undefined),
}));
vi.mock("@/lib/projects", () => {
  const state = () => ({ currentId: "prj_ev201", projects: [{ id: "prj_ev201" }], select: shell.select, load: shell.load });
  return { useProjectStore: Object.assign(<T,>(selector: (value: ReturnType<typeof state>) => T) => selector(state()), { getState: state }) };
});
const frame = vi.hoisted(() => ({ registered: [] as unknown[] }));
vi.mock("@/lib/taskPane", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/taskPane")>()),
  registerTaskPane: (request: unknown) => { frame.registered.push(request); return () => undefined; },
}));

const RUN = { id: "run_9", step: "patients", steps: ["patients"], label: "生成虚拟患者", phase: null, counts: {}, startedAt: new Date().toISOString(), placement: "open-runtime", locked: false };

/**
 * The study as the server reads it before and after a press: until `POST …/run` is answered it holds the given state; after, the
 * same study with the run that the press started out, which is what makes the strip appear.
 */
function serve(patch: (raw: any) => void, tabs: Record<string, unknown> = {}) {
  let started = false;
  const quiet = () => {
    const raw = fixture("ev201/study.json");
    raw.jobs = raw.jobs.filter((job: { state: string }) => job.state === "succeeded");
    raw.activity = null;
    patch(raw);
    return raw;
  };
  return installVcrServer(network.productRequest, {
    [`GET /vcr/studies/${STUDY_ID}`]: () => {
      const raw = quiet();
      if (started) raw.activity = { run: RUN, queue: [], jobs: [], last: null };
      return raw;
    },
    [`POST /vcr/studies/${STUDY_ID}/run`]: () => { started = true; return { accepted: true, runId: "run_9", step: "patients", queuedBehind: [] }; },
    [`POST /vcr/studies/${STUDY_ID}/export`]: () => { started = true; return { accepted: true, runId: "run_9", step: null, queuedBehind: [], export: { id: "exp_9" } }; },
    ...tabs,
  });
}

const posts = (server: ReturnType<typeof installVcrServer>, suffix: string) => server.calls.filter((call) => call.method === "POST" && call.path.endsWith(suffix));

beforeEach(() => {
  forgetStudies();
  me.fetchWebMe.mockReset();
  me.fetchWebMe.mockResolvedValue({ features: { vcr: true } });
  shell.select.mockClear();
  frame.registered.length = 0;
});

const EMPTY_TABS = ["population", "patients", "comparator", "trial"] as const;
const BUTTON: Record<string, [string, string]> = {
  population: ["构建人群", "population"],
  patients: ["生成虚拟患者", "patients"],
  comparator: ["设计对照", "comparator"],
  trial: ["模拟试验方案", "trial"],
};

describe("a task that has not begun opens the existing native conversation", () => {
  it.each(EMPTY_TABS)("%s: the recipe's button asks for the step and the tab stays", async (tab) => {
    const [label, step] = BUTTON[tab];
    const server = serve((raw) => {
      raw.next = null;
      raw.steps[step] = { ...raw.steps[step], status: "none", requested: false };
    }, { [`GET /vcr/studies/${STUDY_ID}/${tab}`]: fixture(`empty/${tab}.json`) });
    drawStudy(`/app/virtual-research/${STUDY_ID}/${tab}`);
    await userEvent.click(await screen.findByRole("button", { name: label }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(`/app/virtual-research/${STUDY_ID}/chat`));
    expect(posts(server, "/run")).toHaveLength(0);
    expect(shell.select).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "研究对话" })).toBeInTheDocument();
  });

  it("the evidence step: 找证据、整理假设卡 on 定义与证据", async () => {
    const server = serve((raw) => {
      raw.next = null;
      raw.steps.evidence = { ...raw.steps.evidence, status: "none", requested: false };
    }, { [`GET /vcr/studies/${STUDY_ID}/data`]: fixture("empty/data.json") });
    drawStudy(`/app/virtual-research/${STUDY_ID}/data`);
    await userEvent.click(await screen.findByRole("button", { name: "找证据、整理假设卡" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(`/app/virtual-research/${STUDY_ID}/chat`));
    expect(posts(server, "/run")).toHaveLength(0);
    expect(shell.select).not.toHaveBeenCalled();
  });
});

describe("task navigation does not enforce a programme", () => {
  it.each(["", "/trial", "/matching"])("has no mandatory next-step action on %s", async suffix => {
    const server = serve(() => undefined);
    drawStudy(`/app/virtual-research/${STUDY_ID}${suffix}`);
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("button", { name: /^(下一步|接着做：|重新做：)/ })).toBeNull();
    expect(document.querySelector("[data-step-rail]")).toBeNull();
    expect(posts(server, "/run")).toHaveLength(0);
  });
});

describe("unfinished work continues in the existing native conversation", () => {
  it("opens the conversation from a failed virtual-patient result without submitting a run", async () => {
    const server = serve(() => undefined);
    drawStudy(`/app/virtual-research/${STUDY_ID}/patients`);
    const failed = await waitFor(() => {
      const found = document.querySelector("[data-vcr-step-failed='patients']");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    await userEvent.click(within(failed).getByRole("button", { name: "在对话中继续" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(`/app/virtual-research/${STUDY_ID}/chat`));
    expect(screen.getByRole("region", { name: "研究对话" })).toBeInTheDocument();
    expect(posts(server, "/run")).toHaveLength(0);
    expect(shell.select).not.toHaveBeenCalled();
  });

  it("opens the same conversation from the overview's failed-step attention line", async () => {
    const server = serve((raw) => { raw.next = null; });
    drawStudy(`/app/virtual-research/${STUDY_ID}`);
    const attention = await waitFor(() => {
      const found = document.querySelector("[data-vcr-attention]");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    await userEvent.click(within(attention).getByRole("button", { name: "在对话中继续" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(`/app/virtual-research/${STUDY_ID}/chat`));
    expect(screen.getByRole("region", { name: "研究对话" })).toBeInTheDocument();
    expect(posts(server, "/run")).toHaveLength(0);
    expect(shell.select).not.toHaveBeenCalled();
  });
});

describe("an export is a start too", () => {
  it("is written by a run the strip shows, and the page stays", async () => {
    const server = serve((raw) => { raw.next = null; });
    drawStudy(`/app/virtual-research/${STUDY_ID}/trial`);
    await userEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "导出…" }));
    const dialog = await screen.findByRole("dialog", { name: "导出" });
    await userEvent.click(within(dialog).getByRole("button", { name: "导出" }));
    await waitFor(() => expect(posts(server, "/export")).toHaveLength(1));
    await waitFor(() => expect(document.querySelector("[data-activity='strip']")).not.toBeNull());
    expect(screen.getByTestId("where")).toHaveTextContent(`/app/virtual-research/${STUDY_ID}/trial`);
    expect(shell.select).not.toHaveBeenCalled();
  });
});
