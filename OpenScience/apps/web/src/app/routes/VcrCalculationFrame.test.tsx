import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forgetStudies } from "@/components/vcr/useStudy";
import { fixture, installVcrServer, STUDY_ID } from "@/components/vcr/__fixtures__/serverFixtures";
import { VcrCalculationWorkbenchPage } from "./VcrCalculationWorkbenchPage";
import { VcrStudyPage } from "@/app/virtual-research/VcrStudyPage";

/**
 * An independent calculation keeps its container (`/app/capabilities/calculations/:id`): its history is the landing page, and each of its
 * views has that one address. The audit found the header links on another address (`/app/virtual-research/:id/data`), a 总览 that sent the
 * reader back to the history, and an empty state whose link was worded as a conversation and led to the module's list.
 */
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);
const me = vi.hoisted(() => ({ fetchWebMe: vi.fn() }));
vi.mock("@/lib/apiClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/apiClient")>()), fetchWebMe: me.fetchWebMe }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/projects", () => {
  const state = () => ({ currentId: "prj_ev201", projects: [{ id: "prj_ev201" }], select: vi.fn(async (_id: string, land?: () => void) => { land?.(); }), load: vi.fn(async () => undefined) });
  return { useProjectStore: Object.assign(<T,>(selector: (value: ReturnType<typeof state>) => T) => selector(state()), { getState: state }) };
});
vi.mock("@/lib/taskPane", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/taskPane")>()), registerTaskPane: () => () => undefined }));

function Where() { const location = useLocation(); return <p data-testid="where">{`${location.pathname}${location.search}`}</p>; }
function draw(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Where />
      <Routes>
        <Route path="/app/capabilities/calculations/:studyId/:tab?" element={<VcrCalculationWorkbenchPage />} />
        <Route path="/app/virtual-research/:studyId/:tab?" element={<VcrStudyPage />} />
        <Route path="*" element={<p>elsewhere</p>} />
      </Routes>
    </MemoryRouter>,
  );
}
const calculation = () => { const study = fixture("ev201/study.json"); study.purpose = "calculation"; return study; };
beforeEach(() => {
  forgetStudies();
  me.fetchWebMe.mockResolvedValue({ features: { vcr: true } });
  installVcrServer(network.productRequest, {
    [`GET /vcr/studies/${STUDY_ID}`]: calculation(),
    [`GET /vcr/studies/${STUDY_ID}/jobs`]: { jobs: [] },
  });
});
afterEach(cleanup);

it("links the calculation's own views on the calculation's own addresses, and its empty history to the form that starts research", async () => {
  draw(`/app/capabilities/calculations/${STUDY_ID}`);
  expect(await screen.findByRole("link", { name: "资料与证据" })).toHaveAttribute("href", `/app/capabilities/calculations/${STUDY_ID}/data`);
  expect(screen.getByRole("link", { name: "入排匹配" })).toHaveAttribute("href", `/app/capabilities/calculations/${STUDY_ID}/matching`);
  // It is worded for where it goes: the module's form, where a task is begun by a draft. It was 「开始研究对话」, and went to the list.
  const start = await screen.findByRole("link", { name: "新建研究" });
  expect(start).toHaveAttribute("href", "/app/virtual-research?new=1");
  expect(screen.queryByRole("link", { name: "开始研究对话" })).toBeNull();
});

it("moves a calculation opened on the study's address to its own, keeping the query", async () => {
  draw(`/app/virtual-research/${STUDY_ID}/data?intake=1`);
  await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(`/app/capabilities/calculations/${STUDY_ID}/data?intake=1`));
});

it("offers no 总览 in a calculation's view switch: its landing page is the history", async () => {
  draw(`/app/capabilities/calculations/${STUDY_ID}/data`);
  const select = await screen.findByRole("button", { name: /查看/ });
  await userEvent.click(select);
  const options = (await screen.findAllByRole("menuitemradio").catch(() => [])).map((option) => option.textContent);
  expect(options.length).toBeGreaterThan(0);
  expect(options).not.toContain("总览");
});
