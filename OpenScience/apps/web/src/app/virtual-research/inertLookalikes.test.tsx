import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetStudies } from "@/components/vcr/useStudy";
import { fixture, installVcrServer, STUDY_ID } from "@/components/vcr/__fixtures__/serverFixtures";
import { drawStudy, inertLookalikes } from "./studyPageHarness";

/**
 * What looks pressed and is not a control (R19, plan §2 rule 5; audit B §2.5, D C4): a card with a border that did nothing, a pill
 * that read as a filter and was a label, a row with a selected ground that was not a choice. The owner's 「还都点击不了」. This
 * counts **structure**: anything with a selected or pressed look (`aria-current`, `aria-selected`, `aria-pressed`, the selected
 * ground) that is not a control, not in one and does not hold one, fails.
 *
 * Held here: the frame, the overview, the list and the conversation view. A tab's body is held by its own package's tests.
 */
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);
const me = vi.hoisted(() => ({ fetchWebMe: vi.fn() }));
vi.mock("@/lib/apiClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/apiClient")>()), fetchWebMe: me.fetchWebMe }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/projects", () => {
  const state = () => ({ currentId: "prj_ev201", projects: [{ id: "prj_ev201" }], select: vi.fn(async () => undefined), load: vi.fn(async () => undefined) });
  return { useProjectStore: Object.assign(<T,>(selector: (value: ReturnType<typeof state>) => T) => selector(state()), { getState: state }) };
});
vi.mock("@/lib/taskPane", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/taskPane")>()), registerTaskPane: () => () => undefined }));

beforeEach(() => {
  forgetStudies();
  me.fetchWebMe.mockReset();
  me.fetchWebMe.mockResolvedValue({ features: { vcr: true } });
  installVcrServer(network.productRequest);
});

const describeEach = (element: Element) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 60)} “${(element.textContent ?? "").slice(0, 30)}”`;

describe("nothing that looks pressed is inert", () => {
  it.each([
    ["总览", `/app/virtual-research/${STUDY_ID}`, /已模拟 3 个方案/],
    ["conversation", `/app/virtual-research/${STUDY_ID}/chat`, null],
  ])("the study's %s", async (_name, path, ready) => {
    drawStudy(path);
    await screen.findByRole("heading", { level: 1 });
    if (ready) await screen.findByText(ready);
    else await screen.findByRole("region", { name: "研究对话" });
    expect(inertLookalikes(document.body).map(describeEach)).toEqual([]);
  });

  it("the list of studies", async () => {
    drawStudy("/app/virtual-research");
    await screen.findByRole("list", { name: "研究" });
    expect(inertLookalikes(document.body).map(describeEach)).toEqual([]);
  });

  it("the rule sees one: a card with a selected ground that does nothing", () => {
    const card = document.createElement("div");
    card.className = "rounded-card border bg-accent-soft";
    card.textContent = "对照路线 · 外部对照";
    document.body.append(card);
    expect(inertLookalikes(document.body)).toEqual([card]);
    card.remove();
  });

  it("a row that holds its own control is a row, and the strip is not a selection", async () => {
    installVcrServer(network.productRequest, {
      [`GET /vcr/studies/${STUDY_ID}`]: (() => {
        const raw = fixture("ev201/study.json");
        raw.activity = { run: { id: "r", step: "trial", steps: ["trial"], label: "模拟试验方案", phase: null, counts: {}, startedAt: null, placement: "open-runtime", locked: false }, queue: [], jobs: [], last: null };
        return raw;
      })(),
    });
    drawStudy(`/app/virtual-research/${STUDY_ID}`);
    await screen.findByText(/正在模拟试验方案/);
    expect(document.querySelector(".bg-accent-soft")).not.toBeNull();
    expect(inertLookalikes(document.body)).toEqual([]);
  });
});
