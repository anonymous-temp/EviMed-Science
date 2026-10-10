import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readVcrStudy, type VcrStudy } from "@/lib/vcrClient";
import { fixture, installVcrServer, STUDY_ID } from "../__fixtures__/serverFixtures";
import { VCR_DEFERRED_SENTENCE } from "../useVcrRun";
import { MatchingTab } from "./MatchingTab";

// 「给患者找试验」, drawn from the pages the server sends: only the network is doubled. The readers, the route functions and the tab are the
// real ones, and every payload is `vcrViews.integration.test.mjs`'s own fixture — a ranked list the platform ordered in code, with the
// criteria of the chosen trial for the chosen patient.
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

const store = vi.hoisted(() => ({
  select: vi.fn(async (_projectId: string, land?: () => void) => { land?.(); }),
  load: vi.fn(async () => undefined),
}));
vi.mock("@/lib/projects", () => ({
  useProjectStore: { getState: () => ({ projects: [{ id: "prj_ev201" }], select: store.select, load: store.load }) },
}));

const MATCHING = `/vcr/studies/${STUDY_ID}/matching`;
const SEARCH = `/vcr/studies/${STUDY_ID}/trial-search`;

/** The study as the page hands it to a tab: the server's own answer, through the real reader. */
function study(change?: (raw: any) => void): VcrStudy {
  const raw = fixture("ev201/study.json");
  change?.(raw);
  return readVcrStudy(raw);
}

function drawTab(node: React.ReactElement) {
  return render(
    <MemoryRouter initialEntries={[`/app/virtual-research/${STUDY_ID}/matching`]}>
      <Routes>
        <Route path="/app/virtual-research/:studyId/:tab?" element={node} />
        <Route path="*" element={<p data-testid="elsewhere" />} />
      </Routes>
    </MemoryRouter>,
  );
}

const reads = (server: ReturnType<typeof installVcrServer>) =>
  server.calls.filter((call) => call.method === "GET" && call.path.startsWith(MATCHING)).map((call) => new URL(call.path, "http://x").searchParams);
const searches = (server: ReturnType<typeof installVcrServer>) => server.calls.filter((call) => call.method === "POST" && call.path === SEARCH);
const trialRow = (id: string) => document.querySelector(`[data-vcr-trial='${id}']`) as HTMLElement;
const criterionRow = (code: string) => document.querySelector(`[data-vcr-criterion='${code}']`) as HTMLElement;

let server: ReturnType<typeof installVcrServer>;

beforeEach(() => {
  server = installVcrServer(network.productRequest);
  toasts.success.mockReset();
  toasts.error.mockReset();
  store.select.mockClear();
});

/** The tab as the reader finds it, then the direction chosen. */
async function openDirection() {
  drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
  await screen.findByRole("heading", { name: "P-0201" });
  await userEvent.click(screen.getByRole("radio", { name: "给患者找试验" }));
}

async function choose(patient: string) {
  await userEvent.selectOptions(await screen.findByLabelText("患者"), patient);
}

describe("给患者找试验 — before a patient is chosen", () => {
  it("is a page of its own, not the other direction's: one sentence, the one action waiting for a patient, no candidate list", async () => {
    await openDirection();
    expect(await screen.findByText("选一位患者，看有哪些试验可以参加。")).toBeInTheDocument();
    expect(reads(server).at(-1)?.get("direction")).toBe("patient_to_trial");
    expect(reads(server).at(-1)?.has("candidate")).toBe(false);
    expect(screen.getByRole("button", { name: "为该患者找试验" })).toBeDisabled();
    // The funnel, the candidate list and the protocol's criterion table of the other direction are not drawn under it.
    expect(screen.queryByRole("heading", { name: "P-0201" })).toBeNull();
    expect(document.querySelector("[data-vcr-candidate]")).toBeNull();
    expect(document.querySelector("[data-vcr-criterion]")).toBeNull();
    expect(screen.getByRole("radio", { name: "给患者找试验" })).toHaveAttribute("aria-checked", "true");
  });

  it("offers the patients the study holds, and nothing is asked of the server until one is chosen", async () => {
    await openDirection();
    const select = await screen.findByLabelText("患者");
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual(["请选择患者", "P-0192", "P-0201"]);
    expect(searches(server)).toHaveLength(0);
  });
});

