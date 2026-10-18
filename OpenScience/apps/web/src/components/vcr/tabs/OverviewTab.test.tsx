import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readVcrStudy, type VcrStudy } from "@/lib/vcrClient";
import { EMPTY_STUDY_ID, fixture, installVcrServer, STUDY_ID } from "../__fixtures__/serverFixtures";
import { StudyFrameContext, type StudyFrameApi } from "../studyFrameContext";
import { OverviewTab } from "./OverviewTab";

/**
 * 总览, rendered from what the server sends (R19, plan §5.3; audit B §4.4): the study's sentence, the numbers it has, what needs the
 * reader, the seven steps as one list, and what it produced. These are the tests of the overview's own body: the next step is the
 * frame's (`StudyFrame.test.tsx`), and every tab's band and strip are asserted with the page (`VcrStudyPage.test.tsx`).
 */
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));
vi.mock("@/lib/projects", () => ({
  useProjectStore: { getState: () => ({ projects: [{ id: "prj_ev201" }, { id: "prj_empty" }], select: vi.fn(), load: vi.fn() }) },
}));

const study = (change?: (raw: any) => void): VcrStudy => {
  const raw = fixture("ev201/study.json");
  change?.(raw);
  return readVcrStudy(raw);
};

/** A frame that records what the tab asks of it. */
function frame(overrides: Partial<StudyFrameApi> = {}): StudyFrameApi {
  return {
    studyId: STUDY_ID,
    version: "v",
    activity: null,
    refresh: vi.fn(),
    openChat: vi.fn(),
    openPanel: vi.fn(),
    setToolbar: vi.fn(),
    setPrimary: vi.fn(),
    ...overrides,
  };
}

function draw(value: VcrStudy, api: StudyFrameApi | null = null, id = STUDY_ID) {
  return render(
    <MemoryRouter>
      <StudyFrameContext.Provider value={api}>
        <OverviewTab studyId={id} study={value} />
      </StudyFrameContext.Provider>
    </MemoryRouter>,
  );
}

const address = (tab: string) => `/app/virtual-research/${STUDY_ID}${tab ? `/${tab}` : ""}`;
const rows = () => within(screen.getByRole("list", { name: "七个步骤" })).getAllByRole("listitem");

beforeEach(() => {
  toasts.success.mockReset();
  toasts.error.mockReset();
  installVcrServer(network.productRequest);
});

