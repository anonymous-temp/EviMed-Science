import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stepAllowanceWait } from "@/lib/allowanceWait";
import { readVcrStudy } from "@/lib/vcrClient";
import { VcrStepPending } from "@/components/vcr/VcrStates";
import { StepPending } from "@/components/geo/tabs/geoTabKit";
import { geoProject } from "@/components/geo/__fixtures__/geoTabs";
import { EMPTY_STUDY_ID, fixture } from "@/components/vcr/__fixtures__/serverFixtures";
import { AllowanceTopUp } from "./AllowanceTopUp";

const billing = vi.hoisted(() => ({ allowance: null as null | { commerce: { rechargeUrl: string | null } } }));
vi.mock("@/lib/useResearchBilling", async (original) => ({
  ...(await original<typeof import("@/lib/useResearchBilling")>()),
  useResearchBilling: () => ({ enabled: true, simulated: true, allowance: billing.allowance, loading: false, error: null, reload: vi.fn() }),
}));
vi.mock("@/lib/productClient", () => ({ productRequest: vi.fn() }));
vi.mock("@/components/geo/useOpenGeoConversation", () => ({ useOpenGeoConversation: () => vi.fn() }));
vi.mock("@/components/vcr/useVcrRun", () => ({ useVcrRun: () => ({ run: vi.fn(), busy: false }) }));

const draw = (node: React.ReactElement) => render(<MemoryRouter>{node}</MemoryRouter>);

beforeEach(() => { billing.allowance = null; });

describe("a step waiting on the allowance", () => {
  it("is one only while it is queued, and only for the two reasons the record can carry", () => {
    expect(stepAllowanceWait({ status: "queued", waiting: "allowance" })).toBe("allowance");
    expect(stepAllowanceWait({ status: "queued", waiting: "simulated_allowance" })).toBe("simulated_allowance");
    for (const status of ["running", "done", "failed", "none"]) expect(stepAllowanceWait({ status, waiting: "allowance" })).toBeNull();
    expect(stepAllowanceWait({ status: "queued", waiting: "something_else" })).toBeNull();
    expect(stepAllowanceWait({ status: "queued", waiting: null })).toBeNull();
    expect(stepAllowanceWait({ status: "queued" })).toBeNull();
    expect(stepAllowanceWait(undefined)).toBeNull();
  });

  it("offers the simulated top-up for a simulated refusal, and the allowance in 设置 for a real one, before anything is read", () => {
    const { unmount } = draw(<AllowanceTopUp waiting="simulated_allowance" />);
    expect(screen.getByRole("link", { name: "去模拟充值" })).toHaveAttribute("href", "/app/account/simulated/recharge");
    unmount();
    draw(<AllowanceTopUp waiting="allowance" />);
    expect(screen.getByRole("link", { name: "去充值" })).toHaveAttribute("href", "/app/account?tab=usage");
  });

  it("goes where the deployment says recharging is, once it has said", () => {
    billing.allowance = { commerce: { rechargeUrl: "https://pay.example.org/recharge" } };
    draw(<AllowanceTopUp waiting="allowance" />);
    expect(screen.getByRole("link", { name: "去充值" })).toHaveAttribute("href", "https://pay.example.org/recharge");
  });

  it("is what a 虚拟临床研究 step's tab says instead of 「正在进行」", () => {
    const study = readVcrStudy(fixture("empty/study.json"));
    study.steps.evidence = { status: "queued", waiting: "simulated_allowance", note: "等模拟额度" };
    draw(<VcrStepPending studyId={EMPTY_STUDY_ID} study={study} step="evidence" />);
    expect(screen.getByText("「证据」这一步在等模拟额度，模拟充值后会自动开始。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "去模拟充值" })).toBeInTheDocument();
    expect(screen.queryByText("正在进行，做完会显示在这里。")).not.toBeInTheDocument();
  });

  it("and a queued 虚拟临床研究 step with no wait is still work under way", () => {
    const study = readVcrStudy(fixture("empty/study.json"));
    study.steps.evidence = { status: "queued" };
    draw(<VcrStepPending studyId={EMPTY_STUDY_ID} study={study} step="evidence" />);
    expect(screen.getByText("正在进行，做完会显示在这里。")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /充值/ })).not.toBeInTheDocument();
  });

  it("is what a 循证 GEO step's tab says instead of 「正在进行」", () => {
    const project = geoProject({ evidence: "queued" });
    project.steps.evidence = { status: "queued", requested: true, waiting: "allowance", note: "等科研额度" };
    draw(<StepPending geoId="geo_1" project={project} step="evidence" />);
    expect(screen.getByText("「证据」这一步在等科研额度，充值后会自动开始。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "去充值" })).toBeInTheDocument();
    expect(screen.queryByText("正在进行，做完会显示在这里。")).not.toBeInTheDocument();
  });
});