describe("给患者找试验 — a patient with trials", () => {
  it("reads the patient's page and lists the trials in the order the platform ranked them, each with its registry id, title, phase, status, eligibility and counts", async () => {
    await openDirection();
    await choose("P-0192");
    await screen.findByRole("heading", { name: "P-0192 的试验" });
    expect(reads(server).some((query) => query.get("direction") === "patient_to_trial" && query.get("candidate") === "P-0192")).toBe(true);

    const rows = [...document.querySelectorAll("[data-vcr-trial]")] as HTMLElement[];
    expect(rows.map((row) => row.getAttribute("data-vcr-trial"))).toEqual(["ctr_1", "prt_2", "ctr_2", "ctr_3"]);

    const first = within(trialRow("ctr_1"));
    expect(first.getByText("EV-201 plus docetaxel versus docetaxel in previously treated NSCLC")).toBeInTheDocument();
    expect(first.getByText("III 期 · 招募中")).toBeInTheDocument();
    expect(first.getByText("符合")).toBeInTheDocument();
    expect(first.getByText("3 条满足 · 0 条未知 · 0 条不满足")).toBeInTheDocument();
    // The registry id is a link out to the trial's own page.
    const link = first.getByRole("link", { name: /NCT05000001/ });
    expect(link).toHaveAttribute("href", "https://clinicaltrials.gov/study/NCT05000001");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");

    const open = within(trialRow("ctr_2"));
    expect(open.getByText("证据不足")).toBeInTheDocument();
    expect(open.getByText("2 条满足 · 1 条未知 · 0 条不满足")).toBeInTheDocument();
    expect(open.getByText("II 期 · 尚未开始招募")).toBeInTheDocument();
    expect(within(trialRow("ctr_3")).getByText("不符合")).toBeInTheDocument();
    // The excluded trial is last, not gone.
    expect(rows.at(-1)).toBe(trialRow("ctr_3"));
  });

  it("lists the study's own protocol in the same ranking, as the study's and without a link out", async () => {
    await openDirection();
    await choose("P-0192");
    await screen.findByRole("heading", { name: "P-0192 的试验" });
    const own = within(trialRow("prt_2"));
    expect(own.getByText("EV-201 方案 v1")).toBeInTheDocument();
    expect(own.getByText("本研究方案")).toBeInTheDocument();
    expect(own.queryByRole("link")).toBeNull();
    expect(trialRow("prt_2")).toHaveAttribute("data-vcr-trial-kind", "protocol");
  });

  it("opens the first trial's criterion table by default: the trial's words, the state, the patient's own evidence", async () => {
    await openDirection();
    await choose("P-0192");
    await screen.findByRole("heading", { name: "P-0192 的试验" });
    expect(within(trialRow("ctr_1")).getByRole("button", { name: /EV-201 plus docetaxel/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("table", { name: /NCT05000001 的逐条判定/ })).toBeInTheDocument();
    expect(criterionRow("I1")).toHaveTextContent("Age >= 18 years");
    expect(criterionRow("I1")).toHaveAttribute("data-vcr-criterion-state", "satisfied");
    expect(criterionRow("I1")).toHaveTextContent("age = 63 year");
    expect(criterionRow("E1")).toHaveAttribute("data-vcr-criterion-state", "satisfied");
    expect(screen.getByText("符合：全部适用的入排条件都满足")).toBeInTheDocument();
  });

  it("re-reads the page for the trial chosen, with trial= in the query, and shows what is still unknown and what to ask for", async () => {
    await openDirection();
    await choose("P-0192");
    await screen.findByRole("heading", { name: "P-0192 的试验" });
    await userEvent.click(within(trialRow("ctr_2")).getByRole("button", { name: /EGFR-mutant NSCLC/ }));
    await waitFor(() => expect(reads(server).some((query) => query.get("trial") === "ctr_2" && query.get("candidate") === "P-0192")).toBe(true));
    await waitFor(() => expect(criterionRow("I2")).toHaveAttribute("data-vcr-criterion-state", "unknown"));
    expect(criterionRow("I2")).toHaveTextContent("Documented EGFR exon 19 deletion or L858R mutation");
    expect(criterionRow("I2")).toHaveTextContent("EGFR 突变检测报告");
    expect(screen.getByText("不能判为符合：入选标准 I2 未知")).toBeInTheDocument();
    expect(within(trialRow("ctr_2")).getByRole("button", { name: /EGFR-mutant NSCLC/ })).toHaveAttribute("aria-current", "true");
    expect(within(trialRow("ctr_1")).getByRole("button", { name: /EV-201 plus docetaxel/ })).not.toHaveAttribute("aria-current");
  });

  it("starts from the first trial again for another patient, whatever trial was open", async () => {
    await openDirection();
    await choose("P-0192");
    await screen.findByRole("heading", { name: "P-0192 的试验" });
    await userEvent.click(within(trialRow("ctr_2")).getByRole("button", { name: /EGFR-mutant NSCLC/ }));
    await waitFor(() => expect(reads(server).some((query) => query.get("trial") === "ctr_2")).toBe(true));
    await choose("P-0201");
    await screen.findByText("还没有为 P-0201 找过试验。");
    expect(reads(server).at(-1)?.get("candidate")).toBe("P-0201");
    expect(reads(server).at(-1)?.has("trial")).toBe(false);
  });

  it("keeps the search available beside the list, so a patient can be searched for again", async () => {
    await openDirection();
    await choose("P-0192");
    await screen.findByRole("heading", { name: "P-0192 的试验" });
    expect(screen.getByRole("button", { name: "为该患者找试验" })).toBeEnabled();
  });
});

describe("给患者找试验 — a patient the study has found no trial for", () => {
  it("is one sentence and the one button, and the button starts the search for that patient", async () => {
    await openDirection();
    await choose("P-0201");
    expect(await screen.findByText("还没有为 P-0201 找过试验。")).toBeInTheDocument();
    expect(document.querySelector("[data-vcr-trial]")).toBeNull();
    const button = screen.getByRole("button", { name: "为该患者找试验" });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(SEARCH, "POST", { subjectKey: "P-0201" }));
    // The run is the study's own conversation's, like 让 AI 做: the reader is taken there.
    await waitFor(() => expect(store.select).toHaveBeenCalledWith("prj_ev201", expect.any(Function)));
  });

  it("is one request however often the button is pressed while the first is out", async () => {
    let release: (value: unknown) => void = () => undefined;
    server = installVcrServer(network.productRequest, { [`POST ${SEARCH}`]: () => new Promise((resolve) => { release = resolve; }) });
    await openDirection();
    await choose("P-0201");
    const button = await screen.findByRole("button", { name: "为该患者找试验" });
    await userEvent.click(button);
    await userEvent.click(button);
    expect(searches(server)).toHaveLength(1);
    release({ sessionId: "ses_1", runId: "run_3", deferred: null, evaluated: 0 });
    await waitFor(() => expect(store.select).toHaveBeenCalled());
  });

  it("stays on the page and says the run waits for the one before it, when the study's run is taken", async () => {
    server = installVcrServer(network.productRequest, { [`POST ${SEARCH}`]: { sessionId: null, runId: null, deferred: "another_run_active", evaluated: 0 } });
    await openDirection();
    await choose("P-0201");
    const button = await screen.findByRole("button", { name: "为该患者找试验" });
    const before = reads(server).length;
    await userEvent.click(button);
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(VCR_DEFERRED_SENTENCE));
    expect(store.select).not.toHaveBeenCalled();
    // What the study already held was judged at once: the page reads again to show it.
    await waitFor(() => expect(reads(server).length).toBeGreaterThan(before));
  });

  it("says why when the search could not be asked for, and keeps the page", async () => {
    server = installVcrServer(network.productRequest, { [`POST ${SEARCH}`]: () => { throw new Error("boom"); } });
    await openDirection();
    await choose("P-0201");
    await userEvent.click(await screen.findByRole("button", { name: "为该患者找试验" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("暂时无法开始查找，请稍后重试。"));
    expect(screen.getByText("还没有为 P-0201 找过试验。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "为该患者找试验" })).toBeEnabled();
  });

  it("offers no search to a reader who may not start a run, and still says what there is", async () => {
    drawTab(<MatchingTab studyId={STUDY_ID} study={study((raw) => { raw.abilities = ["read", "read_patient_level"]; })} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("radio", { name: "给患者找试验" }));
    await choose("P-0201");
    expect(await screen.findByText("还没有为 P-0201 找过试验。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "为该患者找试验" })).toBeNull();
  });
});

describe("给患者找试验 — the other direction is the way back", () => {
  it("goes back to the protocol's candidates from the patient's page, unchanged", async () => {
    await openDirection();
    await choose("P-0192");
    await screen.findByRole("heading", { name: "P-0192 的试验" });
    await userEvent.click(screen.getByRole("radio", { name: "给试验找患者" }));
    expect(await screen.findByRole("heading", { name: "P-0201" })).toBeInTheDocument();
    expect(document.querySelector("[data-vcr-trial]")).toBeNull();
    expect(reads(server).at(-1)?.get("direction")).toBe("trial_to_patient");
  });

  it("falls back to the protocol's page, as before, when the server sends no patient page for the direction", async () => {
    server = installVcrServer(network.productRequest, {
      [`GET ${MATCHING}`]: () => fixture("ev201/matching.json"),
    });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("radio", { name: "给患者找试验" }));
    await waitFor(() => expect(reads(server).some((query) => query.get("direction") === "patient_to_trial")).toBe(true));
    expect(screen.getByRole("heading", { name: "P-0201" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "为该患者找试验" })).toBeNull();
  });

  it("says the direction is not here when the server says it is not composed, with no button to press", async () => {
    server = installVcrServer(network.productRequest, {
      [`GET ${MATCHING}`]: ({ query }: { query: URLSearchParams }) => {
        const page = fixture(query.get("direction") === "patient_to_trial" ? "ev201/matching-patient-trials-nobody.json" : "ev201/matching.json");
        if (query.get("direction") === "patient_to_trial") page.patientTrials.available = false;
        return page;
      },
    });
    await openDirection();
    expect(await screen.findByText("给患者找试验在本部署尚未接入。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "为该患者找试验" })).toBeNull();
  });
});
