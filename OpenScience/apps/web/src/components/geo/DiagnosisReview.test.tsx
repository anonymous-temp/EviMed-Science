import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { answerFilled, geoProject } from "./__fixtures__/geoTabs";
import type { GeoDiagnosisReview } from "@/lib/geoClient";
import { DiagnosisReview } from "./DiagnosisReview";
const client = vi.hoisted(() => ({ getGeoDiagnosisReview: vi.fn(), submitGeoDiagnosisFeedback: vi.fn(), getGeoProject: vi.fn(), stageGeoPlanContext: vi.fn() }));
const conversation = vi.hoisted(() => ({ open: vi.fn(async (_target: unknown, _draft?: string) => true), ensure: vi.fn(async (_geoId: string, _projectId: string, sessionId?: string | null) => sessionId ?? "ses_primary") }));
vi.mock("@/lib/geoClient", async original => ({ ...await original<typeof import("@/lib/geoClient")>(), ...client }));
vi.mock("./useOpenGeoConversation", () => ({ useOpenGeoConversation: () => conversation.open }));
vi.mock("./geoConversationSession", () => ({ ensureGeoConversationSession: conversation.ensure }));
const staged = { referenceId: `gpc_${"c".repeat(64)}`, sessionId: "ses_geo_1", draft: "server draft" };
const statement = { ...answerFilled.facts!.statements[0], text: "An exact answer sentence.", claimId: "claim1", verdict: "wrong" as const, applicability: { population: "Adults", elements: { form: "tablet" }, inLabel: true, evidenceLevel: null, validUntil: null } };
const saved = (): GeoDiagnosisReview => ({ assessmentVersion: "a".repeat(64), state: "active", current: { statements: [statement] }, original: { statements: [statement] }, history: [{ version: "a".repeat(64), state: "active", assessment: { statements: [statement] } }], feedback: [] });
beforeEach(() => {
  client.getGeoDiagnosisReview.mockReset().mockResolvedValue(saved());
  client.submitGeoDiagnosisFeedback.mockReset().mockResolvedValue({ id: "feedback1", jobId: "job1" });
  client.getGeoProject.mockReset().mockResolvedValue(geoProject());
  client.stageGeoPlanContext.mockReset().mockResolvedValue(staged);
  conversation.open.mockClear(); conversation.ensure.mockClear();
});
const renderReview = (viewer = false) => render(<MemoryRouter><DiagnosisReview geoId="geo_1" data={answerFilled} project={{ ...geoProject(), ...(viewer ? { access: { roles: ["viewer"], abilities: ["read"], owner: false } } : {}) }} actions={[]} /></MemoryRouter>);
it("submits an exact assessment-bound feedback and retains its original judgment after reloading", async () => {
  renderReview();
  await userEvent.click(await screen.findByRole("button", { name: "反馈并复核判定" }));
  await userEvent.type(screen.getByRole("textbox", { name: "反馈理由与适用条件" }), "The answer concerns another population.");
  client.getGeoDiagnosisReview.mockResolvedValue({ ...saved(), feedback: [{ id: "feedback1", statement: statement.text, note: "The answer concerns another population.", original: statement, status: "queued", result: null, error: null, createdAt: "2026-10-24T00:00:00Z", assessmentVersion: "a".repeat(64) }] });
  await userEvent.click(screen.getByRole("button", { name: "提交复核" }));
  await waitFor(() => expect(client.submitGeoDiagnosisFeedback).toHaveBeenCalledTimes(1));
  expect(client.submitGeoDiagnosisFeedback.mock.calls[0][1]).toMatchObject({ snapshotId: answerFilled.snapshot.id, claimId: "claim1", statement: statement.text, assessmentVersion: "a".repeat(64) });
  expect(await screen.findByText(/等待复核 · 提交时原判定：讲错/)).toBeVisible();
  expect(screen.getByText(/原判定：讲错 · 当前判定：讲错/)).toBeVisible();
});
it("stages the exact review context and opens the conversation with only the person's sentence in the composer, for both work actions", async () => {
  const errors = [{ ...answerFilled.errors[0], id: "err_review_1", statement: statement.text, claimId: statement.claimId, claimVersion: statement.claimVersion, applicability: statement.applicability }];
  render(<MemoryRouter><DiagnosisReview geoId="geo_1" data={{ ...answerFilled, errors }} project={geoProject()} actions={[]} /></MemoryRouter>);
  await userEvent.click(await screen.findByRole("button", { name: "更新项目结论或文章" }));
  await waitFor(() => expect(conversation.open).toHaveBeenCalledTimes(1));
  expect(client.stageGeoPlanContext.mock.calls[0][0]).toBe("geo_1");
  expect(client.stageGeoPlanContext.mock.calls[0][1]).toMatchObject({ mode: "strategy", sessionId: geoProject().sessionId, errorIds: ["err_review_1"] });
  expect(conversation.open.mock.calls[0][0]).toMatchObject({ projectId: geoProject().projectId, geoId: "geo_1", sessionId: "ses_geo_1", geoPlanContext: { referenceId: staged.referenceId } });
  const draft = conversation.open.mock.calls[0][1] ?? "";
  expect(draft).toContain(statement.text);
  // The identities ride in the staged context; the person never sends them as their own words.
  for (const machinery of ["a".repeat(64), "当前复核上下文", "err_review_1", "claimVersion", "{"]) expect(draft).not.toContain(machinery);
  await userEvent.click(screen.getByRole("button", { name: "创建出处或问题群处置任务" }));
  await waitFor(() => expect(conversation.open).toHaveBeenCalledTimes(2));
  expect(conversation.open.mock.calls[1][1]).toContain("只有后续实测才能确认错误是否消失");
});

