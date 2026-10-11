import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { readVcrStudy, type VcrStudy } from "@/lib/vcrClient";
import { fixture, installVcrServer, STUDY_ID } from "../__fixtures__/serverFixtures";
import { DataTab } from "./DataTab";
import { MatchingTab } from "./MatchingTab";

// Only the network is doubled. The readers, the route functions and the tabs
// are the real ones, and every payload is the server's own fixture — or a copy
// of one with a single field changed.
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

vi.mock("@/lib/projects", () => ({
  useProjectStore: { getState: () => ({ projects: [{ id: "prj_ev201" }], select: vi.fn(), load: vi.fn() }) },
}));

const MATCHING = `/vcr/studies/${STUDY_ID}/matching`;
const DATA = `/vcr/studies/${STUDY_ID}/data`;

/** The study as the page hands it to a tab: the server's own answer, through the real reader. */
function study(change?: (raw: any) => void): VcrStudy {
  const raw = fixture("ev201/study.json");
  change?.(raw);
  return readVcrStudy(raw);
}

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function drawTab(node: React.ReactElement, path = `/app/virtual-research/${STUDY_ID}/matching`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/virtual-research/:studyId/:tab?" element={<>{node}<Where /></>} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

const matchingReads = (server: ReturnType<typeof installVcrServer>) =>
  server.calls.filter((call) => call.method === "GET" && call.path.startsWith(MATCHING)).map((call) => new URL(call.path, "http://x").searchParams);

let server: ReturnType<typeof installVcrServer>;

beforeEach(() => {
  server = installVcrServer(network.productRequest);
  toasts.success.mockReset();
  toasts.error.mockReset();
});

/* ------------------------------------------------------------------ 匹配与招募 */

describe("匹配与招募 — choosing a person", () => {
  it("asks for the matching view in the trial-to-patient direction first", async () => {
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    expect(await screen.findByRole("heading", { name: "P-0201" })).toBeInTheDocument();
    const [first] = matchingReads(server);
    expect(first.get("view")).toBe("matching");
    expect(first.get("direction")).toBe("trial_to_patient");
    expect(first.has("candidate")).toBe(false);
  });

  // UI-6: every candidate is a button, and choosing one re-reads the tab for
  // that person.
  it("re-reads the tab for the person chosen, with candidate= in the query", async () => {
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("button", { name: /^P-0192/ }));
    await waitFor(() => expect(matchingReads(server).some((query) => query.get("candidate") === "P-0192")).toBe(true));
    expect(await screen.findByRole("heading", { name: "P-0192" })).toBeInTheDocument();
    expect(screen.getByText("不能判为符合：排除标准 E1 未知")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^P-0192/ })).toHaveAttribute("aria-current", "true");
  });

  it("switches between both supported matching directions and reads each by name", async () => {
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    expect(matchingReads(server).every((query) => query.get("direction") === "trial_to_patient")).toBe(true);
    await userEvent.click(screen.getByRole("radio", { name: "给患者找试验" }));
    await waitFor(() => expect(matchingReads(server).some((query) => query.get("direction") === "patient_to_trial")).toBe(true));
    expect(screen.getByRole("radio", { name: "给患者找试验" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: "给试验找患者" }));
    await waitFor(() => expect(matchingReads(server).at(-1)?.get("direction")).toBe("trial_to_patient"));
    expect(screen.getByRole("radio", { name: "给试验找患者" })).toHaveAttribute("aria-checked", "true");
  });

  // The ranking hint orders a coordinator's work; it is never a probability.
  it("carries the clinical priority under its own label, with no number that reads as a probability", async () => {
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    const priority = screen.getByRole("button", { name: /^P-0192/ }).querySelector("[data-vcr-priority]") as HTMLElement;
    expect(priority).toHaveTextContent("临床优先级（不是获益概率） · ECOG 1，一线含铂后进展");
    expect(priority.textContent).not.toMatch(/0\.8|80\s*%|%/);
    expect(document.body.textContent).not.toMatch(/获益概率\s*[\d.]/);
  });
});

