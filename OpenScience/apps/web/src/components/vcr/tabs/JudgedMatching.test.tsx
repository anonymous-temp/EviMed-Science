import { StrictMode, useState } from "react";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { readVcrStudy, type VcrStudy } from "@/lib/vcrClient";
import { fixture, installVcrServer, STUDY_ID } from "../__fixtures__/serverFixtures";
import { fakeRoom, renderTab } from "../__fixtures__/tabFrame";
import { VcrRefreshContext, VcrRefreshNote } from "../vcrTabKit";
import { MatchingTab } from "./MatchingTab";

// What the model judged, drawn from the pages the server sends (`vcrMatchResults.integration.test.mjs` writes the fixtures under
// `fixtures/vcr-views/judged/` from a study seeded through the real stores): a patient's trials as the job fills them in, and a protocol's people.
// Only the network is doubled; the readers, the route functions and the tab are the real ones.
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));
const download = vi.hoisted(() => ({ file: vi.fn() }));
vi.mock("@/lib/vcrClient", async (original) => ({ ...(await original<typeof import("@/lib/vcrClient")>()), downloadVcrMatching: download.file }));
vi.mock("@/lib/projects", () => ({ useProjectStore: { getState: () => ({ projects: [{ id: "prj_ev201" }], select: vi.fn(), load: vi.fn() }) } }));

const MATCHING = `/vcr/studies/${STUDY_ID}/matching`;
const JUDGED = `GET ${MATCHING}/judged`;
const JUDGE = `POST ${MATCHING}/judge`;
const NOTE = ["患者男，62岁，2025年3月确诊肺腺癌，EGFR 19del 阳性。", "ECOG 评分 1 分。", "2026年9月复查：肌酐 1.2 mg/dL，肝功能正常。", "既往无糖尿病史，无药物过敏史。", "2025年4月起口服奥希替尼至今。"].join("\n");

const study = (change?: (raw: any) => void): VcrStudy => { const raw = fixture("ev201/study.json"); change?.(raw); return readVcrStudy(raw); };
const draw = (node: React.ReactElement, route = `/app/virtual-research/${STUDY_ID}/matching`) => renderTab(node, { route });

/** What `matching/judged` answers: the fixture for what was asked, or whatever `change` makes of it. */
function judged(change?: (page: any, query: URLSearchParams) => any) {
  return ({ query }: { query: URLSearchParams }) => {
    if (query.get("direction") === null) return { available: true, latest: null };
    const target = query.get("target");
    const name = query.get("direction") === "patient_to_trial"
      ? { NCT05000007: "patient-eligible", NCT05000002: "patient-disqualified", NCT05000003: "patient-no-eligibility" }[target ?? ""] ?? "patient-running"
      : query.get("subjectKey") ? "protocol-person" : query.get("verdict") === "ineligible" ? "protocol-ineligible" : "protocol";
    const page = fixture(`judged/${name}.json`);
    return change?.(page, query) ?? page;
  };
}
const judgedReads = (server: ReturnType<typeof installVcrServer>) =>
  server.calls.filter((call) => call.method === "GET" && call.path.startsWith(`${MATCHING}/judged?`)).map((call) => new URL(call.path, "http://x").searchParams);

