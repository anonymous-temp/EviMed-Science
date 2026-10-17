import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetStudies } from "@/components/vcr/useStudy";
import { fixture, installVcrServer, STUDY_ID } from "@/components/vcr/__fixtures__/serverFixtures";
import { drawStudy } from "./studyPageHarness";

/**
 * Starting work does not take the person away (R19, plan §2.2 rule 6; audit B §2.1, §5). Every button of the module that starts a step
 * is pressed here, in the state it is offered in — empty, failed, the header's next, an attention line, an export — and what is
 * asserted is what the owner reported as broken: the request is made, the page is where it was, no conversation is opened and no
 * project is switched, and the strip that says what is going on appears by itself.
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

/** The page is where it was, nobody was sent to a conversation, and the strip says what is going on. */
async function expectStarted(server: ReturnType<typeof installVcrServer>, at: string, body: unknown) {
  await waitFor(() => expect(posts(server, "/run")).toHaveLength(1));
  expect(posts(server, "/run")[0].body).toEqual(body);
  await waitFor(() => expect(document.querySelector("[data-activity='strip']")).not.toBeNull());
  expect(screen.getByTestId("where")).toHaveTextContent(at);
  expect(shell.select).not.toHaveBeenCalled();
  expect(frame.registered).toHaveLength(0);
  expect(document.querySelector("[data-activity='strip']")).toHaveTextContent("正在生成虚拟患者");
}

beforeEach(() => {
  forgetStudies();
  me.fetchWebMe.mockReset();
  me.fetchWebMe.mockResolvedValue({ features: { vcr: true } });
  shell.select.mockClear();
  frame.registered.length = 0;
});
afterEach(() => undefined);

const EMPTY_TABS = ["population", "patients", "comparator", "trial"] as const;
const BUTTON: Record<string, [string, string]> = {
  population: ["构建人群", "population"],
  patients: ["生成虚拟患者", "patients"],
  comparator: ["设计对照", "comparator"],
  trial: ["模拟试验方案", "trial"],
};

describe("a step that has not begun is started from its empty tab, in place", () => {
  it.each(EMPTY_TABS)("%s: the recipe's button asks for the step and the tab stays", async (tab) => {
    const [label, step] = BUTTON[tab];
    const server = serve((raw) => {
      raw.next = null;
      raw.steps[step] = { ...raw.steps[step], status: "none", requested: false };
    }, { [`GET /vcr/studies/${STUDY_ID}/${tab}`]: fixture(`empty/${tab}.json`) });
    drawStudy(`/app/virtual-research/${STUDY_ID}/${tab}`);
    await userEvent.click(await screen.findByRole("button", { name: label }));
    await waitFor(() => expect(posts(server, "/run")).toHaveLength(1));
    expect(posts(server, "/run")[0].body).toEqual({ step });
    await waitFor(() => expect(document.querySelector("[data-activity='strip']")).not.toBeNull());
    expect(screen.getByTestId("where")).toHaveTextContent(`/app/virtual-research/${STUDY_ID}/${tab}`);
    expect(shell.select).not.toHaveBeenCalled();
    expect(frame.registered).toHaveLength(0);
  });

  it("the evidence step: 找证据、整理假设卡 on 定义与证据", async () => {
    const server = serve((raw) => {
      raw.next = null;
      raw.steps.evidence = { ...raw.steps.evidence, status: "none", requested: false };
    }, { [`GET /vcr/studies/${STUDY_ID}/data`]: fixture("empty/data.json") });
    drawStudy(`/app/virtual-research/${STUDY_ID}/data`);
    await userEvent.click(await screen.findByRole("button", { name: "找证据、整理假设卡" }));
    await waitFor(() => expect(posts(server, "/run")).toHaveLength(1));
    expect(posts(server, "/run")[0].body).toEqual({ step: "evidence" });
    expect(screen.getByTestId("where")).toHaveTextContent(`/app/virtual-research/${STUDY_ID}/data`);
    expect(shell.select).not.toHaveBeenCalled();
  });
});

describe("the header's next step is pressed on any tab, and the page does not move", () => {
  it.each(["", "/trial", "/matching"])("on %s", async (suffix) => {
    const server = serve(() => undefined);
    drawStudy(`/app/virtual-research/${STUDY_ID}${suffix}`);
    await userEvent.click(await screen.findByRole("button", { name: "接着做：生成虚拟患者" }));
    await expectStarted(server, `/app/virtual-research/${STUDY_ID}${suffix}`, { step: "patients" });
    // And the header offers no next step any more, because the strip says what is being done.
    expect(within(document.querySelector("[data-page-header]") as HTMLElement).queryByRole("button", { name: /^(下一步|接着做|重新做)/ })).toBeNull();
  });
});

describe("a step that did not finish is gone on from where it stopped, in place", () => {
  it("接着做 on 虚拟患者, and on 总览's attention line", async () => {
    const server = serve(() => undefined);
    drawStudy(`/app/virtual-research/${STUDY_ID}/patients`);
    const failed = await waitFor(() => {
      const found = document.querySelector("[data-vcr-step-failed='patients']");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    await userEvent.click(within(failed).getByRole("button", { name: "接着做" }));
    await expectStarted(server, `/app/virtual-research/${STUDY_ID}/patients`, { step: "patients" });
  });

  it("the overview's attention line for the failed step asks for it again and stays", async () => {
    const server = serve((raw) => { raw.next = null; });
    drawStudy(`/app/virtual-research/${STUDY_ID}`);
    const attention = await waitFor(() => {
      const found = document.querySelector("[data-vcr-attention]");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    await userEvent.click(within(attention).getByRole("button", { name: "接着做" }));
    await expectStarted(server, `/app/virtual-research/${STUDY_ID}`, { step: "patients" });
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
