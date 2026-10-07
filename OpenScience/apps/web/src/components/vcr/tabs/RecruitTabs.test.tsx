import { act, render, screen, waitFor, within } from "@testing-library/react";
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

  // The other direction has no data path on the platform: a switch whose other side is always empty is not drawn.
  it("has only the one direction — no switch to 给患者找试验 — and asks for it by name", async () => {
    drawTab(<MatchingTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "P-0201" });
    expect(screen.queryByRole("radio", { name: "给患者找试验" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "给试验找患者" })).toBeNull();
    expect(matchingReads(server).every((query) => query.get("direction") === "trial_to_patient")).toBe(true);
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

  it("shows the reviewed version and time without inventing an unavailable display name", async () => {
    drawTab(<DataTab studyId={STUDY_ID} study={study()} />, dataPath("orr_control"));
    await screen.findByRole("heading", { name: "对照组 ORR" });
    // A missing display name stays absent; immutable account ids are not names.
    expect(within(detail()).getByText("已复核（昨天）")).toBeInTheDocument();
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