let server: ReturnType<typeof installVcrServer>;
let restoreRoom: () => void;
const original = window.matchMedia;
/** A page wide enough for the detail to stand beside the list, as it does from 1024 px. */
function wide() {
  window.matchMedia = ((query: string) => ({ matches: query === "(min-width: 1024px)", media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
}
beforeEach(() => { restoreRoom = fakeRoom(); toasts.success.mockReset(); toasts.error.mockReset(); download.file.mockReset(); download.file.mockResolvedValue(undefined); });
afterEach(() => { restoreRoom(); window.matchMedia = original; });

/** The patient direction, opened on the patient the fixtures are about. */
async function patientPage(overrides: Record<string, unknown> = {}, route?: string, title = "P-0192 的试验") {
  server = installVcrServer(network.productRequest, { [JUDGED]: judged(), ...overrides });
  const view = draw(<MatchingTab studyId={STUDY_ID} study={study()} />, route);
  await userEvent.click(await screen.findByRole("button", { name: "给患者找试验" }));
  await userEvent.click(await screen.findByRole("button", { name: /^患者/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "P-0192" }));
  await screen.findByRole("heading", { name: title });
  return view;
}
const trialRow = (id: string) => document.querySelector(`[data-vcr-trial='${id}']`) as HTMLElement;
const clauseRow = (number: number) => document.querySelector(`[data-vcr-clause='${number}']`) as HTMLElement;

describe("给患者找试验 — the trials fill in as the job judges them", () => {
  beforeEach(wide);

  it("says why a row holds a verdict and no reasons, for a reader who may not read the record", async () => {
    await patientPage({ [JUDGED]: judged((page) => ({ ...page, selected: page.selected ? { ...page.selected, groups: {}, summary: null, reasonsWithheld: "这条结论读过的病历，你没有授权或现在已读不到，理由和原文依据已隐去。" } : page.selected })) });
    expect(await screen.findByText(/你没有授权或现在已读不到/u)).toBeInTheDocument();
  });

  it("says 已完成 5 / 8 and lists the trials most promising first, each with its verdict, a line that says why, the match level and the registry's status with its day", async () => {
    await patientPage();
    expect(screen.getByRole("heading", { name: "P-0192 的试验" }).closest("section")).toHaveTextContent("已完成 5 / 8");
    expect(screen.getByRole("list", { name: "P-0192 的试验名单" }).querySelectorAll("li")).toHaveLength(5);
    expect([...document.querySelectorAll("[data-vcr-trial]")].map((row) => row.getAttribute("data-vcr-trial"))).toEqual(["NCT05000001", "prt_screen", "NCT05000007", "NCT05000003", "NCT05000002"]);
    const first = trialRow("NCT05000001");
    expect(within(first).getByText("可能符合")).toBeInTheDocument();
    expect(first).toHaveTextContent("近 4 周内是否接受过化疗");
    expect(first).toHaveTextContent("匹配度高 · 把握较高");
    expect(first).toHaveTextContent("III 期 · 招募中（2026-11-04）");
    expect(within(first).getByRole("link", { name: /NCT05000001/ })).toHaveAttribute("href", "https://clinicaltrials.gov/study/NCT05000001");
    // The verdicts, one chip each: the ones a stated condition rules out last.
    expect(within(trialRow("NCT05000007")).getByText("符合")).toBeInTheDocument();
    expect(within(trialRow("NCT05000002")).getByText("不符合")).toBeInTheDocument();
    // The study's own protocol, as the study's, without a link out.
    expect(within(trialRow("prt_screen")).getByText("本研究方案")).toBeInTheDocument();
    expect(within(trialRow("prt_screen")).queryByRole("link")).toBeNull();
    // Match level is a word, never a percentage.
    expect(document.body.textContent).not.toMatch(/\d+\s*%/);
  });

  it("says the job is out, with its ceiling and what it has cost, and stops this job — not the study", async () => {
    await patientPage({ [`POST ${MATCHING.replace("/matching", "")}/jobs/job_fixed/cancel`]: { job: { id: "job_fixed" }, canceled: true } });
    const note = document.querySelector("[data-vcr-judged-progress='running']") as HTMLElement;
    expect(note).toHaveTextContent("正在判定：已完成 5 / 8 个试验，其中 2 个没判成；这一轮预计最多 1.50 灵豆，累计已用 0.13 灵豆。");
    await userEvent.click(within(note).getByRole("button", { name: "停止这批判定" }));
    await waitFor(() => expect(server.calls.some((call) => call.method === "POST" && call.path === `/vcr/studies/${STUDY_ID}/jobs/job_fixed/cancel`)).toBe(true));
    expect(server.calls.some((call) => call.path.endsWith("/cancel") && !call.path.includes("/jobs/"))).toBe(false);
  });

  it("follows the job: the page reads itself again while it is out", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await patientPage();
      const before = judgedReads(server).length;
      await vi.advanceTimersByTimeAsync(5_200);
      await waitFor(() => expect(judgedReads(server).length).toBeGreaterThan(before));
    } finally { vi.useRealTimers(); }
  });

  it("names the pairs that failed, each with its reason in plain words and none with an internal code, and never reads as a patient nobody has searched for", async () => {
    await patientPage();
    const failed = document.querySelector("[data-vcr-judged-failures]") as HTMLElement;
    expect(failed).toHaveTextContent("模型回答超时 1 个；登记库里没有这个登记号 1 个");
    await userEvent.click(within(failed).getByText(/^查看没判成的 2 个/));
    expect(within(failed).getByText("NCT05000004").closest("li")).toHaveTextContent("模型回答超时");
    expect(within(failed).getByText("NCT05000005").closest("li")).toHaveTextContent("登记库里没有这个登记号");
    expect(document.body.textContent).not.toMatch(/vcr_match_judge|registry_not_found|还没有为/);
  });

  it("offers the rest when the job stopped short, and starts exactly the rest", async () => {
    await patientPage({ [JUDGED]: judged((page) => { page.progress.state = "stopped"; return page; }), [JUDGE]: { jobId: "job_next", state: "queued", estimate: { pairs: 3, cost: 0.4, currency: "CNY" } } });
    const note = document.querySelector("[data-vcr-judged-progress='stopped']") as HTMLElement;
    expect(note).toHaveTextContent("判定没有做完：已完成 5 / 8 个试验，其中 2 个没判成");
    await userEvent.click(within(note).getByRole("button", { name: "继续判定剩下的 3 个" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`${MATCHING}/judge`, "POST", { direction: "patient_to_trial", subjectKey: "P-0192", resume: true }));
  });

  it("a job whose every clause call failed is not finished: the page reads the owed second stage off the server's answer and offers the rest", async () => {
    await patientPage({ [JUDGED]: judged((page) => { page.progress = { ...page.progress, total: 6, finished: 6, failed: 0, waiting: 0, state: "stopped", clauses: { wanted: 6, done: 0, left: 6 } }; return page; }), [JUDGE]: { jobId: "job_next", state: "queued", estimate: { pairs: 6, cost: 0.4, currency: "CNY" } } });
    const note = document.querySelector("[data-vcr-judged-progress='stopped']") as HTMLElement;
    expect(note).toHaveTextContent("判定没有做完：已完成 6 / 6 个试验，逐条判了 0 / 6");
    expect(document.querySelector("[data-vcr-judged-progress='done']")).toBeNull();
    await userEvent.click(within(note).getByRole("button", { name: "继续判定剩下的 6 个" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`${MATCHING}/judge`, "POST", { direction: "patient_to_trial", subjectKey: "P-0192", resume: true }));
  });

  it("offers neither stopping nor continuing to a reader who may not run", async () => {
    server = installVcrServer(network.productRequest, { [JUDGED]: judged() });
    draw(<MatchingTab studyId={STUDY_ID} study={study((raw) => { raw.abilities = ["read", "read_patient_level"]; })} />);
    await userEvent.click(await screen.findByRole("button", { name: "给患者找试验" }));
    await userEvent.click(await screen.findByRole("button", { name: /^患者/ }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "P-0192" }));
    await screen.findByRole("heading", { name: "P-0192 的试验" });
    expect(screen.queryByRole("button", { name: "停止这批判定" })).toBeNull();
    expect(screen.queryByRole("button", { name: "导出" })).toBeNull();
  });

  it("opens the first trial into three groups of reasons and then the clause table — without the note repeated and without an empty group", async () => {
    await patientPage();
    const pair = document.querySelector("[data-vcr-pair='NCT05000001']") as HTMLElement;
    expect(pair).not.toBeNull();
    expect(within(pair).getByRole("heading", { name: "支持的依据" })).toBeInTheDocument();
    expect(within(pair).getByRole("heading", { name: "待查的信息" })).toBeInTheDocument();
    expect(within(pair).queryByRole("heading", { name: "排除的依据" })).toBeNull();
    expect(within(pair).getByText("确诊 EGFR 19del 阳性的肺腺癌，ECOG 1 分")).toBeInTheDocument();
    expect([...pair.querySelectorAll("[data-vcr-clause]")].map((row) => row.getAttribute("data-vcr-clause-stance"))).toEqual(["support", "support", "support", "support", "silent", "open", "not_applicable"]);
    // A clause the record is silent on says so in the platform's words and shows no quotation.
    expect(clauseRow(5)).toHaveTextContent("未见记载，按未排除");
    expect(clauseRow(5).querySelector("[data-vcr-sentence]")).toBeNull();
    expect(clauseRow(6)).toHaveTextContent("未见记载，需确认");
    expect(clauseRow(7)).toHaveTextContent("不适用");
    // A clause with evidence quotes the patient's own sentence.
    expect(clauseRow(1).querySelector("[data-vcr-sentence]")).toHaveTextContent("“患者男，62岁，2025年3月确诊肺腺癌，EGFR 19del 阳性。”");
    // The whole note is not repeated back: only the cited sentences stand in the page.
    expect(document.body.textContent).not.toContain("肝功能正常。");
  });

  it("opens the record at the sentence a clause rests on, marked, with its neighbours around it", async () => {
    await patientPage({ [`GET /vcr/studies/${STUDY_ID}/data/documents/sfl_fixed`]: { document: { id: "sfl_fixed", text: NOTE, sourceHash: "h" } } });
    await userEvent.click(within(clauseRow(3)).getByRole("button", { name: /在病历中查看/ }));
    const record = await screen.findByRole("dialog", { name: "病历原文" });
    await waitFor(() => expect(record.querySelector("[data-vcr-record-sentence]")).not.toBeNull());
    expect(record.querySelector("[data-vcr-record-sentence]")).toHaveTextContent("ECOG 评分 1 分。");
    expect(record).toHaveTextContent("2026年9月复查");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "病历原文" })).toBeNull());
  });

  it("says why when the record cannot be opened, and tries again on 重试", async () => {
    let tried = 0;
    await patientPage({ [`GET /vcr/studies/${STUDY_ID}/data/documents/sfl_fixed`]: () => { tried += 1; if (tried === 1) throw new WebApiError("x", { status: 403, code: "vcr_forbidden" }); return { document: { id: "sfl_fixed", text: NOTE, sourceHash: "h" } }; } });
    await userEvent.click(within(clauseRow(1)).getByRole("button", { name: /在病历中查看/ }));
    await userEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByRole("dialog", { name: "病历原文" })).toHaveTextContent("患者男，62岁");
  });

  it("opens another trial through the server, with target= in the query, and shows a trial rules out by a stated condition in the words of its clause", async () => {
    await patientPage();
    await userEvent.click(within(trialRow("NCT05000002")).getByRole("button", { name: /既往未用过 EGFR-TKI/ }));
    await waitFor(() => expect(judgedReads(server).at(-1)?.get("target")).toBe("NCT05000002"));
    const pair = await waitFor(() => { const found = document.querySelector("[data-vcr-pair='NCT05000002']"); expect(found).not.toBeNull(); return found as HTMLElement; });
    expect(within(pair).getByRole("heading", { name: "排除的依据" })).toBeInTheDocument();
    expect(within(pair).getByText("已经用过奥希替尼，试验要求未用过 EGFR-TKI")).toBeInTheDocument();
    expect(clauseRow(2)).toHaveAttribute("data-vcr-clause-stance", "against");
    expect(clauseRow(2)).toHaveTextContent("符合排除条件");
  });

  it("says a trial was judged without its eligibility text, in the list and where it is opened, and shows a score and no clause counts", async () => {
    await patientPage();
    expect(trialRow("NCT05000003")).toHaveTextContent("未取到入排原文，依据标题和疾病判断");
    await userEvent.click(within(trialRow("NCT05000003")).getByRole("button", { name: /晚期肺癌的观察性研究/ }));
    const pair = await waitFor(() => { const found = document.querySelector("[data-vcr-pair='NCT05000003']"); expect(found).not.toBeNull(); return found as HTMLElement; });
    expect(pair.querySelector("[data-vcr-eligibility-note]")).toHaveTextContent("未取到入排原文，依据标题和疾病判断");
    expect(pair).toHaveTextContent("题目和疾病方向相合，但没有入排原文可核对。");
    expect(pair.querySelector("[data-vcr-clause]")).toBeNull();
  });

  it("has a chip for each of the four verdicts", async () => {
    await patientPage({ [JUDGED]: judged((page) => { page.trials[3] = { ...page.trials[3], verdict: "insufficient", verdictLabel: "证据不足" }; return page; }) });
    for (const label of ["符合", "可能符合", "证据不足", "不符合"]) expect(document.querySelector(`[data-vcr-trial] [data-vcr-verdict]`) && screen.getAllByText(label).length).toBeGreaterThan(0);
    expect([...document.querySelectorAll("[data-vcr-trial] [data-vcr-verdict]")].map((chip) => chip.getAttribute("data-vcr-verdict")).sort()).toEqual(["eligible", "ineligible", "insufficient", "possible", "possible"]);
  });

  it("offers the file of this patient's trials in both formats, for both shapes", async () => {
    await patientPage();
    await userEvent.click(screen.getByRole("button", { name: "导出" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "逐条款（CSV）" }));
    await waitFor(() => expect(download.file).toHaveBeenCalledWith(STUDY_ID, { direction: "patient_to_trial", subjectKey: "P-0192", format: "csv", kind: "clauses" }));
    await userEvent.click(screen.getByRole("button", { name: "导出" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "每对一行（JSON）" }));
    await waitFor(() => expect(download.file).toHaveBeenLastCalledWith(STUDY_ID, { direction: "patient_to_trial", subjectKey: "P-0192", format: "json", kind: "pairs" }));
  });

  it("says when a file could not be made", async () => {
    download.file.mockRejectedValue(new WebApiError("x", { status: 403, code: "vcr_forbidden" }));
    await patientPage();
    await userEvent.click(screen.getByRole("button", { name: "导出" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "每对一行（CSV）" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
  });
});

describe("给患者找试验 — every state", () => {
  beforeEach(wide);

  it("a patient with nothing judged and nothing asked is the earlier page, as it was", async () => {
    server = installVcrServer(network.productRequest);
    draw(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("button", { name: "给患者找试验" }));
    await userEvent.click(await screen.findByRole("button", { name: /^患者/ }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "P-0201" }));
    expect(await screen.findByText(/还没有为 P-0201 找过试验/)).toBeInTheDocument();
  });

  it("a job just begun, before any pair is judged, is a page that says 已完成 0 / n — not a patient nobody has searched for", async () => {
    await patientPage({ [JUDGED]: judged((page) => { page.trials = []; page.selected = null; page.failed = { count: 0, reasons: [], listed: [] };
      page.progress = { ...page.progress, total: 7, finished: 0, failed: 0, waiting: 7 }; return page; }) });
    expect(screen.getByRole("heading", { name: "P-0192 的试验" }).closest("section")).toHaveTextContent("已完成 0 / 7");
    expect(document.querySelector("[data-vcr-judged-progress='running']")).toHaveTextContent("已完成 0 / 7 个试验");
    expect(screen.getByText("还没有判完的试验")).toBeInTheDocument();
    expect(screen.queryByText(/还没有为/)).toBeNull();
  });

  it("all failed is said as that, with the way to go on", async () => {
    await patientPage({ [JUDGED]: judged((page) => { page.trials = []; page.selected = null; page.progress = { ...page.progress, state: "stopped", total: 2, finished: 0, failed: 2, waiting: 0 }; return page; }) });
    expect(document.querySelector("[data-vcr-judged-progress='stopped']")).toHaveTextContent("判定没有做完：已完成 0 / 2 个试验，其中 2 个没判成");
    expect(screen.getByRole("button", { name: "继续判定剩下的 2 个" })).toBeInTheDocument();
    expect(screen.queryByText(/还没有为/)).toBeNull();
  });

  it("one line says what was searched for this person and which registry did not answer", async () => {
    await patientPage({ [JUDGED]: judged((page) => { page.search = "上次检索（2026-11-04）：共找到 12 个试验；CTIS 没查到（登记库暂时没有回答）。"; return page; }) });
    expect(document.querySelector("[data-vcr-search-line]")).toHaveTextContent("CTIS 没查到（登记库暂时没有回答）");
  });

  it("what a row says of what its verdict did not read, and that the list was cut, reach the page", async () => {
    await patientPage({ [JUDGED]: judged((page) => {
      (page as any).cutNote = "这里的对数超过一次能读的上限。";
      (page.trials[0] as any).clausesNote = "重新判定没有完成，这里仍是上一次的结论";
      (page.trials[0] as any).recordGap = "这条结论没有读全：1 份病历没能读取。";
      return page;
    }) });
    expect(document.querySelector("[data-vcr-judged-cut]")).toHaveTextContent("超过一次能读的上限");
    expect(screen.getByText("重新判定没有完成，这里仍是上一次的结论")).toBeInTheDocument();
    expect(screen.getByText("这条结论没有读全：1 份病历没能读取。")).toBeInTheDocument();
  });

  it("while the clause calls are still out the heading and the sentence say that it is the whole-pair stage that is done", async () => {
    await patientPage({ [JUDGED]: judged((page) => { page.progress = { ...page.progress, state: "running", total: 10, finished: 10, failed: 0, waiting: 0, clauses: { wanted: 5, done: 3, left: 2 } }; return page; }) });
    expect(screen.getByRole("heading", { name: "P-0192 的试验" }).closest("section")).toHaveTextContent("整体判定已完成 10 / 10 · 逐条判定进行中");
    expect(document.querySelector("[data-vcr-judged-progress='running']")).toHaveTextContent("正在逐条判定：整体判定已完成 10 / 10 个试验，逐条判了 3 / 5");
  });

  it("what is left is named as two things when it is two: trials with no verdict, and trials whose clause by clause is not done", async () => {
    await patientPage({ [JUDGED]: judged((page) => { page.progress = { ...page.progress, state: "stopped", total: 10, finished: 8, failed: 0, waiting: 2, clauses: { wanted: 8, done: 5, left: 3 } }; return page; }) });
    const note = document.querySelector("[data-vcr-judged-progress='stopped']") as HTMLElement;
    expect(note).toHaveTextContent("还差：2 个试验还没判出结论，3 个试验的逐条判定没做完。");
    expect(within(note).getByRole("button", { name: "继续判定剩下的" })).toBeInTheDocument();
  });

  it("a patient whose page cannot be read is a failure with 重试, and never the last patient's trials under the new name", async () => {
    let failFor: string | null = null;
    server = installVcrServer(network.productRequest, { [JUDGED]: (request: { query: URLSearchParams }) => {
      if (failFor && request.query.get("subjectKey") === failFor) throw new WebApiError("x", { status: 500, code: "internal_error" });
      return judged()(request);
    } });
    draw(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await userEvent.click(await screen.findByRole("button", { name: "给患者找试验" }));
    await userEvent.click(await screen.findByRole("button", { name: /^患者/ }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "P-0192" }));
    await screen.findByRole("heading", { name: "P-0192 的试验" });
    await userEvent.click(await screen.findByRole("button", { name: /^患者/ }));
    const others = (await screen.findAllByRole("menuitemradio")).filter((item) => item.textContent?.trim() !== "P-0192" && !/请选择/.test(item.textContent ?? ""));
    expect(others.length).toBeGreaterThan(0);
    failFor = others[0].textContent!.trim();
    await userEvent.click(others[0]);
    expect(await screen.findByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "P-0192 的试验" })).toBeNull();
  });

  it("with the whole API down for the new patient, the page says the read failed once, not that the last result is still shown", async () => {
    let failFor: string | null = null;
    server = installVcrServer(network.productRequest, { [JUDGED]: judged() });
    const served = network.productRequest.getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
    network.productRequest.mockImplementation(async (rawPath: string, ...rest: unknown[]) => {
      if (failFor && rawPath.includes(failFor)) throw new WebApiError("x", { status: 500, code: "internal_error" });
      return served(rawPath, ...rest);
    });
    // The study page's own reporter: a failed re-read of the page on screen is a sentence above it.
    const Page = () => {
      const [failure, setFailure] = useState<{ retry: () => void } | null>(null);
      return (
        <VcrRefreshContext.Provider value={(_id, next) => setFailure(next)}>
          {failure && <VcrRefreshNote onRetry={failure.retry} />}
          <MatchingTab studyId={STUDY_ID} study={study()} />
        </VcrRefreshContext.Provider>
      );
    };
    draw(<Page />);
    await userEvent.click(await screen.findByRole("button", { name: "给患者找试验" }));
    await userEvent.click(await screen.findByRole("button", { name: /^患者/ }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "P-0192" }));
    await screen.findByRole("heading", { name: "P-0192 的试验" });
    await userEvent.click(await screen.findByRole("button", { name: /^患者/ }));
    const others = (await screen.findAllByRole("menuitemradio")).filter((item) => item.textContent?.trim() !== "P-0192" && !/请选择/.test(item.textContent ?? ""));
    failFor = others[0].textContent!.trim();
    await userEvent.click(others[0]);
    expect(await screen.findAllByRole("button", { name: "重试" })).toHaveLength(1);
    expect(screen.queryByText(/仍显示上次结果/)).toBeNull();
  });

  it("switching to the protocols' side lands on the newest protocol that was judged, not the first in the list", async () => {
    server = installVcrServer(network.productRequest, { [JUDGED]: (request: { query: URLSearchParams }) => {
      if (request.query.get("direction") === null) return { available: true, latest: request.query.get("only") === "trial_to_patient" ? { direction: "trial_to_patient", protocolVersionId: "prt_judged" } : null };
      return judged()(request);
    } });
    draw(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await userEvent.click(await screen.findByRole("button", { name: "给患者找试验" }));
    await userEvent.click(await screen.findByRole("button", { name: "给试验找患者" }));
    await waitFor(() => expect(judgedReads(server).some((query) => query.get("direction") === "trial_to_patient" && query.get("protocolVersionId") === "prt_judged")).toBe(true));
  });

  it("the sheet of a pair judged again says in one line what the reading before it was", async () => {
    await patientPage({ [JUDGED]: judged((page) => { (page.selected as any).previous = { verdictLabel: "符合", judgedAt: "2026-11-01T00:00:00.000Z", line: "上一次判定（2026-11-01）：符合，读的是更早的病历。" }; return page; }) });
    expect(document.querySelector("[data-vcr-previous]")).toHaveTextContent("上一次判定（2026-11-01）：符合，读的是更早的病历。");
  });

  it("all done with the cost said once", async () => {
    await patientPage({ [JUDGED]: judged((page) => { page.progress = { ...page.progress, state: "done", total: 5, finished: 5, failed: 0, waiting: 0 }; page.failed = { count: 0, reasons: [], listed: [] }; return page; }) });
    expect(document.querySelector("[data-vcr-judged-progress='done']")).toHaveTextContent("已全部判完：5 个试验，用了 0.13 灵豆。");
    expect(screen.queryByRole("button", { name: "停止这批判定" })).toBeNull();
    expect(document.querySelector("[data-vcr-judged-failures]")).toBeNull();
  });

  it("waiting for the budget is said as that", async () => {
    await patientPage({ [JUDGED]: judged((page) => { page.progress.state = "waiting_budget"; return page; }) });
    expect(document.querySelector("[data-vcr-judged-progress='waiting_budget']")).toHaveTextContent("判定暂停，等研究的计算预算：已完成 5 / 8");
  });

  it("a read that failed is an error with 重试 — it is not the earlier page and not an empty list", async () => {
    let fail = true;
    server = installVcrServer(network.productRequest, { [JUDGED]: (request: { query: URLSearchParams }) => {
      if (fail && request.query.get("direction") === "patient_to_trial") throw new WebApiError("x", { status: 500, code: "internal_error" });
      return judged()(request);
    } });
    draw(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await userEvent.click(await screen.findByRole("button", { name: "给患者找试验" }));
    await userEvent.click(await screen.findByRole("button", { name: /^患者/ }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "P-0192" }));
    const retry = await screen.findByRole("button", { name: "重试" });
    expect(screen.queryByText(/还没有为/)).toBeNull();
    fail = false;
    await userEvent.click(retry);
    expect(await screen.findByRole("heading", { name: "P-0192 的试验" })).toBeInTheDocument();
  });

  it("a link from a reply names the patient: the page opens on that patient's trials", async () => {
    server = installVcrServer(network.productRequest, { [JUDGED]: judged() });
    draw(<MatchingTab studyId={STUDY_ID} study={study()} />, `/app/virtual-research/${STUDY_ID}/matching?object=P-0192`);
    expect(await screen.findByRole("heading", { name: "P-0192 的试验" })).toBeInTheDocument();
  });

  it("a link to the page alone lands on whatever was judged last", async () => {
    server = installVcrServer(network.productRequest, { [JUDGED]: (request: { query: URLSearchParams }) => (request.query.get("direction") === null ? { available: true, latest: { direction: "patient_to_trial", subjectKey: "P-0192" } } : judged()(request)) });
    draw(<MatchingTab studyId={STUDY_ID} study={study()} />);
    expect(await screen.findByRole("heading", { name: "P-0192 的试验" })).toBeInTheDocument();
  });

  it("the landing survives a development remount (StrictMode runs the effect twice): the one read still applies", async () => {
    server = installVcrServer(network.productRequest, { [JUDGED]: (request: { query: URLSearchParams }) => (request.query.get("direction") === null ? { available: true, latest: { direction: "patient_to_trial", subjectKey: "P-0192" } } : judged()(request)) });
    draw(<StrictMode><MatchingTab studyId={STUDY_ID} study={study()} /></StrictMode>);
    expect(await screen.findByRole("heading", { name: "P-0192 的试验" })).toBeInTheDocument();
  });
});

