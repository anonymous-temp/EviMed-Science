import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { readVcrStudy, type VcrStudy } from "@/lib/vcrClient";
import { StudyFrame, activityStripOf, type StudyView } from "./StudyFrame";
import { useStudyFrame, useVcrToolbar } from "./studyFrameContext";
import { fixture, installVcrServer, STUDY_ID } from "./__fixtures__/serverFixtures";

const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

/** The finished EV-201 study with nothing going on — the fixture has a job under way, which a test that is not about it must not meet. */
const study = (patch: (raw: any) => void = () => undefined): VcrStudy => {
  const raw = fixture("ev201/study.json");
  raw.activity = null;
  raw.jobs = raw.jobs.filter((job: { state: string }) => job.state === "succeeded");
  patch(raw);
  return readVcrStudy(raw);
};

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

/** A tab that hands the band a toolbar of its own, keeping the state its handlers change. */
function ToolbarTab({ withToolbar = true }: { withToolbar?: boolean }) {
  const [state, setState] = useState<string | null>(null);
  useVcrToolbar(withToolbar ? {
    filters: [{ kind: "select", label: "分组", allLabel: "全部分组", options: [{ value: "arm1", label: "试验组" }], value: state, onChange: setState }],
    summary: "2,000 名",
  } : null);
  return <p data-testid="chosen">{state ?? "全部"}</p>;
}

function draw(options: { study?: VcrStudy; view?: StudyView; children?: React.ReactNode; onChat?: () => void; reload?: () => void } = {}) {
  const value = options.study ?? study();
  return render(
    <MemoryRouter initialEntries={["/app/virtual-research/std_1"]}>
      <StudyFrame
        studyId={STUDY_ID}
        study={value}
        view={options.view ?? "overview"}
        reload={options.reload ?? (() => undefined)}
        menu={[{ label: "变更记录", onSelect: () => undefined }]}
        onChat={options.onChat ?? (() => undefined)}
        onPanel={() => undefined}
        onView={() => undefined}
      >
        {options.children ?? <p>正文</p>}
      </StudyFrame>
      <Where />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  installVcrServer(network.productRequest);
  toasts.success.mockReset();
  toasts.error.mockReset();
});

