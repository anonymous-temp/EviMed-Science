import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readVcrStudy, type VcrStudy } from "@/lib/vcrClient";
import { EMPTY_STUDY_ID, fixture, installVcrServer, STUDY_ID } from "../__fixtures__/serverFixtures";
import { VCR_NO_DEFINITION } from "../vcrText";
import { DataTab } from "./DataTab";

/**
 * 定义与证据, the tab that holds what the study is about and what it rests on: the definition, the disease pack, the parameter
 * cards, the trial precedents and — where real data is allowed — the data intake, first.
 *
 * (The cards' own fields, edit and countersignature are held in `RecruitTabs.test.tsx`, which grew up with the tab.)
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
const emptyStudy = (): VcrStudy => readVcrStudy(fixture("empty/study.json"));
const draw = (node: React.ReactElement) => render(<MemoryRouter>{node}</MemoryRouter>);
const ready = () => screen.findByText("对照组中位 PFS", { selector: "h2" });

/** A pack a study works from, as the server's `knowledge` block sends it. */
const PACK = {
  pack: {
    id: "nsclc", version: 1, origin: "shipped", status: "curated", name: "非小细胞肺癌", canPromote: false,
    counts: { variables: 12, criteria: 8, endpoints: 3, windows: 2 }, sources: [], platform: null, platformRequest: null,
  },
  definitions: [], comparisons: [], savable: [],
};

beforeEach(() => {
  toasts.success.mockReset();
  toasts.error.mockReset();
  installVcrServer(network.productRequest);
});

describe("the definition card", () => {
  it("is the first card of the tab: the question and what the definition says, each on its own line, and what the study may be used for", async () => {
    draw(<DataTab studyId={STUDY_ID} study={study()} />);
    await ready();
    const card = document.querySelector("[data-vcr-definition]") as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.closest("section")).toHaveTextContent("研究定义");
    for (const [label, value] of [
      ["研究问题", "单臂 II 期加外部对照行不行，还是必须做随机？"],
      ["人群", "EGFR/ALK 阴性晚期非小细胞肺癌，一线含铂化疗 ± 免疫治疗后进展"],
      ["干预", "EV-201"],
      ["对照", "多西他赛"],
      ["结局", "PFS"],
      ["估计什么", "试验人群的无进展生存（PFS）"],
      ["终点类型", "事件时间"],
      ["预期用途", "研究设计支持"],
    ]) {
      expect(within(card).getByText(label).nextElementSibling).toHaveTextContent(value);
    }
  });

  it("says when the results cannot carry the use the study asked for", async () => {
    draw(<DataTab studyId={STUDY_ID} study={study((raw) => {
      raw.intendedUse = "specified_analysis";
      raw.ceiling = { ceiling: "design_support", requested: "specified_analysis", withinCeiling: false, reasons: [] };
    })}
    />);
    await ready();
    expect(within(document.querySelector("[data-vcr-definition]") as HTMLElement).getByText("预期用途").nextElementSibling)
      .toHaveTextContent("指定研究分析（结果目前只够用于研究设计支持）");
  });

  it("is not drawn for a study nobody has described: that tab says the first sentence is missing", async () => {
    draw(<DataTab studyId={EMPTY_STUDY_ID} study={emptyStudy()} />);
    expect(await screen.findByText(VCR_NO_DEFINITION)).toBeInTheDocument();
    expect(document.querySelector("[data-vcr-definition]")).toBeNull();
  });
});