describe("给患者找试验 — on a phone", () => {
  it("opens the trial in a sheet over the list, and the clause table is stacked cards and not a scroller", async () => {
    await patientPage();
    // Narrow: nothing is open beside the list until a trial is chosen.
    expect(document.querySelector("[data-vcr-pair]")).toBeNull();
    await userEvent.click(within(trialRow("NCT05000001")).getByRole("button", { name: /EGFR 19del 阳性晚期非小细胞肺癌一线治疗/ }));
    const sheet = await screen.findByRole("dialog", { name: "EGFR 19del 阳性晚期非小细胞肺癌一线治疗" });
    await waitFor(() => expect(sheet.querySelector("[data-vcr-pair]")).not.toBeNull());
    expect(sheet.querySelectorAll("[data-vcr-clause]")).toHaveLength(7);
    // No sideways scroll: no scroll region, no table, no minimum width in the clause list.
    expect(sheet.querySelector("table")).toBeNull();
    expect(sheet.querySelector("[class*='min-w-[']")).toBeNull();
    expect(sheet.querySelector("ol[aria-label]")?.className ?? "").not.toMatch(/overflow-x/);
    // Every control of a clause is a native control, reached by Tab.
    const control = within(clauseRow(1)).getByRole("button", { name: /在病历中查看/ });
    control.focus();
    expect(control).toHaveFocus();
  });
});