describe("the one band over every view of a study", () => {
  it("holds the tab row — the step bar — and the toolbar's row in one sticky band, above the body", () => {
    draw();
    const band = document.querySelector("[data-page-chrome]") as HTMLElement;
    expect(band).toHaveClass("sticky", "top-0");
    expect(within(band).getByRole("tablist")).toBeInTheDocument();
    // The tab row IS the step bar: there is no second rail of the same seven things.
    expect(document.querySelector("[data-step-rail]")).toBeNull();
    const body = document.querySelector("[data-page-body]") as HTMLElement;
    expect(band.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("reserves the toolbar's row on a tab that has none, so the band is the same height on every tab", () => {
    draw();
    const band = document.querySelector("[data-page-chrome]") as HTMLElement;
    const row = band.lastElementChild as HTMLElement;
    expect(row).toHaveClass("min-h-11");
    expect(row).toHaveAttribute("aria-hidden", "true");
    expect(document.querySelectorAll("[data-toolbar]")).toHaveLength(0);
  });

  it("draws the tab's own toolbar in the band — not in the body — and takes it away with the tab", async () => {
    const { rerender } = draw({ children: <ToolbarTab /> });
    const band = document.querySelector("[data-page-chrome]") as HTMLElement;
    const toolbar = await waitFor(() => {
      const found = band.querySelector("[data-toolbar]");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(toolbar).toHaveTextContent("2,000 名");
    expect(document.querySelector("[data-page-body]")!.querySelector("[data-toolbar]")).toBeNull();
    // Its handlers are this render's: choosing in it changes the tab.
    await userEvent.click(within(toolbar).getByRole("button", { name: "分组" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "试验组" }));
    expect(screen.getByTestId("chosen")).toHaveTextContent("arm1");
    // A tab that has none hands the band nothing, and its row stays reserved.
    rerender(
      <MemoryRouter initialEntries={["/app/virtual-research/std_1"]}>
        <StudyFrame studyId={STUDY_ID} study={study()} view="population" reload={() => undefined} menu={[]} onChat={() => undefined} onPanel={() => undefined} onView={() => undefined}>
          <ToolbarTab withToolbar={false} />
        </StudyFrame>
      </MemoryRouter>,
    );
    await waitFor(() => expect(document.querySelector("[data-toolbar]")).toBeNull());
    expect((document.querySelector("[data-page-chrome]") as HTMLElement).lastElementChild).toHaveClass("min-h-11");
  });

  it("draws no toolbar row in the conversation view, which has no tab-level controls, and leaves no tab selected", () => {
    draw({ view: "chat" });
    expect(document.querySelector("[data-toolbar]")).toBeNull();
    const band = document.querySelector("[data-page-chrome]") as HTMLElement;
    expect(band.querySelector(".min-h-11")).toBeNull();
    expect(screen.queryByRole("tab", { selected: true })).toBeNull();
    // The first tab is still in the tab order, so the row can be reached from the keyboard.
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute("tabindex", "0");
    expect(document.querySelector("[role=tabpanel]")).toBeNull();
  });
});

describe("the tab row", () => {
  it("says each stage's state as a dot, in words for a screen reader and as a tooltip, and what the stage found", () => {
    draw();
    const patients = screen.getByRole("tab", { name: /^虚拟患者/ });
    expect(patients.querySelector("[data-tab-dot]")).toHaveAttribute("data-tab-dot", "attention");
    expect(patients).toHaveTextContent("2,000 名");
    expect(patients).toHaveTextContent("需要留意");
    // The legend of the dot is in the document for the keyboard and the pointer: the tooltip says why it needs a look.
    const tip = document.getElementById(patients.getAttribute("aria-describedby") ?? "");
    expect(tip).toHaveTextContent("需要留意：上次没有做完");
    // 定义与证据 says what its evidence found; the overview has no stage and no dot.
    expect(screen.getByRole("tab", { name: /^定义与证据/ })).toHaveTextContent("4 张假设卡");
    expect(screen.getByRole("tab", { name: /^总览/ }).querySelector("[data-tab-dot]")).toBeNull();
  });

  it("names a stage under way by the run that covers it", () => {
    draw({
      study: study((raw) => {
        raw.steps.population = { ...raw.steps.population, status: "running" };
        raw.activity = { run: { id: "run_1", step: "population", steps: ["population"], label: "构建人群", phase: null, counts: {}, startedAt: null, placement: "open-runtime", locked: false }, queue: [], jobs: [], last: null };
      }),
    });
    const tab = screen.getByRole("tab", { name: /^人群/ });
    expect(document.getElementById(tab.getAttribute("aria-describedby") ?? "")).toHaveTextContent("进行中：构建人群");
  });
});

describe("the header's primary action is the study's next step, on every tab", () => {
  it("is the server's next, in the header, whichever tab is open", async () => {
    const view = draw({ view: "comparator" });
    const header = document.querySelector("[data-page-header]") as HTMLElement;
    expect(within(header).getByRole("button", { name: "接着做：生成虚拟患者" })).toBeInTheDocument();
    view.unmount();
    const fresh = study((raw) => { raw.next = { step: "comparator", label: "设计对照", reason: "start", reasonText: "" }; });
    draw({ study: fresh, view: "trial" });
    expect(within(document.querySelector("[data-page-header]") as HTMLElement).getByRole("button", { name: "下一步：设计对照" })).toBeInTheDocument();
  });

  it("starts that step with one request, and the page stays where it is", async () => {
    const reload = vi.fn();
    draw({ view: "trial", reload });
    await userEvent.click(screen.getByRole("button", { name: "接着做：生成虚拟患者" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/run`, "POST", { step: "patients" }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(screen.getByTestId("where")).toHaveTextContent("/app/virtual-research/std_1");
  });

  it("is not drawn while work goes on — the strip says what is happening — and not for a reader who may not run a step", () => {
    const moving = draw();
    expect(screen.getByRole("button", { name: /生成虚拟患者/ })).toBeInTheDocument();
    moving.unmount();
    const running = study((raw) => { raw.activity = { run: { id: "run_1", step: "patients", steps: ["patients"], label: "生成虚拟患者", phase: null, counts: {}, startedAt: null, placement: "open-runtime", locked: false }, queue: [], jobs: [], last: null }; });
    const view = draw({ study: running });
    expect(screen.queryByRole("button", { name: /^(下一步|接着做|重新做)/ })).toBeNull();
    view.unmount();
    const reader = study((raw) => { raw.abilities = ["read"]; });
    draw({ study: reader });
    expect(screen.queryByRole("button", { name: /^(下一步|接着做|重新做)/ })).toBeNull();
  });

  it("says nothing it need not: an unfinished step is 接着做 with its reason in a tooltip, a stale one 重新做", () => {
    draw({ study: study((raw) => { raw.next = { step: "trial", label: "模拟试验方案", reason: "refresh", reasonText: "输入已变更，结果已过期" }; }) });
    const button = screen.getByRole("button", { name: "重新做：模拟试验方案" });
    expect(document.getElementById(button.getAttribute("aria-describedby") ?? "")).toHaveTextContent("输入已变更，结果已过期");
  });

  it("says a held project in the sentence of what holds it, and keeps the page", async () => {
    installVcrServer(network.productRequest, {
      [`POST /vcr/studies/${STUDY_ID}/run`]: () => { throw new WebApiError("held", { status: 423, code: "runtime_reserved_for_autopilot", details: { reason: "module-step" } }); },
    });
    draw();
    await userEvent.click(screen.getByRole("button", { name: "接着做：生成虚拟患者" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1));
    expect(String(toasts.error.mock.calls[0][0])).toContain("正在做研究里的一个步骤");
    expect(String(toasts.error.mock.calls[0][0])).not.toContain("定时任务");
  });
});

describe("对话 is a view of the page", () => {
  it("is a button in the header that opens the study's conversation view in the same page, and is pressed there", async () => {
    const onChat = vi.fn();
    const closed = draw({ onChat });
    await userEvent.click(screen.getByRole("button", { name: "对话" }));
    expect(onChat).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "对话" })).toHaveAttribute("aria-pressed", "false");
    closed.unmount();
    draw({ view: "chat", onChat });
    expect(screen.getByRole("button", { name: "对话" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "对话" }));
    expect(onChat).toHaveBeenCalledTimes(1);
  });

  it("hands a tab the way in, with a draft that waits in the composer", async () => {
    const onChat = vi.fn();
    function Asker() {
      const frame = useStudyFrame();
      return <button type="button" onClick={() => frame?.openChat("再加一个方案")}>去说</button>;
    }
    draw({ onChat, children: <Asker /> });
    await userEvent.click(screen.getByRole("button", { name: "去说" }));
    expect(onChat).toHaveBeenCalledWith("再加一个方案");
  });
});

describe("what the strip says", () => {
  const base = (patch: (raw: any) => void) => study((raw) => { raw.jobs = []; raw.activity = null; patch(raw); });

  it("is null when nothing goes on, and when only a job waits for its budget", () => {
    expect(activityStripOf(base(() => undefined), {})).toBeNull();
    const waiting = base((raw) => { raw.activity = { run: null, queue: [], jobs: [{ id: "j", kind: "design_grid", state: "awaiting_budget", step: "trial", done: null, total: null }], last: null }; });
    expect(activityStripOf(waiting, {})).toBeNull();
  });

  it("is the run's own sentence with what it has counted, how many wait behind it, and what to press", () => {
    const onCancel = vi.fn();
    const strip = activityStripOf(base((raw) => {
      raw.activity = { run: { id: "r", step: "population", steps: ["population"], label: "构建人群", phase: "search", counts: { search: 6, claims: 10, claimsVerified: 4 }, startedAt: "2026-10-14T01:00:00.000Z", placement: "bounded", locked: true },
        queue: [{ step: "patients", waitingFor: "population" }, { step: "comparator", waitingFor: "population" }], jobs: [], last: null };
    }), { onCancel });
    expect(strip).toMatchObject({ label: "构建人群", phase: "检索 · 检索 6 次 · 结论 4/10 已核对", queued: 2, startedAt: "2026-10-14T01:00:00.000Z" });
    strip?.onCancel?.();
    expect(onCancel).toHaveBeenCalled();
  });

  it("is a step in line with what it waits for, and no cancel: nothing holds the slot", () => {
    const strip = activityStripOf(base((raw) => { raw.activity = { run: null, queue: [{ step: "patients", waitingFor: "allowance" }], jobs: [], last: null }; }), { onCancel: () => undefined });
    expect(strip).toMatchObject({ label: "生成虚拟患者", waiting: "等研究额度" });
    expect(strip?.onCancel).toBeUndefined();
  });

  it("never carries a percentage", () => {
    const strip = activityStripOf(base((raw) => {
      raw.activity = { run: null, queue: [], jobs: [{ id: "j", kind: "design_simulation", state: "running", step: "trial", done: 3, total: 10 }], last: null };
    }), {});
    expect(strip).toMatchObject({ label: "模拟试验方案", phase: "计算", counts: { done: 3, total: 10 } });
    expect(JSON.stringify(strip)).not.toMatch(/%/);
  });
});

describe("the server's eight states of activity, drawn", () => {
  const state = (name: string) => fixture(`activity/${name}.json`);
  const stripOf = (name: string) => activityStripOf(study((raw) => { raw.activity = state(name); }), { onCancel: () => undefined });

  it("a run with a step behind it: its sentence, what it has counted, and how many wait", () => {
    expect(stripOf("running-with-queue")).toMatchObject({
      label: "找证据、整理假设卡", phase: "核对 · 检索 4 次 · 纳入 3 篇 · 全文 2 篇 · 结论 3/5 已核对 · 交付物 0/1", queued: 1,
    });
  });

  it("a run that is only being sent: drawn at once, with no clock of its own before it has started and nothing said of where it went", () => {
    expect(stripOf("being-sent")).toMatchObject({ label: "找证据、整理假设卡", startedAt: "2026-10-14T09:59:00.000Z" });
    const { container } = draw({ study: study((raw) => { raw.activity = state("being-sent"); }), view: "chat" });
    // The conversation is not said to be held for it: `locked` is false and nothing in the frame disables it.
    expect(container.querySelector("[data-activity='strip']")).not.toBeNull();
    expect(screen.getByRole("button", { name: "对话" })).not.toBeDisabled();
  });

  it("a run that holds the project's runtime is drawn like any other: the pane, not the strip, says the conversation is held", () => {
    expect(stripOf("bounded-locked")).toMatchObject({ label: "整理研究定义", phase: "检索 · 检索 1 次" });
  });

  it("engine jobs: the one that runs, its done of total, and how many wait behind it", () => {
    expect(stripOf("jobs-only")).toMatchObject({ label: "生成虚拟患者", phase: "计算", counts: { done: 1200, total: 2000 }, queued: 1 });
  });

  it("the tail of a run that ended — succeeded, canceled or failed — draws no strip: the page has updated itself, and the dot says the rest", () => {
    for (const name of ["tail-succeeded", "tail-canceled", "tail-failed", "idle"]) expect(stripOf(name), name).toBeNull();
  });
});

describe("what a study's frame offers a tab alone", () => {
  it("is nothing, and a tab that asks for it must keep working: the hooks do no harm outside a frame", async () => {
    function Lone() {
      const frame = useStudyFrame();
      useVcrToolbar({ summary: "x" });
      return <p data-testid="lone">{frame === null ? "没有页面" : "有页面"}</p>;
    }
    render(<MemoryRouter><Lone /></MemoryRouter>);
    expect(screen.getByTestId("lone")).toHaveTextContent("没有页面");
    await act(async () => undefined);
  });
});
