import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readVcrSchedule, readVcrTrial, readVcrStudy, type VcrStudy } from "@/lib/vcrClient";
import { TrialTab } from "./TrialTab";
import { fixture, installVcrServer, STUDY_ID } from "../__fixtures__/serverFixtures";
import { renderTab } from "../__fixtures__/tabFrame";

/**
 * 访视日程, on the trial tab: the protocol's schedule of activities as a table — the visits by day, the window around each and what is
 * done at it. A record of the protocol that the conversation writes; the page shows what was written. It is one of the three kinds of
 * record of the step, and the band's switch (方案 · 访视 · 监管) is how a reader gets to it. Rendered from the server's own trial page
 * with the schedule filled in.
 */

const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);

vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/projects", () => ({
  useProjectStore: { getState: () => ({ projects: [{ id: "prj_ev201" }], select: vi.fn(), load: vi.fn() }) },
}));

const draw = (node: React.ReactElement) => renderTab(node);
const band = (container: HTMLElement) => container.querySelector("[data-page-chrome]") as HTMLElement;
const study = (change?: (raw: any) => void): VcrStudy => {
  const raw = fixture("ev201/study.json");
  raw.abilities = [...new Set([...raw.abilities, "write"])];
  change?.(raw);
  return readVcrStudy(raw);
};
const trialRoute = `GET /vcr/studies/${STUDY_ID}/trial`;

const SCHEDULE = {
  protocolVersion: 2,
  visits: [
    { visit: "筛选期", day: -14, windowDays: 7, note: "", procedures: [{ name: "知情同意", note: "" }, { name: "血常规", note: "" }] },
    { visit: "基线", day: 1, windowDays: 0, note: "首次给药当天", procedures: [{ name: "体格检查", note: "" }, { name: "血常规", note: "" }] },
    { visit: "第 4 周", day: 29, windowDays: 3, note: "", procedures: [{ name: "血常规", note: "" }, { name: "肿瘤评估", note: "RECIST 1.1" }] },
    { visit: "治疗结束", day: null, windowDays: null, note: "", procedures: [{ name: "体格检查", note: "" }] },
  ],
  totals: { visits: 4, activities: 4, entries: 7, firstDay: -14, lastDay: 29 },
};

beforeEach(() => {
  installVcrServer(network.productRequest);
});

describe("the readers", () => {
  it("read a schedule as visits and none at all when it has no visit", () => {
    expect(readVcrSchedule(null)).toBeNull();
    expect(readVcrSchedule({ visits: [] })).toBeNull();
    expect(readVcrSchedule({ visits: [{ visit: "", procedures: [] }] })).toBeNull();
    const read = readVcrSchedule(SCHEDULE);
    expect(read?.protocolVersion).toBe(2);
    expect(read?.visits.map((visit) => [visit.visit, visit.day, visit.windowDays])).toEqual([["筛选期", -14, 7], ["基线", 1, 0], ["第 4 周", 29, 3], ["治疗结束", null, null]]);
    expect(read?.totals).toEqual(SCHEDULE.totals);
  });

  it("read the trial page's schedule, and an older page that has none as no schedule", () => {
    const raw = fixture("ev201/trial.json");
    expect(readVcrTrial({ ...raw, schedule: undefined }).schedule).toBeNull();
    expect(readVcrTrial({ ...raw, schedule: SCHEDULE }).schedule?.visits).toHaveLength(4);
  });
});

describe("the schedule", () => {
  it("is a table of visits with the day, the window and what is done, the version it belongs to and what it adds up to — behind the band's 访视", async () => {
    installVcrServer(network.productRequest, { [trialRoute]: { ...fixture<Record<string, unknown>>("ev201/trial.json"), schedule: SCHEDULE } });
    const { container } = draw(<TrialTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("table", { name: "方案的对比" });
    await userEvent.click(within(band(container)).getByRole("button", { name: "访视" }));
    const table = await screen.findByRole("table", { name: "访视日程" });
    const rows = within(table).getAllByRole("row").slice(1).map((row) => [...row.querySelectorAll("th, td")].map((cell) => cell.textContent));
    expect(rows).toEqual([
      ["筛选期", "第 -14 天", "±7 天", "知情同意、血常规"],
      ["基线首次给药当天", "第 1 天", "±0 天", "体格检查、血常规"],
      ["第 4 周", "第 29 天", "±3 天", "血常规、肿瘤评估（RECIST 1.1）"],
      ["治疗结束", "—", "—", "体格检查"],
    ]);
    expect(screen.getByText("方案 v2")).toBeInTheDocument();
    expect(container.querySelector("[data-vcr-schedule]")?.textContent).toContain("共 4 次访视，涉及 4 项评估与操作");
    // One kind of record at a time: the designs give way to the schedule.
    expect(screen.queryByRole("table", { name: "方案的对比" })).toBeNull();
  });

  it("is not drawn while the study has none: no card that is a title over nothing, and no 访视 in the switch", async () => {
    const { container } = draw(<TrialTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("table", { name: "方案的对比" });
    expect(screen.queryByRole("heading", { name: "访视日程" })).toBeNull();
    expect(within(band(container)).queryByRole("button", { name: "访视" })).toBeNull();
  });

  it("makes a study with a schedule and no designs a page and not a step waiting to be done", async () => {
    installVcrServer(network.productRequest, { [trialRoute]: { ...fixture<Record<string, unknown>>("empty/trial.json"), schedule: SCHEDULE } });
    draw(<TrialTab studyId={STUDY_ID} study={study()} />);
    expect(await screen.findByRole("table", { name: "访视日程" })).toBeInTheDocument();
  });
});