describe("总览", () => {
  it("leads with the study's own sentence, and the question when the study has not found anything yet", () => {
    draw(study());
    expect(screen.getByText("已模拟 3 个方案，成功把握 58%～74%；真实外部对照不可估计，缺 3 项数据。")).toBeInTheDocument();
  });

  it("is the sentence, the numbers it has, what needs the reader, the seven steps and the deliverables — in that order, and nothing stacked under them", () => {
    const { container } = draw(study());
    const all = [...container.querySelectorAll("*")];
    const order = [
      container.querySelector("[data-vcr-counts]"),
      container.querySelector("[data-vcr-attention]"),
      screen.getByRole("list", { name: "七个步骤" }),
      screen.getByRole("heading", { name: "交付物" }),
    ];
    const positions = order.map((element) => all.indexOf(element as Element));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    for (const gone of ["关键数字", "最近的变化", "知识包与定义", "病种定义包", "方案的成功把握与周期、成本"]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
    expect(container.querySelector("[data-vcr-scatter]")).toBeNull();
    expect(container.querySelector("[data-vcr-knowledge]")).toBeNull();
  });

  it("has no button for the next step: it is the header's, on every tab", () => {
    const raw = fixture("ev201/study.json");
    raw.steps.trial = { status: "none", requested: false };
    draw(readVcrStudy(raw));
    expect(screen.queryByRole("button", { name: /下一步/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "让 AI 做" })).toBeNull();
  });

  describe("the numbers it has", () => {
    it("draws only the counts the server sent — at T0 one, with the design it is of — and each opens what it counts", () => {
      const { container } = draw(study());
      const band = container.querySelector("[data-vcr-counts]") as HTMLElement;
      expect(within(band).getByText("方案 B")).toBeInTheDocument();
      expect(band.querySelectorAll("[data-vcr-count]")).toHaveLength(1);
      expect(band.querySelector("[data-vcr-count='generatedRecords']")).toHaveTextContent("约 648 万");
      // The generated records are those of the lead design, which the trial tab holds.
      expect(within(band).getByRole("link")).toHaveAttribute("href", address("trial"));
    });

    it("draws a count that is a true zero, and nothing for the counts the study has not got", () => {
      const { container } = draw(study((raw) => { raw.overview.counts = { realPatients: 0, events: 138 }; }));
      const band = container.querySelector("[data-vcr-counts]") as HTMLElement;
      expect(band.querySelector("[data-vcr-count='realPatients']")).toHaveTextContent("0");
      expect(band.querySelector("[data-vcr-count='events']")).toHaveTextContent("138");
      expect(band.querySelector("[data-vcr-count='effectiveSampleSize']")).toBeNull();
      expect(band.querySelector("[data-vcr-count='generatedRecords']")).toBeNull();
    });

    it("draws no band at all when there is no count", () => {
      const { container } = draw(study((raw) => { raw.overview.counts = null; }));
      expect(container.querySelector("[data-vcr-counts]")).toBeNull();
    });
  });

  describe("the seven steps", () => {
    it("is one list of seven rows in the study's order, each opening the tab that holds the step", () => {
      draw(study());
      const list = rows();
      expect(list).toHaveLength(7);
      const names = ["定义", "证据", "人群", "患者", "对照", "试验", "匹配"];
      const tabs = ["data", "data", "population", "patients", "comparator", "trial", "matching"];
      list.forEach((row, index) => {
        expect(row).toHaveTextContent(names[index]);
        expect(within(row).getByRole("link")).toHaveAttribute("href", address(tabs[index]));
      });
    });

    it("says each step's state in a word and the one number it found", () => {
      draw(study());
      const [definition, evidence, population, patients, , trial] = rows();
      expect(definition).toHaveTextContent("已完成");
      expect(definition).toHaveTextContent("v1");
      expect(evidence).toHaveTextContent("4 张假设卡");
      expect(population).toHaveTextContent("3,412 名");
      // A step that did not finish says so and keeps the number of what it kept.
      expect(patients.querySelector("[data-vcr-step-state='failed']")).not.toBeNull();
      expect(patients).toHaveTextContent("2,000 名");
      expect(trial).toHaveTextContent("成功把握 58–74%");
    });

    it("says nothing of time for a step nobody has started, and when the others moved for the rest", () => {
      draw(study((raw) => {
        raw.steps.matching = { ...raw.steps.matching, status: "none", requested: false };
        delete raw.stepSummaries.matching;
      }));
      const list = rows();
      expect(list[6].querySelector("[data-vcr-step-state='none']")).not.toBeNull();
      expect(list[6]).not.toHaveTextContent(/前|刚刚|今天|昨天/);
      expect(list[0]).toHaveTextContent(/前|刚刚|今天|昨天|月/);
    });

    it("tells a step in line from one that is running, and neither from one nobody has started", () => {
      draw(study((raw) => {
        raw.steps.trial = { ...raw.steps.trial, status: "running" };
        raw.steps.matching = { ...raw.steps.matching, status: "queued" };
        raw.steps.comparator = { ...raw.steps.comparator, status: "none" };
      }));
      const list = rows();
      expect(list[5].querySelector("[data-vcr-step-state='running']")).not.toBeNull();
      expect(list[6].querySelector("[data-vcr-step-state='queued']")).not.toBeNull();
      expect(list[4].querySelector("[data-vcr-step-state='none']")).not.toBeNull();
    });
  });

  describe("what needs the reader", () => {
    it("is one line each, with what to do about it: the tab the server named, and nothing for a line it did not send a way to", () => {
      draw(study());
      const region = screen.getByRole("region", { name: "需要关注" });
      expect(within(region).getByRole("link", { name: "查看缺口" })).toHaveAttribute("href", address("comparator"));
      // The wait on the budget is the frame's line, on every tab; a line with nothing to do is not a sentence on its own.
      expect(within(region).queryByText(/等你确认计算预算/)).toBeNull();
      expect(screen.queryByText(/由 AI 设定/)).toBeNull();
    });

    it("offers 接着做 for a step that did not finish, and starts that step without leaving the page", async () => {
      draw(study());
      const region = screen.getByRole("region", { name: "需要关注" });
      await userEvent.click(within(region).getByRole("button", { name: "接着做" }));
      await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/run`, "POST", { step: "patients" }));
    });

    it("sends the stale line to the change log, which is the frame's drawer", async () => {
      const api = frame();
      draw(study(), api);
      await userEvent.click(screen.getByRole("button", { name: "看变更记录" }));
      expect(api.openPanel).toHaveBeenCalledWith("changes");
    });

    it("offers no 接着做 to a reader who may not run a step", () => {
      draw(study((raw) => { raw.abilities = ["read"]; }));
      expect(screen.queryByRole("button", { name: "接着做" })).toBeNull();
    });

    it("is not drawn at all while there is nothing in it", () => {
      const { container } = draw(study((raw) => { raw.overview.attention = []; }));
      expect(container.querySelector("[data-vcr-attention]")).toBeNull();
      expect(screen.queryByText("需要关注")).toBeNull();
      expect(screen.queryByText(/现在没有需要你处理的事/)).toBeNull();
    });
  });

  describe("the deliverables", () => {
    it("lists the finished ones, each opening the package in the reader on this page, and folds the drafts under one line", () => {
      const { container } = draw(study());
      const section = screen.getByRole("heading", { name: "交付物" }).closest("section") as HTMLElement;
      expect(within(section).getByRole("link", { name: /研究包 v1/ })).toHaveAttribute("href", `${address("")}?package=exp_2`);
      // The draft is behind one line that counts them, closed until the reader opens it.
      const fold = section.querySelector("details") as HTMLDetailsElement;
      expect(fold).not.toBeNull();
      expect(fold).toHaveTextContent("草稿 1");
      expect(fold.open).toBe(false);
      expect(within(fold).getByRole("link", { name: /CDE 沟通交流资料包/, hidden: true })).toHaveAttribute("href", `${address("")}?package=exp_1`);
      expect(container.querySelectorAll("details")).toHaveLength(1);
    });

    it("is not drawn when the study has produced nothing", () => {
      draw(study((raw) => { raw.overview.deliverables = []; }));
      expect(screen.queryByRole("heading", { name: "交付物" })).toBeNull();
    });
  });

  describe("a study nobody has described", () => {
    it("says what is missing — the first sentence, in the conversation — and has none of the lists", () => {
      const { container } = draw(readVcrStudy(fixture("empty/study.json")), null, EMPTY_STUDY_ID);
      expect(container.querySelector("[data-vcr-counts]")).toBeNull();
      expect(screen.queryByRole("list", { name: "七个步骤" })).toBeNull();
      expect(screen.getByRole("button", { name: "说明研究问题" })).toBeInTheDocument();
    });

    it("opens the study's conversation view from 说明研究问题, through the frame", async () => {
      const api = frame({ studyId: EMPTY_STUDY_ID });
      draw(readVcrStudy(fixture("empty/study.json")), api, EMPTY_STUDY_ID);
      await userEvent.click(screen.getByRole("button", { name: "说明研究问题" }));
      expect(api.openChat).toHaveBeenCalled();
    });
  });
});
