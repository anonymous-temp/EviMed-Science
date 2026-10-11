import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { readVcrStudy, readVcrTrial, type VcrStudy } from "@/lib/vcrClient";
import { TrialTab } from "./TrialTab";
import { fixture, installVcrServer, STUDY_ID } from "../__fixtures__/serverFixtures";

/**
 * 监管沟通, on the trial tab: the log of regulatory contacts as a small list with its own 添加. A record of the study that the
 * conversation (or the researcher) writes; the page shows what was written and takes a new entry. Rendered from the server's own trial
 * page with the log filled in.
 */

const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

vi.mock("@/lib/projects", () => ({
  useProjectStore: { getState: () => ({ projects: [{ id: "prj_ev201" }], select: vi.fn(), load: vi.fn() }) },
}));

const draw = (node: React.ReactElement) => render(<MemoryRouter>{node}</MemoryRouter>);
const study = (change?: (raw: any) => void): VcrStudy => {
  const raw = fixture("ev201/study.json");
  raw.abilities = [...new Set([...raw.abilities, "write"])];
  change?.(raw);
  return readVcrStudy(raw);
};
const trialRoute = `GET /vcr/studies/${STUDY_ID}/trial`;

const CONTACTS = [
  { id: "reg_2", date: "2026-08-14", agency: "药审中心（CDE）", type: "Pre-IND 沟通交流", summary: "讨论单臂加外部对照的可行性", outcome: "同意以外部对照作支持性证据",
    attachments: ["minutes.pdf", "briefing/package.zip"], source: "researcher", recordedAt: "2026-08-15 09:00" },
  { id: "reg_1", date: "2026-06-01", agency: "FDA", type: "", summary: "", outcome: "", attachments: [], source: "ai_set", recordedAt: "2026-06-02 10:00" },
];

beforeEach(() => {
  toasts.success.mockReset();
  toasts.error.mockReset();
  installVcrServer(network.productRequest);
});

describe("the reader", () => {
  it("reads the trial page's log, and an older page that has none as an empty log", () => {
    const raw = fixture("ev201/trial.json");
    expect(readVcrTrial({ ...raw, regulatory: undefined }).regulatory).toEqual([]);
    const filled = readVcrTrial({ ...raw, regulatory: CONTACTS });
    expect(filled.regulatory.map((contact) => [contact.id, contact.source, contact.attachments.length])).toEqual([["reg_2", "researcher", 2], ["reg_1", "ai_set", 0]]);
  });
});