it("says so where the review is when the context cannot be staged, and opens nothing", async () => {
  client.stageGeoPlanContext.mockRejectedValueOnce(new Error("network"));
  renderReview();
  await userEvent.click(await screen.findByRole("button", { name: "更新项目结论或文章" }));
  expect(await screen.findByText("对话暂时无法打开，请稍后重试。")).toBeVisible();
  expect(conversation.open).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "更新项目结论或文章" })).toBeEnabled();
});

it("offers the two work actions only to a role that may open the conversation", async () => {
  render(<MemoryRouter><DiagnosisReview geoId="geo_1" data={answerFilled} project={{ ...geoProject(), access: { roles: ["medical_reviewer"], abilities: ["read", "review"], owner: false } }} actions={[]} /></MemoryRouter>);
  expect(await screen.findByText(/原判定：讲错/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "更新项目结论或文章" })).toBeNull();
  expect(screen.queryByRole("button", { name: "创建出处或问题群处置任务" })).toBeNull();
});
it("viewers retain original evidence and history without mutation controls", async () => {
  renderReview(true);
  expect(await screen.findByText(/原判定：讲错/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "反馈并复核判定" })).toBeNull();
  expect(screen.queryByRole("button", { name: "更新项目结论或文章" })).toBeNull();
  expect(screen.getByText(/Adults；form：tablet/)).toBeVisible();
});