describe("what moved here from 总览", () => {
  it("holds the disease pack as 病种定义包 — the library's definitions stay 人群定义", async () => {
    draw(<DataTab studyId={STUDY_ID} study={study((raw) => { raw.knowledge = PACK; })} />);
    await ready();
    const section = document.querySelector("[data-vcr-knowledge]")?.closest("section") as HTMLElement;
    expect(section).toHaveTextContent("病种定义包");
    expect(section).toHaveTextContent("非小细胞肺癌");
    expect(document.body.textContent).not.toMatch(/知识包/);
  });

  it("puts the pack after the definition and before the cards", async () => {
    draw(<DataTab studyId={STUDY_ID} study={study((raw) => { raw.knowledge = PACK; })} />);
    await ready();
    const definition = document.querySelector("[data-vcr-definition]") as Element;
    const pack = document.querySelector("[data-vcr-knowledge]") as Element;
    const cards = document.querySelector("[data-vcr-assumption]") as Element;
    expect(definition.compareDocumentPosition(pack) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pack.compareDocumentPosition(cards) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("has no list of reviews, no decision log and no strip of statistics above the cards — the change log has them", async () => {
    draw(<DataTab studyId={STUDY_ID} study={study()} />);
    await ready();
    expect(screen.queryByText("研究复核")).toBeNull();
    expect(screen.queryByText("决策记录")).toBeNull();
    expect(screen.queryByText(/试验先例 3 项 · 假设卡 4 张/)).toBeNull();
  });
});

describe("where the data intake is", () => {
  const withIntake = (tier: string) => study((raw) => { raw.tier = tier; });
  const position = (first: Element, second: Element) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

  it("is first when the tier allows real data: everything under it is read from what it holds", async () => {
    draw(<DataTab studyId={STUDY_ID} study={withIntake("T1")} />);
    await ready();
    const intake = document.querySelector("[data-vcr-intake-unavailable], [data-vcr-intake]") as Element;
    const definition = document.querySelector("[data-vcr-definition]") as Element;
    expect(intake).not.toBeNull();
    expect(position(intake, definition)).toBe(true);
  });

  it("is last at T0, after the precedents, when there is anything to show of it", async () => {
    const raw = fixture("ev201/data.json");
    raw.intake = { ...raw.intake, available: true, message: null, formats: ["csv"], maxBytes: 1_000_000 };
    installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}/data`]: raw });
    draw(<DataTab studyId={STUDY_ID} study={study()} />);
    await ready();
    const intake = document.querySelector("[data-vcr-intake]") as Element;
    const definition = document.querySelector("[data-vcr-definition]") as Element;
    const precedents = screen.getByRole("heading", { name: "试验先例" });
    expect(position(definition, intake)).toBe(true);
    expect(position(precedents, intake)).toBe(true);
  });
});

describe("the data intake at a tier that takes no real data", () => {
  const intakeWith = (sources: number) => {
    const raw = fixture("ev201/data.json");
    raw.intake = { ...fixture("intake/data-none.json").intake };
    if (sources > 0) raw.intake = { ...fixture("intake/data-sealed.json").intake };
    installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}/data`]: raw });
  };

  it("is one folded line at the end — its form is not on the page — until somebody opens it", async () => {
    intakeWith(0);
    draw(<DataTab studyId={STUDY_ID} study={study()} />);
    await ready();
    const fold = screen.getByText("数据接入").closest("details") as HTMLDetailsElement;
    expect(fold).not.toBeNull();
    expect(fold.open).toBe(false);
    // No second heading of its own: the line is the heading.
    expect(screen.queryByRole("heading", { name: "数据接入" })).toBeNull();
    await userEvent.click(within(fold).getByText("数据接入"));
    expect(fold.open).toBe(true);
    expect(within(fold).getByText(/还没有数据源。登记一个/)).toBeInTheDocument();
    expect(within(fold).getByLabelText("名称")).toBeInTheDocument();
  });

  it("is open, and says how many sources it holds, when a source is already registered", async () => {
    intakeWith(1);
    draw(<DataTab studyId={STUDY_ID} study={study()} />);
    await ready();
    const fold = screen.getByText(/^数据接入 · \d+ 个数据源$/).closest("details") as HTMLDetailsElement;
    expect(fold.open).toBe(true);
    expect(fold.querySelector("[data-vcr-source]")).not.toBeNull();
  });
});

describe("a card's own words", () => {
  it("shows no version number beside a card or a review — the date says when", async () => {
    draw(<DataTab studyId={STUDY_ID} study={study()} />);
    await ready();
    const detail = document.querySelector("[data-vcr-assumption-detail]") as HTMLElement;
    expect(detail.textContent).not.toMatch(/版本\s*\d|针对版本/);
    await userEvent.click(within(document.querySelector("[data-vcr-assumption-detail]") as HTMLElement).getByRole("button", { name: "改这张卡" }));
    const form = document.querySelector("[data-vcr-assumption-edit]") as HTMLElement;
    await userEvent.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已保存。"));
  });
});
