import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetStudies } from "@/components/vcr/useStudy";
import { generatedPopulation } from "@/components/vcr/__fixtures__/generatedPopulation";
import { fakeRoom } from "@/components/vcr/__fixtures__/tabFrame";
import { fixture, installVcrServer, STUDY_ID } from "@/components/vcr/__fixtures__/serverFixtures";
import { drawStudy, inertLookalikes, standingBlocks } from "./studyPageHarness";

/**
 * The bodies of the six tabs, held to the two structure rules the frame is held to (R19 VCRT, plan §2 rules 4 and 5; audit B §2.4,
 * §2.5; the brief's T4): `standingText.test` and `inertLookalikes.test` state them for the frame, the overview, the list and the
 * conversation, and leave "a tab's body" to the package that moved it onto the framework. This is that package's.
 *
 *  - **Standing text.** Outside what holds a record (a dialog, a table, a quotation, a row, a note with its action, an empty state) a
 *    tab has at most one block of text that long, and it is its headline. Every other sentence is a `Note`, a row, a state or a mark's
 *    tooltip: the 29 sentences of §2.4 were not on any list of banned phrases, and a list of phrases never catches the next one.
 *  - **Look-alikes.** Nothing with a selected or pressed look is neither a control nor in one: the route list of 对照 and the card list
 *    of 定义与证据 are real selections (a row that is a button), and a pill that was only a label is a `Tag`.
 *
 * Every tab is read from the server's own fixtures (the finished EV-201 study) and, where a state changes what is drawn, from a
 * variant of them: a generated population, a result that stopped part-way, a study with nothing yet.
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

/** A finished study with nothing running, so the strip and the budget note (the frame's, held by its own tests) are not on the page. */
const quiet = () => {
  const raw = fixture("ev201/study.json");
  raw.jobs = raw.jobs.filter((job: { state: string }) => job.state === "succeeded");
  raw.activity = null;
  raw.budget = { ...raw.budget, awaitingBudget: 0 };
  return raw;
};

let restoreRoom: () => void = () => undefined;
beforeEach(() => {
  // A desktop page: a master/detail view has the room for its list beside its record (jsdom has no layout).
  restoreRoom = fakeRoom(1400);
  forgetStudies();
  me.fetchWebMe.mockReset();
  me.fetchWebMe.mockResolvedValue({ features: { vcr: true } });
  installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}`]: quiet() });
});
afterEach(() => restoreRoom());

const SLOW = { timeout: 4000 };

/** What a tab has drawn when it is done: the thing that comes last (a table's rows, a record's list) and not the first heading. */
const READY: Record<string, () => Promise<unknown>> = {
  "/data": () => screen.findByRole("heading", { name: "试验先例" }, SLOW),
  "/population": () => screen.findByRole("heading", { name: "逐条筛选" }, SLOW),
  "/patients": async () => {
    await screen.findByRole("table", { name: "患者" }, SLOW);
    await waitFor(() => expect(document.querySelector("[data-vcr-open-patient]")).not.toBeNull(), SLOW);
  },
  "/comparator": () => waitFor(() => expect(document.querySelector("[data-vcr-diagnostics]")).not.toBeNull(), SLOW),
  "/trial": () => screen.findByRole("table", { name: "方案的对比" }, SLOW),
  "/matching": () => screen.findByRole("heading", { name: "P-0201" }, SLOW),
};

const describeBlock = (block: { element: Element; text: string }) => `${block.element.tagName.toLowerCase()}[${String(block.element.className).slice(0, 40)}] “${block.text.slice(0, 40)}”`;
const describeElement = (element: Element) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 60)} “${(element.textContent ?? "").slice(0, 30)}”`;

/** What stands on its own: the page's blocks of text, less what a record says in its own words (a key / value list is the record). */
const standingOnTheirOwn = () => standingBlocks(document.body).filter((block) => !block.element.closest("[data-fact-list]"));

/** The two rules, on what is drawn now. */
function holdsBothRules(where: string) {
  const standing = standingOnTheirOwn();
  expect(standing.length, `${where}: more than one standing block\n${standing.map(describeBlock).join("\n")}`).toBeLessThanOrEqual(1);
  // The one block there may be is the tab's headline, drawn by `Headline` and not written by hand.
  for (const block of standing) expect(block.element, `${where}: ${describeBlock(block)}`).toHaveAttribute("data-headline");
  expect(inertLookalikes(document.body).map(describeElement).join("\n"), `${where}: what looks pressed and is not a control`).toBe("");
}

describe("each tab, with data", () => {
  it.each(Object.keys(READY))("%s stands at most its headline, and nothing that looks pressed is inert", async (suffix) => {
    drawStudy(`/app/virtual-research/${STUDY_ID}${suffix}`);
    await screen.findByRole("heading", { level: 1, name: /EV-201/ }, SLOW);
    await READY[suffix]();
    holdsBothRules(suffix);
  });

  it("对照, once another route is opened: the route's record is a list of facts and a card, not a sentence", async () => {
    drawStudy(`/app/virtual-research/${STUDY_ID}/comparator`);
    await READY["/comparator"]();
    const route = document.querySelector("[data-vcr-route='external_control']") as HTMLElement;
    route.click();
    await waitFor(() => expect(document.querySelector("[data-vcr-route-record='external_control']")).not.toBeNull(), SLOW);
    holdsBothRules("/comparator (外部对照)");
  });

  it("试验, with the design behind a row open: the record is in the drawer and the page under it is unchanged", async () => {
    drawStudy(`/app/virtual-research/${STUDY_ID}/trial`);
    await READY["/trial"]();
    (document.querySelector("tr[data-vcr-design='B']") as HTMLElement).click();
    await screen.findByRole("dialog", undefined, SLOW);
    holdsBothRules("/trial (方案记录)");
  });
});

describe("a tab in a state that changes what it draws", () => {
  it("人群 of a generated population: the variable table carries the limits, and no sentence says how it was made", async () => {
    installVcrServer(network.productRequest, {
      [`GET /vcr/studies/${STUDY_ID}`]: quiet(),
      [`GET /vcr/studies/${STUDY_ID}/population`]: generatedPopulation(),
    });
    drawStudy(`/app/virtual-research/${STUDY_ID}/population`);
    await screen.findByRole("heading", { level: 1, name: /EV-201/ }, SLOW);
    await screen.findByRole("table", { name: "每个变量设定的分布和生成的结果" }, SLOW);
    holdsBothRules("/population (generated)");
  });

  it("虚拟患者 of a result that stopped part-way: one line, and that line is a note", async () => {
    // The finished study's fixture carries the engine's partial result (1,200 of 2,000 replicates).
    drawStudy(`/app/virtual-research/${STUDY_ID}/patients`);
    await READY["/patients"]();
    expect(document.querySelector("[data-vcr-partial]")).toHaveAttribute("data-note");
    holdsBothRules("/patients (partial)");
  });
});

describe("the module's lists of its own", () => {
  it.each([
    ["方法库", "models"],
    ["试验先例", "precedents"],
    ["人群定义", "definitions"],
  ])("%s stands nothing outside its rows and its record", async (_name, tab) => {
    drawStudy(`/app/virtual-research?tab=${tab}`);
    await waitFor(() => expect(document.querySelector("[data-vcr-loading]")).toBeNull(), SLOW);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const standing = standingOnTheirOwn();
    expect(standing.map(describeBlock).join("\n"), `?tab=${tab}: standing text`).toBe("");
    expect(inertLookalikes(document.body).map(describeElement).join("\n"), `?tab=${tab}: what looks pressed and is not a control`).toBe("");
  });
});