it("loads earlier feedback and distinct judgments without changing the active assessment head", async () => {
  const first = { ...saved(), historyPage: { total: 2, shown: 1, more: true, nextBefore: 8 }, feedbackPage: { total: 1, shown: 0, more: true, nextBefore: "feedback_cursor" } };
  client.getGeoDiagnosisReview.mockResolvedValueOnce(first);
  renderReview();
  client.getGeoDiagnosisReview.mockResolvedValueOnce({ ...saved(), feedbackPage: { total: 1, shown: 1, more: false, nextBefore: null }, feedback: [
    { id: "older_feedback", statement: statement.text, note: "An earlier preserved feedback.", original: statement, assessmentVersion: "a".repeat(64), status: "succeeded", result: null, error: null, createdAt: "2026-10-23T00:00:00Z" },
  ] });
  await userEvent.click(await screen.findByRole("button", { name: /读取更早反馈/ }));
  expect(await screen.findByText(/An earlier preserved feedback/)).toBeVisible();
  expect(client.getGeoDiagnosisReview.mock.calls[1][2]).toEqual({ feedbackBefore: "feedback_cursor" });
  client.getGeoDiagnosisReview.mockResolvedValueOnce({ ...saved(), historyPage: { total: 2, shown: 1, more: false, nextBefore: null }, history: [{ version: "b".repeat(64), state: "active", assessment: { statements: [{ ...statement, verdict: "unverifiable" }] } }] });
  await userEvent.click(screen.getByRole("button", { name: /读取更早判定/ }));
  expect(await screen.findByText("历史判定：尚无法判定")).toBeVisible();
  expect(client.getGeoDiagnosisReview.mock.calls[2][2]).toEqual({ historyBefore: 8 });
  expect(screen.queryByRole("button", { name: /读取更早/ })).toBeNull();
});