describe("the regulatory log", () => {
  it("lists the contacts as recorded, the latest first, with the agency's own conclusion and the references it left", async () => {
    installVcrServer(network.productRequest, { [trialRoute]: { ...fixture<Record<string, unknown>>("ev201/trial.json"), regulatory: CONTACTS } });
    const { container } = draw(<TrialTab studyId={STUDY_ID} study={study()} />);
    await screen.findByRole("heading", { name: "监管沟通" });
    const items = [...container.querySelectorAll("[data-vcr-regulatory-contact]")];
    expect(items.map((item) => item.getAttribute("data-vcr-regulatory-contact"))).toEqual(["reg_2", "reg_1"]);
    const first = items[0].textContent ?? "";
    for (const piece of ["2026-08-14", "药审中心（CDE）", "Pre-IND 沟通交流", "讨论单臂加外部对照的可行性", "结论：同意以外部对照作支持性证据", "附件：minutes.pdf；briefing/package.zip"]) expect(first).toContain(piece);
    // Who recorded a contact is the ledger's record (R36): a contact a run wrote reads like any other, with no chip saying an AI set it.
    for (const item of items) expect(item.textContent).not.toContain("AI 设定");
    expect(items[1].textContent).toContain("FDA");
    // the log has its own 添加; the action row no longer offers the first-entry button
    expect(screen.getByRole("button", { name: "添加" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "记录监管沟通" })).toBeNull();
  });

  it("is added to from the action row while the log is empty, and the entry is posted as the form says it", async () => {
    draw(<TrialTab studyId={STUDY_ID} study={study()} />);
    await userEvent.click(await screen.findByRole("button", { name: "记录监管沟通" }));
    const drawer = await screen.findByRole("dialog", { name: "添加监管沟通记录" });
    const add = within(drawer).getByRole("button", { name: "添加" });
    expect(add).toBeDisabled();
    await userEvent.type(within(drawer).getByLabelText("日期"), "2026-08-14");
    expect(add).toBeDisabled();
    await userEvent.type(within(drawer).getByLabelText("机构"), " 药审中心（CDE） ");
    expect(add).toBeEnabled();
    await userEvent.type(within(drawer).getByLabelText("沟通类型"), "Pre-IND 沟通交流");
    await userEvent.type(within(drawer).getByLabelText("讨论摘要"), "讨论外部对照");
    await userEvent.type(within(drawer).getByLabelText("附件"), "minutes.pdf{enter}  {enter}briefing/package.zip");
    await userEvent.click(add);
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/regulatory-contacts`, "POST", {
      date: "2026-08-14", agency: "药审中心（CDE）", type: "Pre-IND 沟通交流", summary: "讨论外部对照", attachments: ["minutes.pdf", "briefing/package.zip"],
    }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已添加监管沟通记录。"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "添加监管沟通记录" })).toBeNull());
    expect(network.productRequest.mock.calls.filter(([path, method]) => path === `/vcr/studies/${STUDY_ID}/trial` && (method ?? "GET") === "GET").length).toBeGreaterThanOrEqual(2);
  });

  it("sends one request however many times the button is pressed", async () => {
    let release: (value: unknown) => void = () => {};
    installVcrServer(network.productRequest, {
      [`POST /vcr/studies/${STUDY_ID}/regulatory-contacts`]: () => new Promise((resolve) => { release = resolve; }),
    });
    draw(<TrialTab studyId={STUDY_ID} study={study()} />);
    await userEvent.click(await screen.findByRole("button", { name: "记录监管沟通" }));
    const drawer = await screen.findByRole("dialog", { name: "添加监管沟通记录" });
    await userEvent.type(within(drawer).getByLabelText("日期"), "2026-08-14");
    await userEvent.type(within(drawer).getByLabelText("机构"), "FDA");
    const add = within(drawer).getByRole("button", { name: "添加" });
    await userEvent.click(add);
    await userEvent.click(add);
    expect(network.productRequest.mock.calls.filter(([path, method]) => String(path).endsWith("/regulatory-contacts") && method === "POST")).toHaveLength(1);
    release({ id: "reg_9" });
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已添加监管沟通记录。"));
    expect(network.productRequest.mock.calls.filter(([path, method]) => String(path).endsWith("/regulatory-contacts") && method === "POST")).toHaveLength(1);
  });

  it("says why when the server refuses the entry, and keeps the form for the correction", async () => {
    installVcrServer(network.productRequest, {
      [`POST /vcr/studies/${STUDY_ID}/regulatory-contacts`]: () => { throw new WebApiError("2026-02-30 不是一个真实存在的日期。", { status: 400, code: "vcr_regulatory_contact_invalid" }); },
    });
    draw(<TrialTab studyId={STUDY_ID} study={study()} />);
    await userEvent.click(await screen.findByRole("button", { name: "记录监管沟通" }));
    const drawer = await screen.findByRole("dialog", { name: "添加监管沟通记录" });
    await userEvent.type(within(drawer).getByLabelText("日期"), "2026-02-28");
    await userEvent.type(within(drawer).getByLabelText("机构"), "FDA");
    await userEvent.click(within(drawer).getByRole("button", { name: "添加" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(screen.getByRole("dialog", { name: "添加监管沟通记录" })).toBeInTheDocument();
    expect(within(screen.getByRole("dialog", { name: "添加监管沟通记录" })).getByLabelText("机构")).toHaveValue("FDA");
  });

  it("is offered to a reader who may write and to nobody else", async () => {
    const readOnly = study((raw) => { raw.abilities = raw.abilities.filter((ability: string) => ability !== "write"); });
    installVcrServer(network.productRequest, { [trialRoute]: { ...fixture<Record<string, unknown>>("ev201/trial.json"), regulatory: CONTACTS } });
    draw(<TrialTab studyId={STUDY_ID} study={readOnly} />);
    await screen.findByRole("heading", { name: "监管沟通" });
    expect(screen.queryByRole("button", { name: "添加" })).toBeNull();
    expect(screen.queryByRole("button", { name: "记录监管沟通" })).toBeNull();
  });
});
