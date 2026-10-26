import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readVcrStudy, type VcrStudy } from "@/lib/vcrClient";
import { StudyFrame, activityStripOf, type StudyView } from "./StudyFrame";
import { useStudyFrame, useVcrPrimary, useVcrToolbar } from "./studyFrameContext";
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
    expect(within(band).getByRole("navigation", { name: "研究进度" })).toBeInTheDocument();
    // The tab row IS the step bar: there is no second rail of the same seven things.
    expect(document.querySelectorAll("[data-step-rail]")).toHaveLength(1);
    const body = document.querySelector("[data-page-body]") as HTMLElement;
    expect(band.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("reserves the toolbar's row on a tab that has none, so the band is the same height on every tab", () => {
    draw();
    const band = document.querySelector("[data-page-chrome]") as HTMLElement;
    const row = band.lastElementChild as HTMLElement;
    expect(row).toHaveClass("min-h-11");
    expect(row).not.toHaveAttribute("aria-hidden");
    expect(document.querySelectorAll("[data-toolbar]")).toHaveLength(1);
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
    await waitFor(() => expect(document.querySelector("[data-toolbar]")).not.toHaveTextContent("2,000 名"));
    expect((document.querySelector("[data-page-chrome]") as HTMLElement).lastElementChild).toHaveClass("min-h-11");
  });

  it("draws no toolbar row in the conversation view, which has no tab-level controls, and leaves no tab selected", () => {
    draw({ view: "chat" });
    expect(document.querySelectorAll("[data-toolbar]")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "查看：对话" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("button", { name: "研究对话" })).toBeNull();
    expect(document.querySelectorAll("[data-rail-step]").length).toBeGreaterThan(0);
  });
});

it("offers result navigation and conversation without queued next-step actions", async () => {
  draw();
  expect(screen.queryByRole("button", { name: /下一步|接着做|选择方法/ })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "查看：总览" }));
  for (const label of ["匹配", "人群与患者", "对照", "试验", "依据"]) expect(screen.getByRole("menuitemradio", { name: label })).toBeInTheDocument();
});

describe("a tab's own primary action is the header's", () => {
  const solid = (button: HTMLElement) => button.className.includes("bg-accent");
  // The fixture study has computations waiting for the lead's word on the budget, which is the header's primary while it lasts: this one has no lead.
  const noLead = () => study((raw) => { raw.abilities = raw.abilities.filter((ability: string) => ability !== "manage_study"); });
  /** A tab that asks the frame for a primary of its own, as 试验 does until a design is chosen. */
  function Choosing({ ask = true }: { ask?: boolean }) {
    const [chosen, setChosen] = useState(false);
    useVcrPrimary(ask ? { label: "选定方案", onSelect: () => setChosen(true) } : null);
    return <p data-testid="chosen">{chosen ? "已选" : "未选"}</p>;
  }

  it("is drawn in the header as the solid button, with the study's next step quiet beside it — never two solid buttons", async () => {
    draw({ study: noLead(), children: <Choosing /> });
    const header = document.querySelector("[data-page-header]") as HTMLElement;
    const chosen = within(header).getByRole("button", { name: "选定方案" });
    expect(solid(chosen)).toBe(true);
    expect(within(header).queryByRole("button", { name: "接着做：生成虚拟患者" })).toBeNull();
    expect([...header.querySelectorAll("button")].filter(solid)).toHaveLength(1);
    await userEvent.click(chosen);
    expect(screen.getByTestId("chosen")).toHaveTextContent("已选");
  });

  it("goes when the tab asks for none, and the next step is the solid one again", () => {
    draw({ study: noLead(), children: <Choosing ask={false} /> });
    const header = document.querySelector("[data-page-header]") as HTMLElement;
    expect(within(header).queryByRole("button", { name: "选定方案" })).toBeNull();
    expect(within(header).queryByRole("button", { name: "接着做：生成虚拟患者" })).toBeNull();
  });
});

describe("对话 is a view of the page", () => {
  it("is a button in the header that opens the study's conversation view in the same page, and is pressed there", async () => {
    const onChat = vi.fn();
    const closed = draw({ onChat });
    await userEvent.click(screen.getByRole("button", { name: "研究对话" }));
    expect(onChat).toHaveBeenCalledOnce(); closed.unmount();
    draw({ view: "chat", onChat });
    expect(screen.queryByRole("button", { name: "研究对话" })).toBeNull();
    expect(screen.getByRole("button", { name: "查看：对话" })).toBeInTheDocument();
    expect(onChat).toHaveBeenCalledOnce();
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
    expect(strip).toMatchObject({ label: "构建人群", phase: "检索 6 次 · 结论 4/10 已核对", queued: 2, startedAt: "2026-10-14T01:00:00.000Z" });
    strip?.onCancel?.();
    expect(onCancel).toHaveBeenCalled();
  });

  it("is a step in line with what it waits for, and it can be stopped: the cancel holds the programme, so what waits is not taken up", () => {
    const strip = activityStripOf(base((raw) => { raw.activity = { run: null, queue: [{ step: "patients", waitingFor: "allowance" }], jobs: [], last: null }; }), { onCancel: () => undefined });
    expect(strip).toMatchObject({ label: "生成虚拟患者", waiting: "等研究额度" });
    expect(strip?.onCancel).toBeTypeOf("function");
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
    expect(screen.queryByRole("button", { name: "研究对话" })).toBeNull();
    expect(screen.getByRole("button", { name: "查看：对话" })).toBeInTheDocument();
  });

  it("a run that holds the project's runtime is drawn like any other: the pane, not the strip, says the conversation is held", () => {
    expect(stripOf("bounded-locked")).toMatchObject({ label: "整理研究定义", phase: "检索 1 次" });
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

it("shows only the matching task's process while keeping result destinations reachable", () => {
  draw({ study: study(raw => { raw.steps = { matching: { status: "queued", requested: true }, trial: { status: "none", requested: false } }; }), view: "chat" });
  const progress = screen.getByRole("navigation", { name: "研究进度" });
  expect(progress.querySelectorAll("[data-rail-step]")).toHaveLength(1);
  expect(progress.querySelector('[data-rail-step="matching"]')).toHaveTextContent("排队中");
  expect(progress.querySelector('[data-rail-step="trial"]')).toBeNull();
});