describe("匹配与招募 — 请求补证", () => {
  it("is off for a person with nothing to ask for", async () => {
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    expect(screen.getByRole("button", { name: "请求补证" })).toBeDisabled();
  });

  // A person with a referral has the request made on the ledger: the referral
  // moves to 待补证 and the move carries what was asked for.
  it("moves the person's referral to 待补证, with what was asked for and on which rules", async () => {
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("button", { name: /^P-0192/ }));
    await screen.findByRole("heading", { name: "P-0192" });
    await userEvent.click(screen.getByRole("button", { name: "请求补证" }));
    const requests = "E1 申请近 4 周头颅 MRI；E2 末次免疫治疗日期（10 月 18 日 起可复评）";
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(
      `/vcr/studies/${STUDY_ID}/referrals/ref_seed_1/transition`, "POST", { to: "needs_evidence", note: requests }));
    expect(server.calls.some((call) => call.path.endsWith("/decisions"))).toBe(false);
    expect(toasts.success).toHaveBeenCalledWith("已记录补证请求。");
  });

  it("is a second press of nothing while the first is in flight", async () => {
    let finish: (value: unknown) => void = () => undefined;
    server = installVcrServer(network.productRequest, {
      [`POST /vcr/studies/${STUDY_ID}/referrals/ref_seed_1/transition`]: () => new Promise((resolve) => { finish = resolve; }),
    });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("button", { name: /^P-0192/ }));
    await screen.findByRole("heading", { name: "P-0192" });
    const ask = screen.getByRole("button", { name: "请求补证" });
    await userEvent.click(ask);
    await userEvent.click(ask);
    expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    await act(async () => { finish({ referral: { id: "ref_seed_1", state: "needs_evidence" } }); });
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已记录补证请求。"));
  });

  it("says it was asked once the referral is 待补证, and does not ask twice", async () => {
    const payload = fixture("ev201/matching-p0192.json");
    payload.selected.referralState = "needs_evidence";
    payload.selected.canContact = false;
    server = installVcrServer(network.productRequest, { [`GET ${MATCHING}?view=matching&direction=trial_to_patient&candidate=P-0192`]: payload });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("button", { name: /^P-0192/ }));
    await screen.findByRole("heading", { name: "P-0192" });
    expect(await screen.findByRole("button", { name: "已请求补证" })).toBeDisabled();
  });

  it("is off for a reader who may write neither the ledger nor the record", async () => {
    const reader = study((raw) => { raw.abilities = ["read"]; });
    drawTab(<MatchingTab studyId={STUDY_ID} study={reader} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("button", { name: /^P-0192/ }));
    await screen.findByRole("heading", { name: "P-0192" });
    expect(screen.getByRole("button", { name: "请求补证" })).toBeDisabled();
  });

  // A coordinator (`write_referrals`) moves the ledger without the lead's `write`.
  it("is on for a coordinator, who holds the ledger and not the study's write", async () => {
    const coordinator = study((raw) => { raw.abilities = ["read", "write_referrals", "contact_patients"]; });
    drawTab(<MatchingTab studyId={STUDY_ID} study={coordinator} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("button", { name: /^P-0192/ }));
    await screen.findByRole("heading", { name: "P-0192" });
    await userEvent.click(screen.getByRole("button", { name: "请求补证" }));
    await waitFor(() => expect(server.calls.some((call) => call.path.endsWith("/referrals/ref_seed_1/transition"))).toBe(true));
  });

  // With no referral yet the request has nowhere on the ledger to go: it is
  // the study's own decision record, as before the ledger existed.
  it("records the request in the study's decisions when the person has no referral yet", async () => {
    const payload = fixture("ev201/matching-p0192.json");
    payload.selected.referralId = null;
    payload.selected.referralState = null;
    payload.selected.canContact = false;
    payload.selected.candidate.referralId = null;
    server = installVcrServer(network.productRequest, { [`GET ${MATCHING}?view=matching&direction=trial_to_patient&candidate=P-0192`]: payload });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("button", { name: /^P-0192/ }));
    await screen.findByRole("heading", { name: "P-0192" });
    await userEvent.click(screen.getByRole("button", { name: "请求补证" }));
    const requests = "E1 申请近 4 周头颅 MRI；E2 末次免疫治疗日期（10 月 18 日 起可复评）";
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/decisions`, "POST", {
      question: `请求补证 P-0192：${requests}`,
      chosen: { kind: "evidence_request", subject: "P-0192", criteria: ["E1", "E2"] },
      rationale: requests,
    }));
  });
});

describe("匹配与招募 — 确认后联系, the one human stop", () => {
  it("is off where the server says the person cannot be contacted", async () => {
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    expect(screen.getByRole("button", { name: "确认后联系" })).toBeDisabled();
  });

  it("is off for a reader who may not contact patients, even where the referral allows it", async () => {
    const reader = study((raw) => { raw.abilities = raw.abilities.filter((ability: string) => ability !== "contact_patients"); });
    drawTab(<MatchingTab studyId={STUDY_ID} study={reader} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("button", { name: /^P-0192/ }));
    await screen.findByRole("heading", { name: "P-0192" });
    expect(screen.getByRole("button", { name: "确认后联系" })).toBeDisabled();
  });

  // UI-2: the id posted is the referral's, never the subject's key; CW-18: a
  // second confirm while the first is in flight sends nothing.
  it("asks per person, then posts the referral id once", async () => {
    let finish: (value: unknown) => void = () => undefined;
    server = installVcrServer(network.productRequest, {
      [`POST /vcr/studies/${STUDY_ID}/referrals/ref_seed_1/contact`]: () => new Promise((resolve) => { finish = resolve; }),
    });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("button", { name: /^P-0192/ }));
    await screen.findByRole("heading", { name: "P-0192" });
    await userEvent.click(screen.getByRole("button", { name: "确认后联系" }));
    const dialog = await screen.findByRole("alertdialog", { name: "确认联系 P-0192？" });
    expect(dialog.textContent).not.toMatch(/交给协调员/);
    expect(server.calls.some((call) => call.path.includes("/contact"))).toBe(false);
    await userEvent.click(within(dialog).getByRole("button", { name: "确认联系" }));
    // The dialog holds still while the request is in flight: the confirming
    // button is disabled and busy, and there is no way to press it again.
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "确认联系" })).toBeDisabled());
    expect(within(dialog).getByRole("button", { name: "确认联系" })).toHaveAttribute("aria-busy", "true");
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("button", { name: "确认联系" }));
    const contacts = server.calls.filter((call) => call.method === "POST" && call.path.includes("/contact"));
    expect(contacts).toEqual([{ method: "POST", path: `/vcr/studies/${STUDY_ID}/referrals/ref_seed_1/contact`, body: {} }]);
    await act(async () => { finish({}); });
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已记录联系确认。"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("匹配与招募 — a person the ledger has not taken in", () => {
  it("says the candidate is not yet contactable, and offers no way to confirm a contact", async () => {
    const payload = fixture("ev201/matching-p0192.json");
    payload.selected.referralId = null;
    payload.selected.referralState = null;
    payload.selected.canContact = false;
    payload.selected.candidate.referralId = null;
    server = installVcrServer(network.productRequest, { [`GET ${MATCHING}?view=matching&direction=trial_to_patient&candidate=P-0192`]: payload });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("button", { name: /^P-0192/ }));
    await screen.findByRole("heading", { name: "P-0192" });
    expect(screen.getByRole("button", { name: "确认后联系" })).toBeDisabled();
    expect(document.querySelector("[data-vcr-not-contactable]")).toHaveTextContent("尚未生成转诊记录，暂不能联系。");
  });

  it("does not say it of a person who has a referral", async () => {
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    expect(document.querySelector("[data-vcr-not-contactable]")).toBeNull();
  });
});

describe("匹配与招募 — the referral's own trail", () => {
  // Every step leaves its mark (plan §7.2): who moved the referral, to where, when.
  it("lists every move made on the person's referral, oldest first, with who and what was said", async () => {
    const payload = fixture("ev201/matching-p0192.json");
    payload.selected.trace = [
      { state: "candidate", at: "9 月 27 日 17:40", by: "平台", note: null },
      { state: "needs_evidence", at: "今天 14:32", by: "王协调", note: "E1 申请近 4 周头颅 MRI" },
    ];
    server = installVcrServer(network.productRequest, { [`GET ${MATCHING}?view=matching&direction=trial_to_patient&candidate=P-0192`]: payload });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("button", { name: /^P-0192/ }));
    await screen.findByRole("heading", { name: "P-0192" });
    const trail = await screen.findByRole("list", { name: "转诊记录" });
    const steps = within(trail).getAllByRole("listitem");
    expect(steps.map((step) => step.textContent)).toEqual([
      "9 月 27 日 17:40候选平台",
      "今天 14:32待补证王协调E1 申请近 4 周头颅 MRI",
    ]);
  });

  it("draws no trail for a person whose referral has no recorded moves", async () => {
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    expect(document.querySelector("[data-vcr-referral-trace]")).toBeNull();
  });
});

describe("匹配与招募 — what a rule says about a person", () => {
  // 不适用 is its own field (plan §7.1), never folded into 未知.
  it("marks a rule that does not apply as 不适用, not 未知", async () => {
    const payload = fixture("ev201/matching-p0192.json");
    const e3 = payload.selected.criteria.find((row: { code: string }) => row.code === "E3");
    e3.applicable = false;
    e3.state = "unknown";
    server = installVcrServer(network.productRequest, { [`GET ${MATCHING}`]: payload });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    const row = await waitFor(() => {
      const found = document.querySelector("[data-vcr-criterion='E3']");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(row).toHaveAttribute("data-vcr-criterion-state", "not_applicable");
    expect(row).toHaveTextContent("不适用");
    expect(row).not.toHaveTextContent("未知");
    // The rule that is unknown stays unknown.
    expect(document.querySelector("[data-vcr-criterion='E1']")).toHaveTextContent("未知");
  });

  it("shows who waits in 待复核排除 when the server sends them", async () => {
    const payload = fixture("ev201/matching.json");
    payload.pendingReview = { count: 2, subjects: ["P-0300", "P-0301"] };
    server = installVcrServer(network.productRequest, { [`GET ${MATCHING}`]: payload });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    expect(await screen.findByText("待复核排除")).toBeInTheDocument();
    const zone = document.querySelector("[data-vcr-pending-review]") as HTMLElement;
    expect(within(zone).getByText("P-0300")).toBeInTheDocument();
    expect(screen.getByText("2 人")).toBeInTheDocument();
  });

  it("says 已撤回 beside a person whose consent was withdrawn, and nothing beside the others", async () => {
    const payload = fixture("ev201/matching.json");
    payload.candidates[0].basis = "withdrawn";
    server = installVcrServer(network.productRequest, { [`GET ${MATCHING}`]: payload });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: payload.candidates[0].id });
    const withdrawn = document.querySelector(`[data-vcr-candidate='${payload.candidates[0].id}']`) as HTMLElement;
    expect(within(withdrawn).getByText("已撤回")).toBeInTheDocument();
    const others = payload.candidates.slice(1).map((candidate: { id: string }) => document.querySelector(`[data-vcr-candidate='${candidate.id}']`) as HTMLElement).filter(Boolean);
    expect(others.length).toBeGreaterThan(0);
    for (const other of others) expect(within(other).queryByText("已撤回")).toBeNull();
  });

  it("says 依据已更新 beside a person whose evaluation rested on a basis that has since changed", async () => {
    const payload = fixture("ev201/matching.json");
    payload.candidates[0].basis = "updated";
    payload.basisUpdated = { count: 1, subjects: [payload.candidates[0].id] };
    server = installVcrServer(network.productRequest, { [`GET ${MATCHING}`]: payload });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: payload.candidates[0].id });
    const changed = document.querySelector(`[data-vcr-candidate='${payload.candidates[0].id}']`) as HTMLElement;
    expect(within(changed).getByText("依据已更新")).toBeInTheDocument();
    expect(screen.getByText("1 人的评估依据已更新")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新评估" })).toBeEnabled();
  });

  it("says the recruiting side is not here, and nothing else waits", async () => {
    server = installVcrServer(network.productRequest, {
      [`GET ${MATCHING}`]: { view: "matching", available: false, unavailable: { code: "vcr_matching_unavailable", message: "匹配与招募在本部署尚未接入；其余步骤照常。" }, funnel: [], candidates: [], selected: null, gaps: [], counts: null },
    });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    expect(await screen.findByText("匹配与招募在本部署尚未接入；其余步骤照常。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "让 AI 做" })).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});

describe("匹配与招募 — before anything has been judged", () => {
  const T0_SENTENCE = "这项研究现在只有公开资料（T0），没有可以匹配的真实患者。让 AI 做会把入排条件整理成逐条可判定的标准；接入你的数据（T1 及以上）后才能逐个匹配、转诊和随访。";
  const emptyPage = () => ({ view: "matching", available: true, direction: "trial_to_patient", funnel: [], candidates: [], selected: null, gaps: [], counts: null,
    forecast: null, pendingReview: null, ledger: [], sites: [], followup: [], headline: null, partner: null });
  const idle = (raw: any) => { raw.steps.matching = { status: "none", requested: false }; };

  it("at T0 is the one sentence and one button — no export, no four views over it — and the sentence says there is nobody to match", async () => {
    server = installVcrServer(network.productRequest, { [`GET ${MATCHING}`]: emptyPage() });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study(idle)} />);
    expect(await screen.findByText(T0_SENTENCE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "让 AI 做" })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "匹配与招募的视图" })).toBeNull();
    expect(screen.queryByRole("button", { name: /导出纠正案例/ })).toBeNull();
    expect(screen.queryByText(/每个人是否符合/)).toBeNull();
  });

  it("above T0 keeps the step's own sentence — there are people to judge", async () => {
    server = installVcrServer(network.productRequest, { [`GET ${MATCHING}`]: emptyPage() });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study((raw) => { idle(raw); raw.tier = "T1"; })} />);
    expect(await screen.findByText("还没有匹配评估：逐条判定每个人是否符合入排条件，并给出补证建议。")).toBeInTheDocument();
    expect(screen.queryByText(T0_SENTENCE)).toBeNull();
    expect(screen.getByRole("button", { name: "让 AI 做" })).toBeInTheDocument();
  });

  it("keeps the switch of views for a reader who chose a view that came back empty — the way back to the matching one", async () => {
    server = installVcrServer(network.productRequest, {
      [`GET ${MATCHING}`]: ({ query }: { query: URLSearchParams }) => (query.get("view") === "sites" ? emptyPage() : fixture("ev201/matching.json")),
    });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("radio", { name: "中心" }));
    await screen.findByRole("button", { name: "让 AI 做" });
    const views = screen.getByRole("radiogroup", { name: "匹配与招募的视图" });
    await userEvent.click(within(views).getByRole("radio", { name: "匹配" }));
    expect(await screen.findByRole("heading", { name: "P-0201" })).toBeInTheDocument();
  });
});

describe("匹配与招募 — a study with protocol versions and nothing evaluated yet", () => {
  // Review V-M4/V-M5: with a protocol present the empty tab drew export, four views, two directions, a protocol select and a folded
  // panel above the empty state, and the action that starts an evaluation was inside the fold.
  const idle = (raw: any) => { raw.steps.matching = { status: "none", requested: false }; };
  const unevaluated = (change?: (page: any) => void) => {
    const page = fixture("ev201/matching.json");
    Object.assign(page, { candidates: [], selected: null, funnel: [], gaps: [], comparisons: [], timeline: [], forecast: null, pendingReview: null, ledger: [],
      sites: [], followup: [], headline: null, partner: null, counts: null, candidateRoster: ["P-0300", "P-0301"] });
    change?.(page);
    return page;
  };
  const JOBS = `POST /vcr/studies/${STUDY_ID}/jobs`;

  it("is the step's sentence and one 开始评估 — no toolbar, no controls over it — and the button queues the protocol in view for the registered people", async () => {
    server = installVcrServer(network.productRequest, {
      [`GET ${MATCHING}`]: unevaluated(),
      [JOBS]: { jobs: [{ jobId: "job_1", state: "queued" }], unavailable: [] },
    });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study(idle)} />);
    const start = await screen.findByRole("button", { name: "开始评估" });
    expect(screen.getByText("还没有匹配评估：逐条判定每个人是否符合入排条件，并给出补证建议。")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByLabelText("查看方案")).toBeNull();
    expect(screen.queryByRole("button", { name: "让 AI 做" })).toBeNull();
    await userEvent.click(start);
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/jobs`, "POST",
      { kind: "match_criteria", selection: { protocolVersionIds: ["prt_1"], direction: "trial_to_patient" } }));
    expect(await screen.findByText("已提交 1 项评估。")).toBeInTheDocument();
    // The job runs on its own time: the way to read the answer is next to the sentence that says it was asked.
    const reads = matchingReads(server).length;
    await userEvent.click(screen.getByRole("button", { name: "刷新结果" }));
    await waitFor(() => expect(matchingReads(server).length).toBeGreaterThan(reads));
  });

  it("says nothing was submitted, and why, when the evaluation could not be queued", async () => {
    server = installVcrServer(network.productRequest, {
      [`GET ${MATCHING}`]: unevaluated(),
      [JOBS]: { jobs: [], unavailable: [{ code: "vcr_criteria_missing" }] },
    });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study(idle)} />);
    await userEvent.click(await screen.findByRole("button", { name: "开始评估" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("没有提交评估。方案还没有结构化的入排条件，无法匹配。");
  });

  it("keeps the step's own ask when nobody is registered to evaluate — there is nothing for 开始评估 to work on", async () => {
    server = installVcrServer(network.productRequest, { [`GET ${MATCHING}`]: unevaluated((page) => { page.candidateRoster = []; }) });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study(idle)} />);
    expect(await screen.findByRole("button", { name: "让 AI 做" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开始评估" })).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("offers no 开始评估 to a reader who may not run it", async () => {
    server = installVcrServer(network.productRequest, { [`GET ${MATCHING}`]: unevaluated() });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study((raw) => { idle(raw); raw.tier = "T1"; raw.abilities = ["read", "write"]; })} />);
    expect(await screen.findByText("还没有匹配评估：逐条判定每个人是否符合入排条件，并给出补证建议。")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the controls, with 开始评估 in plain sight, once the reader has chosen a direction and the answer is empty", async () => {
    server = installVcrServer(network.productRequest, {
      [`GET ${MATCHING}`]: ({ query }: { query: URLSearchParams }) => (query.get("direction") === "patient_to_trial"
        ? unevaluated()
        : withProtocols()),
    });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("radio", { name: "给患者找试验" }));
    expect(await screen.findByLabelText("查看方案")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "匹配方向" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始评估" }).closest("details")).toBeNull();
  });
});

