import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { VcrLegacyDraftRecovery } from "./VcrLegacyDraftRecovery";
const account = vi.hoisted(() => ({ fetchWebMe: vi.fn(async () => ({ user: { id: "alice" }, tenant: { id: "tenant" } })) }));
vi.mock("@/lib/apiClient", async load => ({ ...await load<object>(), ...account }));
const store = vi.hoisted(() => ({ select: vi.fn(async (_id: string, land?: () => void) => land?.()) }));
vi.mock("@/lib/projects", () => ({ useProjectStore: (select: (state: typeof store) => unknown) => select(store) }));
afterEach(() => localStorage.clear());
function Probe() { const location = useLocation(); return <pre data-testid="intent">{JSON.stringify(location.state)}</pre>; }
it("restores exact text as a guarded unsent intent while retaining its local copy", async () => {
  const key = "evimed.study-brief.v1:tenant:alice:new";
  const value = JSON.stringify({ fields: { question: "  Exact question\n" }, attachments: [{ name: "source.csv", state: "failed" }] });
  localStorage.setItem(key, value);
  localStorage.setItem("evimed.study-brief.v1:tenant:other:new", JSON.stringify({ fields: { question: "Another account" } }));
  render(<MemoryRouter initialEntries={["/"]}><Routes><Route path="/" element={<VcrLegacyDraftRecovery />} /><Route path="*" element={<Probe />} /></Routes></MemoryRouter>);
  await userEvent.click(await screen.findByText("旧版未发送草稿 · 1"));
  expect(screen.queryByText("Another account")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "恢复到对话输入框" }));
  const state = JSON.parse(screen.getByTestId("intent").textContent!);
  expect(state.runtimeUiIntent.draft).toBe("  Exact question\n\n\n材料文件：source.csv（上传未完成）");
  expect(state.runtimeUiIntent.restoreDraft).toBe(true);
  expect(localStorage.getItem(key)).toBe(value);
});