it("refreshes answer annotations when a completed recheck changes the active assessment version", async () => {
  const changed = vi.fn();
  render(<MemoryRouter><DiagnosisReview geoId="geo_1" data={answerFilled} project={geoProject()} actions={[]} onAssessmentChanged={changed} /></MemoryRouter>);
  await userEvent.click(await screen.findByRole("button", { name: "反馈并复核判定" }));
  expect(changed).not.toHaveBeenCalled();
  await userEvent.type(screen.getByRole("textbox", { name: "反馈理由与适用条件" }), "Review the conditions.");
  client.getGeoDiagnosisReview.mockResolvedValue({ ...saved(), assessmentVersion: "b".repeat(64), current: { statements: [{ ...statement, verdict: "correct" }] } });
  await userEvent.click(screen.getByRole("button", { name: "提交复核" }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(await screen.findByText(/原判定：讲错 · 当前判定：讲对/)).toBeVisible();
});

it("refreshes an older loaded pending feedback after it fails without changing the assessment head", async () => {
  const callbacks: Array<() => void> = [];
  const nativeInterval = window.setInterval.bind(window);
  const interval = vi.spyOn(window, "setInterval").mockImplementation((callback, timeout) => { if (timeout !== 5000) return nativeInterval(callback, timeout) as unknown as ReturnType<typeof window.setInterval>; callbacks.push(callback as () => void); return 42 as unknown as ReturnType<typeof window.setInterval>; });
  const cleared = vi.spyOn(window, "clearInterval");
  let failed = false;
  client.getGeoDiagnosisReview.mockImplementation(async (_id, _snapshot, page) => page?.feedbackBefore ? {
    ...saved(), feedbackPage: { total: 101, shown: 1, more: false, nextBefore: null }, feedback: [
      { id: "old_pending", statement: statement.text, note: "Older pending feedback.", original: statement, assessmentVersion: "a".repeat(64), status: failed ? "failed" : "queued", result: null, error: null, createdAt: "2026-10-23T00:00:00Z" },
    ],
  } : { ...saved(), feedbackPage: { total: 101, shown: 100, more: true, nextBefore: "first100" } });
  try {
    renderReview();
    await userEvent.click(await screen.findByRole("button", { name: /读取更早反馈/ }));
    expect(await screen.findByText(/等待复核 · 提交时原判定/)).toBeVisible();
    failed = true;
    await act(async () => { callbacks.at(-1)!(); });
    expect(await screen.findByText(/复核暂未完成 · 提交时原判定/)).toBeVisible();
    await waitFor(() => expect(cleared).toHaveBeenCalledWith(42));
  } finally { interval.mockRestore(); cleared.mockRestore(); }
});

it('keeps same-text same-id variants separate and submits the selected full statement identity', async () => {
  const { geoStatementAssessmentIdentity } = await import('@evimed/domain');
  const first = { ...statement, claimVersion: 1 };
  const second = { ...statement, claimVersion: 2, applicability: { ...statement.applicability, population: 'Children', elements: { form: 'solution' } } };
  client.getGeoDiagnosisReview.mockResolvedValue({ ...saved(), original: { statements: [first, second] }, current: { statements: [{ ...first, verdict: 'correct' }, second] }, history: [] });
  const errors = [first, second].map((item, index) => ({ ...answerFilled.errors[0], id: `variant_error_${index}`, claimId: item.claimId, claimVersion: item.claimVersion, applicability: item.applicability }));
  render(<MemoryRouter><DiagnosisReview geoId="geo_1" data={{ ...answerFilled, errors }} project={geoProject()} actions={[]} /></MemoryRouter>);
  expect(await screen.findAllByText('“An exact answer sentence.”')).toHaveLength(2);
  expect(screen.getByText(/原判定：讲错 · 当前判定：讲对/)).toBeVisible();
  expect(screen.getByText(/原判定：讲错 · 当前判定：讲错/)).toBeVisible();
  await userEvent.click(screen.getAllByRole('button', { name: '更新项目结论或文章' })[1]);
  await waitFor(() => expect(conversation.open).toHaveBeenCalledTimes(1));
  expect(client.stageGeoPlanContext.mock.calls[0][1].errorIds).toEqual(['variant_error_1']);
  const buttons = screen.getAllByRole('button', { name: '反馈并复核判定' });
  await userEvent.click(buttons[1]);
  await userEvent.type(screen.getByRole('textbox', { name: '反馈理由与适用条件' }), 'Review the child solution only.');
  await userEvent.click(screen.getByRole('button', { name: '提交复核' }));
  await waitFor(() => expect(client.submitGeoDiagnosisFeedback).toHaveBeenCalledTimes(1));
  expect(client.submitGeoDiagnosisFeedback.mock.calls[0][1].statementIdentity).toBe(geoStatementAssessmentIdentity(second));
});

it('opens the exact linked assessment through existing history pages and shows preserved expressions', async () => {
  const target='b'.repeat(64);
  client.getGeoDiagnosisReview.mockImplementation(async (_id, _snapshot, page) => page?.historyBefore ? { ...saved(), historyPage:{total:2,shown:1,more:false,nextBefore:null}, history:[{version:target,state:'active',assessment:{statements:[],judgeExtract:{recommendationExpressions:{items:[{quote:'If adult, Alpha is recommended.',conditionQuote:'If adult',state:'conditional',entity:'Alpha'}]}}}}] } : {...saved(),historyPage:{total:2,shown:1,more:true,nextBefore:8}});
  render(<MemoryRouter initialEntries={[`/?assessmentVersion=${target}#geo-judgment-history`]}><DiagnosisReview geoId="geo_1" data={answerFilled} project={geoProject()} actions={[]} /></MemoryRouter>);
  expect(await screen.findByRole('region',{name:'所选历史判定'})).toHaveTextContent('If adult, Alpha is recommended.');
  expect(screen.getByRole('region',{name:'所选历史判定'})).toHaveTextContent('If adult');
  expect(client.getGeoDiagnosisReview.mock.calls[1][2]).toEqual({historyBefore:8});
});

it("names each statement correction section uniquely without changing heading rank", async () => {
  const second = { ...statement, text: "A second answer sentence.", claimId: "claim2" };
  const review = saved();
  client.getGeoDiagnosisReview.mockResolvedValue({ ...review, current: { statements: [statement, second] }, original: { statements: [statement, second] } });
  renderReview();
  const first = await screen.findByRole("region", { name: "第 1 条说法的纠错稿" });
  const next = screen.getByRole("region", { name: "第 2 条说法的纠错稿" });
  expect(first.querySelector("h3")).toHaveTextContent("第 1 条说法的纠错稿");
  expect(next.querySelector("h3")).toHaveTextContent("第 2 条说法的纠错稿");
});
