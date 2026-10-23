import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { answerFilled, geoProject } from "./__fixtures__/geoTabs";
import type { GeoDiagnosisReview } from "@/lib/geoClient";
import { DiagnosisReview } from "./DiagnosisReview";
const client = vi.hoisted(() => ({ getGeoDiagnosisReview: vi.fn(), submitGeoDiagnosisFeedback: vi.fn() }));
const conversation = vi.hoisted(() => ({ open: vi.fn(async (_target: unknown, _draft?: string) => true) }));
vi.mock("@/lib/geoClient", async original => ({ ...await original<typeof import("@/lib/geoClient")>(), ...client }));
vi.mock("./useOpenGeoConversation", () => ({ useOpenGeoConversation: () => conversation.open }));
const statement = { ...answerFilled.facts!.statements[0], text: "An exact answer sentence.", claimId: "claim1", verdict: "wrong" as const, applicability: { population: "Adults", elements: { form: "tablet" }, inLabel: true, evidenceLevel: null, validUntil: null } };
const saved = (): GeoDiagnosisReview => ({ assessmentVersion: "a".repeat(64), state: "active", current: { statements: [statement] }, original: { statements: [statement] }, history: [{ version: "a".repeat(64), state: "active", assessment: { statements: [statement] } }], feedback: [] });
beforeEach(() => {
  client.getGeoDiagnosisReview.mockReset().mockResolvedValue(saved());
  client.submitGeoDiagnosisFeedback.mockReset().mockResolvedValue({ id: "feedback1", jobId: "job1" });
  conversation.open.mockClear();
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
it("continues the native project conversation with exact statement and assessment context for both work actions", async () => {
  renderReview();
  await userEvent.click(await screen.findByRole("button", { name: "更新项目结论或文章" }));
  await waitFor(() => expect(conversation.open).toHaveBeenCalledTimes(1));
  expect(conversation.open.mock.calls[0][0]).toMatchObject({ projectId: geoProject().projectId, sessionId: geoProject().sessionId });
  expect(conversation.open.mock.calls[0][1]).toContain(statement.text);
  expect(conversation.open.mock.calls[0][1]).toContain("a".repeat(64));
  await userEvent.click(screen.getByRole("button", { name: "创建出处或问题群处置任务" }));
  expect(conversation.open.mock.calls[1][1]).toContain("只有后续实测才能确认错误是否消失");
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
