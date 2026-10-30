import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readVcrStudy, type VcrStudy } from "@/lib/vcrClient";
import { fixture, installVcrServer, STUDY_ID } from "../__fixtures__/serverFixtures";
import { fakeRoom, renderTab } from "../__fixtures__/tabFrame";
import { MatchingTab } from "./MatchingTab";

// Only the network is doubled; the payloads are the server's own fixtures, or a copy with the one field changed.
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/projects", () => ({
  useProjectStore: { getState: () => ({ projects: [{ id: "prj_ev201" }], select: vi.fn(), load: vi.fn() }) },
}));

const MATCHING = `/vcr/studies/${STUDY_ID}/matching`;
const study = (): VcrStudy => readVcrStudy(fixture("ev201/study.json"));
const draw = () => renderTab(<MatchingTab studyId={STUDY_ID} study={study()} />, { route: `/app/virtual-research/${STUDY_ID}/matching` });

let restoreRoom: () => void;
let server: ReturnType<typeof installVcrServer>;
beforeEach(() => { restoreRoom = fakeRoom(); server = installVcrServer(network.productRequest); });
afterEach(() => restoreRoom());

describe("患者匹配 — a person judged not eligible is reachable", () => {
  it("lists them with the rule they fail, and opens the rule-by-rule judgement from their row", async () => {
    draw();
    await screen.findByRole("heading", { name: "P-0201" });
    const row = (document.querySelector("[data-vcr-candidate='P-0240']") as HTMLElement).closest("li") as HTMLElement;
    expect(within(row).getByText("不符合")).toBeInTheDocument();
    expect(within(row).getByText("I2 不满足")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^P-0240/ }));
    await waitFor(() => expect(server.calls.some((call) => call.path.startsWith(MATCHING) && new URL(call.path, "http://x").searchParams.get("candidate") === "P-0240")).toBe(true));
    expect(await screen.findByRole("heading", { name: "P-0240" })).toBeInTheDocument();
    // which rule failed, in the same table every person's rules are read in, and the sentence that says it
    expect(document.querySelector("[data-vcr-criterion='I2']")).toHaveAttribute("data-vcr-criterion-state", "not_satisfied");
    expect(document.querySelector("[data-vcr-criterion='I2']")).toHaveTextContent("不满足");
    expect(document.querySelector("[data-vcr-criterion='I1']")).toHaveAttribute("data-vcr-criterion-state", "satisfied");
    expect(screen.getByText("不符合：I2 不满足")).toBeInTheDocument();
  });

  it("opens a person from 待复核排除 instead of leaving their name as a label", async () => {
    const payload = fixture("ev201/matching.json");
    payload.pendingReview = { count: 1, subjects: ["P-0240"] };
    server = installVcrServer(network.productRequest, { [`GET ${MATCHING}`]: ({ query }: { query: URLSearchParams }) => (query.get("candidate") === "P-0240" ? fixture("ev201/matching-p0240.json") : payload) });
    draw();
    await screen.findByRole("heading", { name: "P-0201" });
    const zone = document.querySelector("[data-vcr-pending-review]") as HTMLElement;
    await userEvent.click(within(zone).getByRole("button", { name: "P-0240" }));
    expect(await screen.findByRole("heading", { name: "P-0240" })).toBeInTheDocument();
    expect(screen.getByText("不符合：I2 不满足")).toBeInTheDocument();
  });

  it("does not say the evaluation was not generated when every assessed person is on the list's far side of the funnel", async () => {
    // What the page used to be given when everybody assessed was not eligible: the tally had them, the list did not.
    const payload = fixture("ev201/matching.json");
    Object.assign(payload, {
      candidates: [], selected: null, gaps: [], timeline: [], comparisons: [], pendingReview: null,
      funnel: [{ key: "candidates", label: "已评估", count: 2, note: null, tone: "neutral" }, { key: "insufficient", label: "可能符合 · 待补证", count: 0, note: null, tone: "attention" },
        { key: "eligible", label: "符合", count: 0, note: null, tone: "accent" }, { key: "ineligible", label: "不符合", count: 2, note: null, tone: "neutral" }],
    });
    server = installVcrServer(network.productRequest, { [`GET ${MATCHING}`]: payload });
    draw();
    expect(await screen.findByText("已评估")).toBeInTheDocument();
    expect(screen.queryByText("尚未生成匹配评估")).toBeNull();
  });
});