describe("匹配与招募 — the switch of direction is always the way back", () => {
  // Review V-M3: a study with candidates and no protocol version drew the tab with its toolbar; choosing 给患者找试验 (which comes back
  // empty) replaced the whole tab with the one-line step ask, toolbar and all, and the only way back was to reload the page.
  it("keeps the direction and view switches where the reader chose a direction that came back empty, and goes back from there", async () => {
    server = installVcrServer(network.productRequest, {
      [`GET ${MATCHING}`]: ({ query }: { query: URLSearchParams }) => {
        if (query.get("direction") === "patient_to_trial") {
          return { view: "matching", available: true, direction: "patient_to_trial", funnel: [], candidates: [], selected: null, gaps: [], counts: null,
            forecast: null, pendingReview: null, ledger: [], sites: [], followup: [], headline: null, partner: null };
        }
        const page = fixture("ev201/matching.json");
        Object.assign(page, { protocols: [], protocolVersionId: null, comparisons: [], timeline: [], candidateRoster: [] });
        return page;
      },
    });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("radio", { name: "给患者找试验" }));
    await screen.findByRole("button", { name: "让 AI 做" });
    expect(screen.getByRole("radiogroup", { name: "匹配方向" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "匹配与招募的视图" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "给试验找患者" }));
    expect(await screen.findByRole("heading", { name: "P-0201" })).toBeInTheDocument();
  });
});