describe("给试验找患者 — a protocol's people", () => {
  beforeEach(wide);

  async function protocolPage(overrides: Record<string, unknown> = {}, tab = study()) {
    server = installVcrServer(network.productRequest, { [JUDGED]: judged(), ...overrides });
    const view = draw(<MatchingTab studyId={STUDY_ID} study={tab} />);
    await screen.findByRole("list", { name: "患者名单" });
    return view;
  }
  const person = (key: string) => document.querySelector(`[data-vcr-person='${key}']`) as HTMLElement;

  it("a judged person does not hide the rule assessments: both stand, one chip away, and a table study opens on its rules", async () => {
    const assessed = { candidates: [{ id: "P-0001", summary: "2 条满足", eligibility: "eligible", open: [] }], funnel: [{ key: "candidates", label: "候选", count: 1, note: null, tone: "neutral" }], evaluateBy: "model" };
    const withRules = (extra: Record<string, unknown>) => (body: any) => ({ ...fixture("ev201/matching.json"), ...assessed, ...extra, ...(body ? {} : {}) });
    await protocolPage({ [`GET ${MATCHING}`]: withRules({}) });
    const chip = await screen.findByRole("button", { name: "规则筛选" });
    expect(document.querySelector("[data-vcr-person]")).not.toBeNull();
    await userEvent.click(chip);
    await waitFor(() => expect(document.querySelector("[data-vcr-person]")).toBeNull());
    expect(await screen.findByText("P-0001")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "模型判定" }));
    await waitFor(() => expect(document.querySelector("[data-vcr-person]")).not.toBeNull());
  });

  it("draws a count too small to show this reader as a dash, never as a zero, and makes no total of what is hidden", async () => {
    await protocolPage({ [JUDGED]: judged((page) => {
      page.tallies = { eligible: null, possible: null, insufficient: null, ineligible: null };
      page.total = null;
      page.progress = { ...page.progress, total: null, finished: null, failed: null, waiting: null };
      page.clauses = { judgedPeople: null, rows: page.clauses.rows.map((row: any) => ({ ...row, support: null, against: null, silent: null, open: null, notApplicable: null })) };
      return page;
    }) });
    expect(screen.getAllByText((_, node) => node?.getAttribute("data-note") !== null && /少于 10 人的类别不显示具体人数/u.test(node?.textContent ?? "")).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/已判定 0 位/u);
    const chips = within(screen.getByRole("group", { name: "结论" }));
    expect(chips.getByRole("button", { name: /不符合/ }).textContent).not.toMatch(/\d/u);
    const clause = document.querySelector("[data-vcr-funnel-clause]") as HTMLElement;
    expect(clause).toHaveTextContent("—");
    expect(clause.textContent).not.toMatch(/不满足 0/u);
  });

  it("sums the people up in a sentence whose numbers open what they count, and the band carries the verdict filter", async () => {
    await protocolPage();
    const sentence = document.querySelector("[data-note]") as HTMLElement;
    expect(sentence).toHaveTextContent("已判定 13 位患者：符合 5 位，可能符合 2 位，证据不足 2 位，不符合 4 位。");
    const chips = within(screen.getByRole("group", { name: "结论" }));
    expect(chips.getByRole("button", { name: /全部/ })).toHaveAttribute("aria-pressed", "true");
    expect(chips.getByRole("button", { name: /不符合/ })).toHaveTextContent("4");
    await userEvent.click(within(sentence).getByRole("button", { name: "4 位，只看这些" }));
    await waitFor(() => expect(judgedReads(server).at(-1)?.get("verdict")).toBe("ineligible"));
  });

  it("lists every person with the verdict, the match level and the counts of what supports, what disqualifies and what is open — as a list, one row each, the first page of 25", async () => {
    await protocolPage();
    expect(document.querySelectorAll("[data-vcr-person]")).toHaveLength(13);
    expect(judgedReads(server).at(0)?.get("limit")).toBe("25");
    const row = person("P-0192");
    expect(row).toHaveTextContent("可能符合");
    expect(row).toHaveTextContent("匹配度高");
    expect(screen.getByText("第 1–13 位，共 13 位")).toBeInTheDocument();
    // Pseudonyms as they were, and the counts as numbers.
    expect(person("P-0301")).toHaveTextContent(/不符合/);
    expect(person("P-0301").textContent).toMatch(/7.*1.*0/);
    // A person's one line says why.
    expect(person("P-0301")).toHaveTextContent("头颅 MRI 提示活动性脑转移");
  });

  it("shows for each clause how many it satisfies, disqualifies, finds silent and leaves open, the one that loses the most people first", async () => {
    await protocolPage();
    const rows = [...document.querySelectorAll("[data-vcr-funnel-clause]")];
    expect(rows[0].getAttribute("data-vcr-funnel-clause")).toBe("5");
    expect(rows[0]).toHaveTextContent("活动性脑转移");
    expect(rows[0]).toHaveTextContent(/不满足 3/);
    expect(rows[1].getAttribute("data-vcr-funnel-clause")).toBe("8");
    expect(document.body).toHaveTextContent("按逐条判定的 13 位患者计，淘汰最多的是第 5 条（活动性脑转移），3 位不满足。");
    // Not a recruitment funnel: nobody is said to have been contacted, enrolled or referred.
    expect(document.body.textContent).not.toMatch(/转诊|联系|入组漏斗|招募漏斗/);
  });

  it("opens a person into the same clause table beside the list", async () => {
    await protocolPage();
    await userEvent.click(within(person("P-0192")).getByRole("button", { name: "P-0192" }));
    await waitFor(() => expect(judgedReads(server).at(-1)?.get("subjectKey")).toBe("P-0192"));
    const pair = await waitFor(() => { const found = document.querySelector("[data-vcr-pair]"); expect(found).not.toBeNull(); return found as HTMLElement; });
    expect(within(pair).getByRole("heading", { name: "待查的信息" })).toBeInTheDocument();
    expect([...pair.querySelectorAll("[data-vcr-clause]")].map((row) => row.getAttribute("data-vcr-clause-stance"))).toEqual(["support", "support", "support", "silent", "silent", "silent", "not_applicable", "open"]);
    expect(screen.getByRole("button", { name: "查看这位患者的全部试验" })).toBeInTheDocument();
  });

  it("goes from a person to that patient's trials", async () => {
    await protocolPage();
    await userEvent.click(within(person("P-0192")).getByRole("button", { name: "P-0192" }));
    await userEvent.click(await screen.findByRole("button", { name: "查看这位患者的全部试验" }));
    expect(await screen.findByRole("heading", { name: "P-0192 的试验" })).toBeInTheDocument();
  });

  it("narrows to a verdict through the band, back to the first page, and says so when nobody has it", async () => {
    await protocolPage({ [JUDGED]: judged((page, query) => (query.get("verdict") === "insufficient" ? { ...page, people: [], total: 0, more: false } : page)) });
    await userEvent.click(within(screen.getByRole("group", { name: "结论" })).getByRole("button", { name: /不符合/ }));
    await waitFor(() => expect(judgedReads(server).at(-1)?.get("verdict")).toBe("ineligible"));
    await waitFor(() => expect(document.querySelectorAll("[data-vcr-person]")).toHaveLength(4));
    await userEvent.click(within(screen.getByRole("group", { name: "结论" })).getByRole("button", { name: /证据不足/ }));
    expect(await screen.findByText("没有这个结论的患者")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "看全部" }));
    await waitFor(() => expect(document.querySelectorAll("[data-vcr-person]")).toHaveLength(13));
  });

  it("pages through every person, not the first fifty", async () => {
    const many = (offset: number) => (page: any) => {
      const people = Array.from({ length: Math.min(25, 5000 - offset) }, (_, at) => ({ ...page.people[0], subjectKey: `P-${String(offset + at + 1).padStart(5, "0")}` }));
      return { ...page, people, total: 5000, offset, limit: 25, more: offset + 25 < 5000 };
    };
    await protocolPage({ [JUDGED]: judged((page, query) => many(Number(query.get("offset") ?? 0))(page)) });
    expect(screen.getByText("第 1–25 位，共 5000 位")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(judgedReads(server).at(-1)?.get("offset")).toBe("25"));
    expect(await screen.findByText("第 26–50 位，共 5000 位")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上一页" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "上一页" }));
    expect(await screen.findByText("第 1–25 位，共 5000 位")).toBeInTheDocument();
  });

  it("says how far the job is, its ceiling and what it has cost, and stops this job", async () => {
    await protocolPage({ [`POST /vcr/studies/${STUDY_ID}/jobs/job_fixed/cancel`]: { job: { id: "job_fixed" }, canceled: true } });
    const note = document.querySelector("[data-vcr-judged-progress='running']") as HTMLElement;
    expect(note).toHaveTextContent("正在判定：已完成 13 / 16 位患者，其中 1 位没判成；这一轮预计最多 12.50 灵豆，累计已用 0.30 灵豆。");
    await userEvent.click(within(note).getByRole("button", { name: "停止这批判定" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/jobs/job_fixed/cancel`, "POST", expect.anything()));
  });

  it("continues with the rest of the protocol's people when the job stopped short", async () => {
    await protocolPage({ [JUDGED]: judged((page) => { page.progress.state = "stopped"; return page; }), [JUDGE]: { jobId: "job_next", state: "queued", estimate: { pairs: 3, cost: 0.4 } } });
    await userEvent.click(within(document.querySelector("[data-vcr-judged-progress='stopped']") as HTMLElement).getByRole("button", { name: "继续判定剩下的 3 位" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`${MATCHING}/judge`, "POST", { direction: "trial_to_patient", protocolVersionId: "prt_screen", resume: true }));
  });

  it("downloads every person, not the page in view: both shapes, both formats", async () => {
    await protocolPage();
    await userEvent.click(screen.getByRole("button", { name: "导出" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "逐条款（CSV）" }));
    await waitFor(() => expect(download.file).toHaveBeenCalledWith(STUDY_ID, { direction: "trial_to_patient", protocolVersionId: "prt_screen", format: "csv", kind: "clauses" }));
    await userEvent.click(screen.getByRole("button", { name: "导出" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "每对一行（JSON）" }));
    await waitFor(() => expect(download.file).toHaveBeenLastCalledWith(STUDY_ID, { direction: "trial_to_patient", protocolVersionId: "prt_screen", format: "json", kind: "pairs" }));
  });

  it("offers no file to a reader who may not export or may not read patient-level data", async () => {
    await protocolPage({}, study((raw) => { raw.abilities = ["read", "run", "read_patient_level"]; }));
    expect(screen.queryByRole("button", { name: "导出" })).toBeNull();
  });

  it("names the people who failed, with their reasons in plain words", async () => {
    await protocolPage({ [JUDGED]: judged((page) => { page.failed = { count: 1, reasons: [{ reason: "模型回答超时", count: 1 }], listed: [{ subjectKey: "P-0313", kind: "protocol", id: "prt_screen", registryId: null, title: null, reason: "模型回答超时", at: null }] }; return page; }) });
    const failed = document.querySelector("[data-vcr-judged-failures]") as HTMLElement;
    expect(failed).toHaveTextContent("模型回答超时 1 位");
    await userEvent.click(within(failed).getByText(/^查看没判成的 1 位/));
    expect(within(failed).getByText("P-0313").closest("li")).toHaveTextContent("模型回答超时");
  });

  it("starts the judging of the protocol from the band and says its ceiling", async () => {
    await protocolPage({ [JUDGE]: { jobId: "job_x", state: "queued", estimate: { pairs: 16, cost: 12.5, currency: "CNY" } },
      [`GET ${MATCHING}`]: () => Object.assign(fixture("ev201/matching.json"), { candidateRoster: ["P-0192", "P-0300"] }) });
    await userEvent.click(await screen.findByRole("button", { name: "开始评估" }));
    expect(await screen.findByText("已开始 1 项评估，共 16 对，预计最多 12.50 灵豆；随时可以停止，判完的会保留。")).toBeInTheDocument();
  });

  it("a person's earlier assessment still reads when the judgments hold nothing on the protocol", async () => {
    server = installVcrServer(network.productRequest);
    draw(<MatchingTab studyId={STUDY_ID} study={study()} />);
    expect(await screen.findByRole("heading", { name: "P-0201" })).toBeInTheDocument();
    expect(document.querySelector("[data-vcr-candidate='P-0192']")).not.toBeNull();
    expect(screen.queryByRole("list", { name: "患者名单" }) && document.querySelector("[data-vcr-person]")).toBeNull();
  });
});

describe("给试验找患者 — on a phone", () => {
  it("lists the people as rows that stack, opens a person in a sheet, and has no table that scrolls sideways", async () => {
    server = installVcrServer(network.productRequest, { [JUDGED]: judged() });
    draw(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("list", { name: "患者名单" });
    expect(document.querySelector("table")).toBeNull();
    expect(document.querySelector("[data-vcr-person='P-0301']")?.querySelector("[class*='min-w-[']")).toBeNull();
    expect(document.querySelector("[data-vcr-funnel-clause='5']")).toHaveTextContent("不满足 3");
    await userEvent.click(within(document.querySelector("[data-vcr-person='P-0192']") as HTMLElement).getByRole("button", { name: "P-0192" }));
    const sheet = await screen.findByRole("dialog", { name: "P-0192" });
    await waitFor(() => expect(sheet.querySelector("[data-vcr-pair]")).not.toBeNull());
    expect(within(sheet).getByRole("heading", { name: "待查的信息" })).toBeInTheDocument();
  });
});

describe("a short name for a person, and a record that has moved since the judgment", () => {
  beforeEach(wide);
  const KEY = "Pee008d6ee9ef7847";

  it("reads a person by the short name the server sends and keeps the key for every request", async () => {
    await patientPage({ [JUDGED]: judged((page, query) => (query.get("direction") === "patient_to_trial"
      ? { ...page, subjectKey: KEY, label: "P-EE008D", trials: page.trials.map((trial: any) => ({ ...trial, subjectKey: KEY, label: "P-EE008D" })) }
      : page)) }, undefined, "P-EE008D 的试验");
    expect(screen.getByRole("heading", { name: "P-EE008D 的试验" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(KEY);
  });

  it("falls back to the same short form from the key when an older server sent none", async () => {
    await patientPage({ [JUDGED]: judged((page, query) => (query.get("direction") === "patient_to_trial"
      ? { ...page, subjectKey: KEY, label: undefined, trials: page.trials.map((trial: any) => ({ ...trial, subjectKey: KEY, label: undefined })) }
      : page)) }, undefined, "P-EE008D 的试验");
    expect(screen.getByRole("heading", { name: "P-EE008D 的试验" })).toBeInTheDocument();
  });

  it("says on a trial that its registry record changed, offers 重新判定 for those trials, and asks the server to judge them again for this person only", async () => {
    const stale = ["NCT05000001", "NCT05000003"];
    await patientPage({
      [JUDGED]: judged((page, query) => (query.get("direction") === "patient_to_trial"
        ? { ...page, progress: { ...page.progress, state: "done", jobId: null, waiting: 0 }, stale: { label: "登记记录已更新，可重新判定", count: 2, registryIds: stale },
          trials: page.trials.map((trial: any) => (stale.includes(trial.id) ? { ...trial, basisChanged: { kind: "registry_record", label: "登记记录已更新" } } : trial)) }
        : page)),
      [`POST ${MATCHING.replace("/matching", "")}/rejudge`]: { started: true, jobId: "job_again", jobs: [{ jobId: "job_again" }] },
    });
    expect(trialRow("NCT05000001")).toHaveTextContent("登记记录已更新");
    expect(trialRow("NCT05000002")).not.toHaveTextContent("登记记录已更新");
    const offer = document.querySelector("[data-vcr-stale]") as HTMLElement;
    expect(offer).toHaveTextContent("登记记录已更新，可重新判定（2 个试验）");
    await userEvent.click(within(offer).getByRole("button", { name: "重新判定" }));
    await waitFor(() => expect(server.calls.some((call) => call.method === "POST" && call.path === `/vcr/studies/${STUDY_ID}/rejudge`)).toBe(true));
    const sent = server.calls.find((call) => call.method === "POST" && call.path === `/vcr/studies/${STUDY_ID}/rejudge`);
    expect(sent?.body).toEqual({ subjectKey: "P-0192", registryIds: stale });
  });

  it("offers 重新判定 for the trials judged on an older note, and asks for exactly those", async () => {
    const older = ["NCT05000002", "NCT05000003"];
    await patientPage({
      [JUDGED]: judged((page, query) => (query.get("direction") === "patient_to_trial"
        ? { ...page, progress: { ...page.progress, state: "done", jobId: null, waiting: 0 },
          trials: page.trials.map((trial: any) => (older.includes(trial.id) ? { ...trial, basisChanged: { kind: "record", label: "病历在判定之后有更新" } } : trial)) }
        : page)),
      [`POST ${MATCHING.replace("/matching", "")}/rejudge`]: { started: true, jobId: "job_again", jobs: [{ jobId: "job_again" }] },
    });
    const offer = document.querySelector("[data-vcr-older-note]") as HTMLElement;
    expect(offer).toHaveTextContent("2 个试验的判定依据的是更新前的病历");
    await userEvent.click(within(offer).getByRole("button", { name: "重新判定" }));
    await waitFor(() => expect(server.calls.some((call) => call.method === "POST" && call.path === `/vcr/studies/${STUDY_ID}/rejudge`)).toBe(true));
    expect(server.calls.find((call) => call.method === "POST" && call.path === `/vcr/studies/${STUDY_ID}/rejudge`)?.body).toEqual({ subjectKey: "P-0192", registryIds: expect.arrayContaining(older) });
    expect((server.calls.find((call) => call.method === "POST" && call.path === `/vcr/studies/${STUDY_ID}/rejudge`)?.body as any).registryIds).toHaveLength(2);
  });

  it("offers no 重新判定 while the job is out, and words a chart that changed as one", async () => {
    const page = (change: any) => judged((raw, query) => (query.get("direction") === "patient_to_trial"
      ? { ...raw, ...change(raw), stale: { label: "登记记录已更新，可重新判定", count: 1, registryIds: ["NCT05000001"] },
        trials: raw.trials.map((trial: any, at: number) => (at === 0 ? { ...trial, basisChanged: { kind: "record", label: "病历在判定之后有更新" } } : trial)) }
      : raw));
    await patientPage({ [JUDGED]: page(() => ({})) });
    expect(trialRow("NCT05000001")).toHaveTextContent("病历在判定之后有更新");
    expect(within(document.querySelector("[data-vcr-stale]") as HTMLElement).queryByRole("button", { name: "重新判定" })).toBeNull();
  });
});