/** The page contract's two ids: the assessment the panel is about, and each rule's own id. */
function addressed(payload: any) {
  payload.selected.assessmentId = "asm_192";
  for (const criterion of payload.selected.criteria) criterion.criterionId = `crt_${criterion.code}`;
  return payload;
}
const P0192 = `GET ${MATCHING}?view=matching&direction=trial_to_patient&candidate=P-0192`;
const criterionRow = (code: string) => document.querySelector(`[data-vcr-criterion='${code}']`) as HTMLElement;

describe("匹配与招募 — 改判, a person's hand on a rule", () => {
  async function open(change?: (payload: any) => void, reader: VcrStudy = study()) {
    const payload = addressed(fixture("ev201/matching-p0192.json"));
    change?.(payload);
    server = installVcrServer(network.productRequest, { [P0192]: payload });
    drawTab(<MatchingTab studyId={STUDY_ID} study={reader} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("button", { name: /^P-0192/ }));
    await screen.findByRole("heading", { name: "P-0192" });
  }

  it("posts the person's state and their grounds to the rule of the assessment the panel is about, then re-reads the person", async () => {
    await open();
    await userEvent.click(within(criterionRow("E1")).getByRole("button", { name: "改判" }));
    expect(await screen.findByText("平台判为：未知")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("你的判定"), "not_satisfied");
    await userEvent.type(screen.getByLabelText("依据"), "病历写明有脑转移");
    const reads = matchingReads(server).length;
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(
      `/vcr/studies/${STUDY_ID}/assessments/asm_192/judgments/crt_E1/override`, "POST", { state: "not_satisfied", note: "病历写明有脑转移" }));
    expect(toasts.success).toHaveBeenCalledWith("已记录改判。");
    await waitFor(() => expect(matchingReads(server).length).toBeGreaterThan(reads));
    expect(screen.queryByLabelText("你的判定")).toBeNull();
  });

  it("sends the state alone when no grounds were given, and is one request however often 保存 is pressed", async () => {
    let finish: (value: unknown) => void = () => undefined;
    await open();
    server = installVcrServer(network.productRequest, {
      [P0192]: addressed(fixture("ev201/matching-p0192.json")),
      [`POST /vcr/studies/${STUDY_ID}/assessments/asm_192/judgments/crt_E1/override`]: () => new Promise((resolve) => { finish = resolve; }),
    });
    await userEvent.click(within(criterionRow("E1")).getByRole("button", { name: "改判" }));
    const save = await screen.findByRole("button", { name: "保存" });
    await userEvent.click(save);
    await userEvent.click(save);
    expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(server.calls.find((call) => call.method === "POST")?.body).toEqual({ state: "unknown" });
    await act(async () => { finish({}); });
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已记录改判。"));
  });

  it("says a refusal in words and keeps the drawer for another try", async () => {
    await open();
    server = installVcrServer(network.productRequest, {
      [`POST /vcr/studies/${STUDY_ID}/assessments/asm_192/judgments/crt_E1/override`]: () => { throw new WebApiError("no", { status: 404, code: "vcr_assessment_not_found" }); },
    });
    await userEvent.click(within(criterionRow("E1")).getByRole("button", { name: "改判" }));
    await userEvent.click(await screen.findByRole("button", { name: "保存" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(screen.getByLabelText("你的判定")).toBeInTheDocument();
  });

  it("marks a rule whose state is a person's", async () => {
    await open((payload) => { payload.selected.criteria.find((row: any) => row.code === "E1").overridden = true; });
    expect(criterionRow("E1").querySelector("[data-vcr-overridden]")).toHaveTextContent("人工改判");
    expect(criterionRow("E2").querySelector("[data-vcr-overridden]")).toBeNull();
  });

  it("offers no 改判 or 复核 for a panel that does not name its assessment", async () => {
    await open((payload) => { delete payload.selected.assessmentId; });
    expect(screen.queryByRole("button", { name: "改判" })).toBeNull();
    expect(screen.queryByRole("button", { name: "复核这份评估" })).toBeNull();
  });

  it("offers no 改判 on a rule that does not name itself", async () => {
    await open((payload) => { for (const row of payload.selected.criteria) delete row.criterionId; });
    expect(screen.queryByRole("button", { name: "改判" })).toBeNull();
    expect(screen.getByRole("button", { name: "复核这份评估" })).toBeEnabled();
  });

  it("offers none to a reader who may neither write the ledger nor review", async () => {
    await open(undefined, study((raw) => { raw.abilities = ["read", "write", "contact_patients"]; }));
    expect(screen.queryByRole("button", { name: "改判" })).toBeNull();
    expect(screen.queryByRole("button", { name: "复核这份评估" })).toBeNull();
  });

  it("is on for a coordinator, who re-judges without the study's review", async () => {
    await open(undefined, study((raw) => { raw.abilities = ["read", "write_referrals"]; }));
    expect(within(criterionRow("E1")).getByRole("button", { name: "改判" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "复核这份评估" })).toBeNull();
  });
});

describe("匹配与招募 — 复核这份评估, a reviewer's countersignature", () => {
  async function open(change?: (payload: any) => void, reader: VcrStudy = study()) {
    const payload = addressed(fixture("ev201/matching-p0192.json"));
    change?.(payload);
    server = installVcrServer(network.productRequest, { [P0192]: payload });
    drawTab(<MatchingTab studyId={STUDY_ID} study={reader} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("button", { name: /^P-0192/ }));
    await screen.findByRole("heading", { name: "P-0192" });
  }

  it("countersigns the assessment named in the path, once, and re-reads the person", async () => {
    await open();
    const reads = matchingReads(server).length;
    await userEvent.click(screen.getByRole("button", { name: "复核这份评估" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/assessments/asm_192/review`, "POST", {}));
    expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(toasts.success).toHaveBeenCalledWith("已记录复核。");
    await waitFor(() => expect(matchingReads(server).length).toBeGreaterThan(reads));
  });

  it("is one signature however often it is pressed while the first is in flight", async () => {
    let finish: (value: unknown) => void = () => undefined;
    await open();
    server = installVcrServer(network.productRequest, {
      [P0192]: addressed(fixture("ev201/matching-p0192.json")),
      [`POST /vcr/studies/${STUDY_ID}/assessments/asm_192/review`]: () => new Promise((resolve) => { finish = resolve; }),
    });
    const sign = screen.getByRole("button", { name: "复核这份评估" });
    await userEvent.click(sign);
    await userEvent.click(sign);
    expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    await act(async () => { finish({}); });
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已记录复核。"));
  });

  it("says who signed an assessment that is reviewed, and offers no second signature", async () => {
    await open((payload) => { payload.selected.reviewedBy = "reviewer-1"; payload.selected.reviewedByName = "赵复核"; });
    expect(document.querySelector("[data-vcr-reviewed-by]")).toHaveTextContent("已复核 · 赵复核");
    expect(document.querySelector("[data-vcr-reviewed-by]")).not.toHaveTextContent("reviewer-1");
    expect(screen.queryByRole("button", { name: "复核这份评估" })).toBeNull();
  });

  it("never prints the account id of whoever signed: with no name it says nothing of them", async () => {
    await open((payload) => { payload.selected.reviewedBy = "usr_3f9a"; payload.selected.reviewedByName = null; });
    expect(document.querySelector("[data-vcr-reviewed-by]")).toHaveTextContent("已复核");
    expect(document.querySelector("[data-vcr-reviewed-by]")).not.toHaveTextContent("usr_3f9a");
    expect(screen.queryByRole("button", { name: "复核这份评估" })).toBeNull();
  });

  it("is a clinical reviewer's, not a coordinator's", async () => {
    await open(undefined, study((raw) => { raw.abilities = ["read", "review_clinical"]; }));
    expect(screen.getByRole("button", { name: "复核这份评估" })).toBeEnabled();
    expect(within(criterionRow("E1")).getByRole("button", { name: "改判" })).toBeEnabled();
  });
});

describe("匹配与招募 — every citation a verdict rests on (E-06)", () => {
  it("shows each citation with the document it is in and the date of what it records, the first being the rule's evidence", async () => {
    const payload = addressed(fixture("ev201/matching-p0192.json"));
    const row = payload.selected.criteria.find((entry: any) => entry.code === "E1");
    const citation = (quote: string, source: string, at: string, start: number) => ({ quote, source, at, locator: { documentId: "prj_x", start, end: start + 8 } });
    row.evidence = citation("2026-09-26 处方多西他赛", "document-aaaa1111.txt", "9 月 26 日", 0);
    row.evidenceItems = [row.evidence, citation("2026-06-01 给予多西他赛", "document-bbbb2222.txt", "6 月 1 日", 40)];
    server = installVcrServer(network.productRequest, { [P0192]: payload });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("button", { name: /^P-0192/ }));
    await screen.findByRole("heading", { name: "P-0192" });
    const cell = criterionRow("E1");
    expect(cell).toHaveTextContent("“2026-09-26 处方多西他赛”");
    expect(cell).toHaveTextContent("document-aaaa1111.txt · 9 月 26 日");
    expect(cell).toHaveTextContent("“2026-06-01 给予多西他赛”");
    expect(cell).toHaveTextContent("document-bbbb2222.txt · 6 月 1 日");
  });
});

describe("匹配与招募 — what the evidence of a rule has been through", () => {
  // Review V-M8: negation, a correction and a conflict were told only in the folded timeline at the foot of the tab, so a 满足 or 不满足
  // on a rule's own row said nothing of its evidence having been denied, corrected or contradicted, nor whose records the fold held.
  const AT = (start: number) => ({ documentId: "doc_192", start, end: start + 8 });
  const entry = (extra: Record<string, unknown>) => ({ id: "f_x", variable: "v", value: null, unit: null, at: null, assertion: "affirmed", experiencer: "patient",
    medicationState: null, correctionOf: null, quote: null, superseded: false, conflictFactIds: [], correctionReason: null, locator: null, ...extra });
  const cite = (code: string, quote: string, locator: unknown) => (payload: any) => {
    payload.selected.criteria.find((row: any) => row.code === code).evidence = { quote, locator, source: "病历原文", at: "9 月 1 日" };
  };
  async function open(change: (payload: any) => void, reader: VcrStudy = study()) {
    const payload = addressed(fixture("ev201/matching-p0192.json"));
    change(payload);
    server = installVcrServer(network.productRequest, { [P0192]: payload });
    drawTab(<MatchingTab studyId={STUDY_ID} study={reader} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("button", { name: /^P-0192/ }));
    await screen.findByRole("heading", { name: "P-0192" });
  }
  const timeline = (payload: any) => {
    cite("I1", "否认脑转移", AT(10))(payload);
    cite("I2", "ECOG 1 分", AT(40))(payload);
    cite("I3", "一线含铂双药", AT(70))(payload);
    payload.timeline = [
      entry({ id: "f_1", variable: "brain_mets", quote: "否认脑转移", assertion: "negated", locator: AT(10) }),
      entry({ id: "f_2", variable: "ecog", quote: "ECOG 1 分", superseded: true, conflictFactIds: ["f_4"], locator: AT(40) }),
      entry({ id: "f_3", variable: "platinum", quote: "一线含铂双药", correctionOf: "f_0", correctionReason: "检验科更正", locator: AT(70) }),
      entry({ id: "f_4", variable: "ecog", quote: "ECOG 2 分", conflictFactIds: ["f_2"], locator: AT(120) }),
    ];
  };

  it("tags a rule whose evidence was denied, one that has since been corrected or contradicted, and one that is itself a correction — on the rule's own row", async () => {
    await open(timeline);
    expect(within(criterionRow("I1")).getByText("已否认")).toBeInTheDocument();
    expect(within(criterionRow("I2")).getByText("已有更正")).toBeInTheDocument();
    expect(within(criterionRow("I2")).getByText("记录有冲突")).toBeInTheDocument();
    expect(within(criterionRow("I3")).getByText("更正记录")).toBeInTheDocument();
    // The mark itself is unchanged: the tag says what the evidence went through, the state says what the platform judged.
    expect(criterionRow("I1")).toHaveAttribute("data-vcr-criterion-state", "satisfied");
  });

  it("tags nothing on a rule that has no evidence, or whose evidence is a cell of the data table", async () => {
    await open(timeline);
    // I1..I3 carry caveats; the rule with no evidence and the snapshot cells do not.
    for (const code of ["E1", "E2", "E3"]) expect(criterionRow(code).querySelector("[data-vcr-caveats]")).toBeNull();
  });

  it("tags nothing on a rule whose evidence no recorded fact stands behind", async () => {
    await open((payload) => { timeline(payload); payload.timeline = payload.timeline.filter((fact: any) => fact.id === "f_4"); });
    expect(document.querySelectorAll("[data-vcr-caveats]")).toHaveLength(0);
  });

  it("tags nothing when the page carries no timeline — a reader who may not read patient-level records sees no facts to tag", async () => {
    await open((payload) => { timeline(payload); payload.timeline = []; });
    expect(document.querySelectorAll("[data-vcr-caveats]")).toHaveLength(0);
  });

  it("names whose records the fold holds", async () => {
    await open(timeline);
    expect(screen.getByText("P-0192 的临床记录与更正")).toBeInTheDocument();
  });
});

describe("匹配与招募 — whose records the timeline holds", () => {
  // The timeline under the panel is the facts of the person the page was asked for (`?candidate=`). An unevaluated person has no
  // assessment, so the server answers with their facts under the first candidate's panel: the two are different people, and the
  // fold must say whose facts it holds, and the rows of the panel must not be tagged from another person's facts.
  const AT = { documentId: "doc_shared", start: 10, end: 18 };
  const fact = (id: string, extra: Record<string, unknown> = {}) => ({ id, variable: "brain_mets", value: null, unit: null, at: null, assertion: "affirmed",
    experiencer: "patient", medicationState: null, correctionOf: null, quote: "否认脑转移", superseded: false, conflictFactIds: [], correctionReason: null,
    locator: AT, ...extra });
  /** The first candidate's page; the panel's first rule cites a span of a document, and `facts` are the page's timeline. */
  const page = (facts: unknown[]) => {
    const raw = fixture("ev201/matching.json");
    raw.candidateRoster = ["P-0300"];
    raw.selected.criteria[0].evidence = { quote: "否认脑转移", locator: AT, source: "病历原文", at: "9 月 1 日" };
    raw.timeline = facts;
    return raw;
  };
  const NEGATED = fact("f_neg", { assertion: "negated" });

  it("names the person the page was asked for, not the person of the panel above it, when they are two", async () => {
    server = installVcrServer(network.productRequest, {
      [`GET ${MATCHING}`]: ({ query }: { query: URLSearchParams }) => page(query.get("candidate") === "P-0300"
        ? [fact("f_300", { quote: "P-0300 的既往史", locator: { documentId: "doc_300", start: 0, end: 8 } })]
        : [fact("f_201", { quote: "P-0201 的既往史", locator: { documentId: "doc_201", start: 0, end: 8 } })]),
    });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    // Nobody was asked for: the page's own person.
    expect(screen.getByText("P-0201 的临床记录与更正")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("患者"), "P-0300");
    expect(await screen.findByText("P-0300 的临床记录与更正")).toBeInTheDocument();
    expect(screen.queryByText("P-0201 的临床记录与更正")).toBeNull();
    // The server has no assessment of P-0300, so the panel is still the first candidate's.
    expect(screen.getByRole("heading", { name: "P-0201" })).toBeInTheDocument();
  });

  it("keeps naming the person whose facts are on screen while the next person's page is read", async () => {
    let arrive: (value: unknown) => void = () => undefined;
    server = installVcrServer(network.productRequest, {
      [`GET ${MATCHING}`]: ({ query }: { query: URLSearchParams }) => (query.get("candidate") === "P-0192"
        ? new Promise((resolve) => { arrive = resolve; })
        : page([fact("f_201", { quote: "P-0201 的既往史", locator: { documentId: "doc_201", start: 0, end: 8 } })])),
    });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("button", { name: /^P-0192/ }));
    await waitFor(() => expect(matchingReads(server).some((query) => query.get("candidate") === "P-0192")).toBe(true));
    // P-0192's page has not come: the facts are still P-0201's, and so is the name over them.
    expect(screen.getByText("P-0201 的临床记录与更正")).toBeInTheDocument();
    expect(screen.queryByText("P-0192 的临床记录与更正")).toBeNull();
    // It comes — the server's own page for P-0192, with that person's facts — and the name follows the facts.
    const arrived = fixture("ev201/matching-p0192.json");
    arrived.timeline = [fact("f_192", { quote: "P-0192 的既往史", locator: { documentId: "doc_192", start: 0, end: 8 } })];
    await act(async () => { arrive(arrived); });
    expect(await screen.findByText("P-0192 的临床记录与更正")).toBeInTheDocument();
    expect(screen.queryByText("P-0201 的临床记录与更正")).toBeNull();
  });

  it("tags the rules of the panel from the panel's person's facts, and from nobody else's", async () => {
    server = installVcrServer(network.productRequest, {
      // Whoever the facts are, one of them is a denial of the span the first rule of the panel cites: a shared document.
      [`GET ${MATCHING}`]: ({ query }: { query: URLSearchParams }) => {
        const raw = page([NEGATED]);
        // The page asked for P-0300 is told apart by its list: the second candidate is not in it.
        if (query.get("candidate") === "P-0300") raw.candidates = raw.candidates.slice(0, 1);
        return raw;
      },
    });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    expect(within(criterionRow("I1")).getByText("已否认")).toBeInTheDocument();
    // Asked for another person, the panel is still P-0201's but the facts are not: the rule is not tagged by them.
    await userEvent.selectOptions(screen.getByLabelText("患者"), "P-0300");
    await waitFor(() => expect(screen.queryByRole("button", { name: /^P-0207/ })).toBeNull());
    expect(screen.getByRole("heading", { name: "P-0201" })).toBeInTheDocument();
    expect(document.querySelectorAll("[data-vcr-caveats]")).toHaveLength(0);
  });
});

describe("匹配与招募 — one word for the person", () => {
  // Review V-M9: the direction switch said 患者 and the select beside it 受试者. The product's own word in the recruiting tab
  // is 患者 (给试验找患者, 患者证据, 匹配患者, 联系真实患者).
  it("says 患者 in the controls and in the referral ledger, and never 受试者", async () => {
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    expect(screen.getByLabelText("患者")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "全部已登记患者" })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/受试者/);
    await userEvent.click(screen.getByRole("radio", { name: "转诊" }));
    expect(await screen.findByRole("columnheader", { name: "患者" })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/受试者/);
  });
});

describe("匹配与招募 — the other three views", () => {
  it("reads the referral ledger and the forecast from the server's referral view", async () => {
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("radio", { name: "转诊" }));
    await waitFor(() => expect(matchingReads(server).some((query) => query.get("view") === "referral")).toBe(true));
    expect(await screen.findByText("转诊进度")).toBeInTheDocument();
    expect(document.querySelector("[data-vcr-referral-state='contactable']")).toHaveTextContent("1");
    expect(screen.getByText("末例入组")).toBeInTheDocument();
    // No points to draw: no empty chart standing in for a forecast.
    expect(screen.queryByText("入组预测与实际")).toBeNull();
  });

  it("lists the ledger's rows from the referral route, each person at their state, with who confirmed the contact", async () => {
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("radio", { name: "转诊" }));
    expect(await screen.findByRole("heading", { name: "转诊台账" })).toBeInTheDocument();
    expect(server.calls.some((call) => call.method === "GET" && call.path === `/vcr/studies/${STUDY_ID}/referrals`)).toBe(true);
    const contacted = document.querySelector("[data-vcr-referral='ref_seed_2']") as HTMLElement;
    expect(contacted).toHaveTextContent("P-0201");
    expect(contacted).toHaveTextContent("已联系");
    expect(contacted).toHaveTextContent("周协调员");
    expect(contacted).not.toHaveTextContent("coordinator-1");
    expect(contacted).toHaveTextContent("中心 01");
    expect(document.querySelector("[data-vcr-referral='ref_seed_4']")).toHaveTextContent("入组 2026-09-18");
    expect(document.querySelectorAll("[data-vcr-referral]")).toHaveLength(4);
  });

  it("reads the ledger only for a reader the route would answer, and says nothing more than the counts to the others", async () => {
    const outsider = study((raw) => { raw.abilities = ["write"]; });
    drawTab(<MatchingTab studyId={STUDY_ID} study={outsider} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("radio", { name: "转诊" }));
    expect(await screen.findByText("转诊进度")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "转诊台账" })).toBeNull();
    expect(server.calls.some((call) => call.path.endsWith("/referrals"))).toBe(false);
  });

  it("says a ledger that could not be read, inside the tab, and keeps the counts", async () => {
    server = installVcrServer(network.productRequest, {
      [`GET /vcr/studies/${STUDY_ID}/referrals`]: () => { throw new WebApiError("gone", { status: 503, code: "vcr_unavailable" }); },
    });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("radio", { name: "转诊" }));
    expect(await screen.findByText("转诊进度")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector("[data-vcr-referral-state='contactable']")).toHaveTextContent("1"));
  });

  // UI-25: the band is named, and its level is the data's, never hard-coded.
  it("names the forecast band with the level the data carries", async () => {
    const payload = fixture("ev201/matching-referral.json");
    payload.forecast.rows[0].value.interval.level = 90;
    payload.forecast.median = [{ x: 0, y: 0 }, { x: 12, y: 60 }];
    payload.forecast.band = [{ x: 0, low: 0, high: 0 }, { x: 12, low: 50, high: 70 }];
    server = installVcrServer(network.productRequest, { [`GET ${MATCHING}?view=referral&direction=trial_to_patient`]: payload });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("radio", { name: "转诊" }));
    expect(await screen.findByText("入组预测与实际")).toBeInTheDocument();
    expect(screen.getByText("预测中位与90% 预测区间")).toBeInTheDocument();
    expect(screen.queryByText(/80% 预测区间/)).toBeNull();
    expect(screen.getByText(/预测中位与预测区间是模型输出/)).toBeInTheDocument();
  });

  it("lists the sites with the one whose details were never checked flagged", async () => {
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("radio", { name: "中心" }));
    const site = await waitFor(() => {
      const found = document.querySelector("[data-vcr-site='ste_07']");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(site).toHaveTextContent("资料还没有核实过");
  });

  // UI-30: what a site still lacks, and how many contacts it has, as far as
  // the server sends them; a column nobody has anything in is not drawn.
  it("shows what a site lacks and how many contacts it has, only where there is something to say", async () => {
    const payload = fixture("ev201/matching-sites.json");
    payload.sites[0].needs = ["转诊表模板", "伦理批件"];
    payload.sites[0].contacts = 2;
    server = installVcrServer(network.productRequest, { [`GET ${MATCHING}?view=sites&direction=trial_to_patient`]: payload });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("radio", { name: "中心" }));
    const site = await waitFor(() => {
      const found = document.querySelector("[data-vcr-site='ste_01']");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(site).toHaveTextContent("转诊表模板");
    expect(site).toHaveTextContent("伦理批件");
    expect(screen.getByRole("columnheader", { name: "未满足的要求" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "联系人" })).toBeInTheDocument();
  });

  it("draws neither column when no site has anything to say in it", async () => {
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByRole("radio", { name: "中心" }));
    await waitFor(() => expect(document.querySelector("[data-vcr-site='ste_01']")).not.toBeNull());
    expect(screen.queryByRole("columnheader", { name: "未满足的要求" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "联系人" })).toBeNull();
  });
});

/* ------------------------------------------------------------------ 数据与证据 */

const dataPath = (card?: string) => `/app/virtual-research/${STUDY_ID}/data${card ? `?card=${card}` : ""}`;
const detail = () => document.querySelector("[data-vcr-assumption-detail]") as HTMLElement;

/** The server's matching page with two protocol versions to look at. */
function withProtocols(change?: (payload: any) => void) {
  const payload = fixture("ev201/matching.json");
  payload.protocols = [
    { id: "prt_1", version: 1, title: "EV-201 方案 v1", sourceRef: null },
    { id: "prt_2", version: 2, title: "EV-201 方案 v2", sourceRef: null },
  ];
  payload.protocolVersionId = "prt_1";
  change?.(payload);
  return payload;
}

describe("匹配与招募 — the controls stay while another page is read", () => {
  // Review V-M2: the load key holds the protocol and the direction, and while a new key loaded the tab drew its toolbar and a
  // skeleton alone — the select just used, the comparison panel and a half-made choice were unmounted, and a keyboard reader's
  // focus fell to <body>.
  it("keeps the select the reader changed — the same element, still focused — with the open comparison panel and its choice, while the other protocol's page loads", async () => {
    let arrive: (page: unknown) => void = () => undefined;
    server = installVcrServer(network.productRequest, {
      [`GET ${MATCHING}`]: ({ query }: { query: URLSearchParams }) => (query.get("protocolVersionId") === "prt_2"
        ? new Promise((resolve) => { arrive = resolve; })
        : withProtocols()),
    });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    await userEvent.click(screen.getByText("比较多个方案"));
    const panel = screen.getByText("比较多个方案").closest("details")!;
    expect(panel).toHaveAttribute("open");
    const group = () => screen.getByRole("group", { name: "选择方案（最多 10 项）" });
    await userEvent.click(within(group()).getByRole("checkbox", { name: "EV-201 方案 v2" }));
    const select = screen.getByLabelText("查看方案") as HTMLSelectElement;
    select.focus();
    fireEvent.change(select, { target: { value: "prt_2" } });
    await waitFor(() => expect(matchingReads(server).some((query) => query.get("protocolVersionId") === "prt_2")).toBe(true));
    // The page for prt_2 has not arrived: the tab is loading, and the controls are the ones the reader was using.
    expect(document.querySelector("[data-vcr-loading='tab']")).not.toBeNull();
    expect(screen.getByLabelText("查看方案")).toBe(select);
    expect(select).toHaveFocus();
    expect(select.value).toBe("prt_2");
    expect(panel).toHaveAttribute("open");
    expect(within(group()).getByRole("checkbox", { name: "EV-201 方案 v2" })).toBeChecked();
    expect(within(group()).getByRole("checkbox", { name: "EV-201 方案 v1" })).not.toBeChecked();
    await act(async () => { arrive(withProtocols((payload) => { payload.protocolVersionId = "prt_2"; })); });
    await waitFor(() => expect(document.querySelector("[data-vcr-loading='tab']")).toBeNull());
    expect(screen.getByLabelText("查看方案")).toBe(select);
    expect(select).toHaveFocus();
    expect(select.value).toBe("prt_2");
    expect(panel).toHaveAttribute("open");
    expect(within(group()).getByRole("checkbox", { name: "EV-201 方案 v2" })).toBeChecked();
    expect(within(group()).getByRole("checkbox", { name: "EV-201 方案 v1" })).not.toBeChecked();
  });

  it("keeps the controls when the page for the protocol chosen cannot be read, so another protocol can be chosen", async () => {
    server = installVcrServer(network.productRequest, {
      [`GET ${MATCHING}`]: ({ query }: { query: URLSearchParams }) => {
        if (query.get("protocolVersionId") === "prt_2") throw new WebApiError("no", { status: 500, code: "vcr_unavailable" });
        return withProtocols();
      },
    });
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    const select = screen.getByLabelText("查看方案") as HTMLSelectElement;
    select.focus();
    fireEvent.change(select, { target: { value: "prt_2" } });
    expect(await screen.findByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.getByLabelText("查看方案")).toBe(select);
    expect(select.value).toBe("prt_2");
    fireEvent.change(select, { target: { value: "prt_1" } });
    expect(await screen.findByRole("heading", { name: "P-0201" })).toBeInTheDocument();
  });
});

describe("数据与证据 — which card is open", () => {
  it("opens the card the address names, by key or by id", async () => {
    drawTab(<DataTab studyId={STUDY_ID} study={study()} />, dataPath("target_hr"));
    expect(await screen.findByRole("heading", { name: "目标 HR" })).toBeInTheDocument();
  });

  it("opens a card named by its id too, and a click moves the address", async () => {
    drawTab(<DataTab studyId={STUDY_ID} study={study()} />, dataPath("asm_3"));
    expect(await screen.findByRole("heading", { name: "脱落率" })).toBeInTheDocument();
    await userEvent.click(document.querySelector("[data-vcr-assumption='asm_4']") as HTMLElement);
    expect(await screen.findByRole("heading", { name: "对照组 ORR" })).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("card=orr_control");
  });

  // 关键假设 is the study's own flag, not "has a key".
  it("filters 关键假设 on the cards the designs rest on", async () => {
    drawTab(<DataTab studyId={STUDY_ID} study={study()} />, dataPath());
    await screen.findByRole("heading", { name: "对照组中位 PFS" });
    // One chip that opens a menu, not a row of five.
    await userEvent.click(screen.getByRole("button", { name: "筛选" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: /关键假设/ }));
    const listed = [...document.querySelectorAll("[data-vcr-assumption]")].map((node) => node.getAttribute("data-vcr-assumption"));
    expect(listed).toEqual(["asm_1", "asm_2"]);
  });
});

describe("数据与证据 — the card's §6.1 fields", () => {
  it("shows the five-class source type, applicability, sensitivity and what uses the card", async () => {
    drawTab(<DataTab studyId={STUDY_ID} study={study()} />, dataPath("control_median_pfs"));
    await screen.findByRole("heading", { name: "对照组中位 PFS" });
    expect(within(detail()).getByText("外部证据")).toBeInTheDocument();
    expect(within(detail()).getByText("汇总")).toBeInTheDocument();
    expect(screen.getByText("二线 NSCLC，多西他赛单药；含中国人群的研究")).toBeInTheDocument();
    expect(screen.getByText("敏感性范围 3–5.6")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "方案 B 2:1 随机" })).toHaveAttribute("href", "/app/virtual-research/std_1/trial");
    expect(screen.getByText("改动记录")).toBeInTheDocument();
    expect(screen.queryByText("版本记录")).toBeNull();
    // UI-27: no line beside a title that explains the system.
    expect(screen.queryByText("下游结果随版本重算")).toBeNull();
  });

  it("shows the countersignature's kind and time in the detail, with no 「已复核」 chip on the card, and no invented display name", async () => {
    drawTab(<DataTab studyId={STUDY_ID} study={study()} />, dataPath("orr_control"));
    await screen.findByRole("heading", { name: "对照组 ORR" });
    // The chip that used to say 「已复核（昨天）」 beside the title is gone (owner ruling 2026-10-10); who signed what, when, stays in the detail.
    expect(screen.queryByText(/已复核|复核后有变更/)).toBeNull();
    // A missing display name stays absent; immutable account ids are not names.
    expect(screen.getByText("统计复核 · 昨天")).toBeInTheDocument();
    expect(screen.queryByText(/u_stat/)).toBeNull();
    // A card already countersigned offers no second countersignature.
    expect(screen.queryByRole("button", { name: "签注复核" })).toBeNull();
  });

  it("links the quote's source only when it is an http(s) address", async () => {
    drawTab(<DataTab studyId={STUDY_ID} study={study()} />, dataPath("control_median_pfs"));
    await screen.findByRole("heading", { name: "对照组中位 PFS" });
    expect(screen.getByRole("link", { name: /打开原文/ })).toHaveAttribute("href", "https://example.org/NCT09900001");
  });

  it("does not turn an unsafe quote address into a link", async () => {
    const payload = fixture("ev201/data.json");
    payload.assumptions[0].detail.quoteLink = "javascript:alert(document.cookie)";
    server = installVcrServer(network.productRequest, { [`GET ${DATA}`]: payload });
    drawTab(<DataTab studyId={STUDY_ID} study={study()} />, dataPath("control_median_pfs"));
    await screen.findByRole("heading", { name: "对照组中位 PFS" });
    expect(screen.getByText("— NCT09900001，第 6 页，表 2")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /打开原文/ })).toBeNull();
    expect(document.querySelector("a[href^='javascript']")).toBeNull();
  });

  // UI-20: a precedent opens to the registry's own words beside the normalised value.
  it("opens a precedent row to what the registry says, planned and actual in columns of their own", async () => {
    drawTab(<DataTab studyId={STUDY_ID} study={study()} />, dataPath());
    await screen.findByRole("heading", { name: "对照组中位 PFS" });
    expect(screen.getByRole("columnheader", { name: "计划入组" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "实际入组" })).toBeInTheDocument();
    const toggle = within(document.querySelector("[data-vcr-precedent='CTR20990001']") as HTMLElement).getByRole("button");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector("[data-vcr-precedent-detail='CTR20990001']")).toHaveTextContent("多西他赛对照 III 期（中国人群）");
  });
});

describe("数据与证据 — 改这张卡", () => {
  // UI-8 / PB-18: the card's next version, with exactly the allow-listed body.
  it("writes the card's next version with the value, unit and note, then re-reads the tab", async () => {
    server = installVcrServer(network.productRequest, {
      [`POST /vcr/studies/${STUDY_ID}/assumptions`]: { id: "asm_9", key: "control_median_pfs", version: 2 },
    });
    drawTab(<DataTab studyId={STUDY_ID} study={study()} />, dataPath("control_median_pfs"));
    await screen.findByRole("heading", { name: "对照组中位 PFS" });
    await userEvent.click(screen.getByRole("button", { name: "改这张卡" }));
    const value = screen.getByLabelText("取值");
    expect(value).toHaveValue(4.1);
    expect(screen.getByLabelText("单位")).toHaveValue("个月");
    expect(screen.getByLabelText("说明")).toHaveValue("7 项随机效应汇总");
    await userEvent.clear(value);
    await userEvent.type(value, "4.3");
    const reads = server.calls.filter((call) => call.path === DATA).length;
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/assumptions`, "POST", {
      key: "control_median_pfs", name: "对照组中位 PFS", pointValue: 4.3, unit: "个月", note: "7 项随机效应汇总",
      // A person's value is an expert setting: it keeps the endpoint and applicability and no pooled evidence.
      endpoint: "PFS", applicability: { population: "二线 NSCLC，多西他赛单药", region: "含中国人群的研究", calibre: "overall" },
      sourceKind: "expert_set", valueSource: "assumed",
    }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已保存。"));
    await waitFor(() => expect(server.calls.filter((call) => call.path === DATA).length).toBe(reads + 1));
  });

  it("sends one version however often 保存 is pressed while it is in flight", async () => {
    let finish: (value: unknown) => void = () => undefined;
    server = installVcrServer(network.productRequest, {
      [`POST /vcr/studies/${STUDY_ID}/assumptions`]: () => new Promise((resolve) => { finish = resolve; }),
    });
    drawTab(<DataTab studyId={STUDY_ID} study={study()} />, dataPath("dropout_annual"));
    await screen.findByRole("heading", { name: "脱落率" });
    await userEvent.click(screen.getByRole("button", { name: "改这张卡" }));
    const form = document.querySelector("[data-vcr-assumption-edit]") as HTMLFormElement;
    await userEvent.click(within(form).getByRole("button", { name: "保存" }));
    await userEvent.click(within(form).getByRole("button", { name: /保存/ }));
    const posts = server.calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(1);
    // A card with no note sends no note.
    expect(posts[0].body).toEqual({ key: "dropout_annual", name: "脱落率", pointValue: 10, unit: "%/年", applicability: {}, sourceKind: "expert_set", valueSource: "assumed" });
    await act(async () => { finish({ version: 2 }); });
  });

  it("is not offered to a reader who may not write", async () => {
    const reader = study((raw) => { raw.abilities = ["read", "review_clinical"]; });
    drawTab(<DataTab studyId={STUDY_ID} study={reader} />, dataPath("control_median_pfs"));
    await screen.findByRole("heading", { name: "对照组中位 PFS" });
    expect(screen.queryByRole("button", { name: "改这张卡" })).toBeNull();
  });
});

describe("数据与证据 — 签注复核", () => {
  // PB-19: a countersignature on the version on screen, of a kind the reader holds.
  it("lets the lead pick the kind, and signs the version on screen", async () => {
    drawTab(<DataTab studyId={STUDY_ID} study={study()} />, dataPath("control_median_pfs"));
    await screen.findByRole("heading", { name: "对照组中位 PFS" });
    await userEvent.click(screen.getByRole("button", { name: "签注复核" }));
    await userEvent.click(screen.getByRole("radio", { name: "统计复核" }));
    await userEvent.type(screen.getByLabelText("备注"), "核对过 7 项来源");
    await userEvent.click(screen.getByRole("button", { name: "签注" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/reviews`, "POST", {
      kind: "statistical", nodes: ["assumption:control_median_pfs@1"], note: "核对过 7 项来源",
    }));
    expect(toasts.success).toHaveBeenCalledWith("已签注统计复核。");
  });

  it("signs a clinical reviewer's own kind, with no choice to make", async () => {
    const reviewer = study((raw) => { raw.abilities = ["read", "review_clinical", "export"]; });
    drawTab(<DataTab studyId={STUDY_ID} study={reviewer} />, dataPath("target_hr"));
    await screen.findByRole("heading", { name: "目标 HR" });
    await userEvent.click(screen.getByRole("button", { name: "签注复核" }));
    expect(screen.queryByRole("radiogroup", { name: "复核类型" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "签注" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/reviews`, "POST", {
      kind: "clinical", nodes: ["assumption:target_hr@1"],
    }));
  });

  it("is not offered to a reader with no review role", async () => {
    const viewer = study((raw) => { raw.abilities = ["read"]; });
    drawTab(<DataTab studyId={STUDY_ID} study={viewer} />, dataPath("control_median_pfs"));
    await screen.findByRole("heading", { name: "对照组中位 PFS" });
    expect(screen.queryByRole("button", { name: "签注复核" })).toBeNull();
  });
});
