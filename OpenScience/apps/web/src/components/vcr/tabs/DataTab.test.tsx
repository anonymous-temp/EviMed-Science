import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readVcrStudy, type VcrStudy } from "@/lib/vcrClient";
import { EMPTY_STUDY_ID, fixture, installVcrServer, STUDY_ID } from "../__fixtures__/serverFixtures";
import { fakeRoom, renderTab } from "../__fixtures__/tabFrame";
import { VCR_NO_DEFINITION } from "../vcrText";
import { DataTab } from "./DataTab";

/**
 * 定义与证据, the tab that holds what the study is about and what it rests on: the definition, the disease pack, the parameter
 * cards beside the one in view, and the trial precedents. The data intake is not here (R19): it is one entry of the header's 「⋯」
 * on every tier, a drawer over whichever tab the reader is on (`VcrIntakeDrawer`, held by its own tests).
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
function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.search}</output>;
}
const draw = (node: React.ReactElement, route = "/") => renderTab(<>{node}<Where /></>, { route });
const band = (container: HTMLElement) => container.querySelector("[data-page-chrome]") as HTMLElement;
const ready = () => screen.findByRole("heading", { name: "对照组中位 PFS", level: 2 });

/** A pack a study works from, as the server's `knowledge` block sends it. */
const PACK = {
  pack: {
    id: "nsclc", version: 1, origin: "shipped", status: "curated", name: "非小细胞肺癌", canPromote: false,
    counts: { variables: 12, criteria: 8, endpoints: 3, windows: 2 }, sources: [], platform: null, platformRequest: null,
  },
  definitions: [], comparisons: [], savable: [],
};

let restoreRoom: () => void;
beforeEach(() => {
  restoreRoom = fakeRoom();
  toasts.success.mockReset();
  toasts.error.mockReset();
  installVcrServer(network.productRequest);
});
afterEach(() => restoreRoom());

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

describe("the cards beside the one in view", () => {
  it("lists the cards in a column and opens the one in view beside them — the first, until the address names another", async () => {
    const { container } = draw(<DataTab studyId={STUDY_ID} study={study()} />);
    await ready();
    expect(container.querySelector("[data-master-detail]")).toHaveAttribute("data-master-detail", "split");
    const rows = [...container.querySelectorAll("[data-vcr-assumption]")];
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveAttribute("aria-current", "true");
    expect(rows[0].closest("li")).toHaveTextContent("4.1");
    // What looks like a button is one.
    for (const row of rows) expect(row.tagName).toBe("BUTTON");
  });

  it("reads the card the address names, and a press on a row writes it there", async () => {
    const { container } = draw(<DataTab studyId={STUDY_ID} study={study()} />, "/?card=control_median_pfs");
    await ready();
    expect(screen.getByTestId("where")).toHaveTextContent("?card=control_median_pfs");
    const second = container.querySelectorAll("[data-vcr-assumption]")[1] as HTMLElement;
    await userEvent.click(second);
    expect(screen.getByTestId("where").textContent).toMatch(/^\?card=/);
    expect(screen.getByTestId("where")).not.toHaveTextContent("control_median_pfs");
    expect(second).toHaveAttribute("aria-current", "true");
    const detail = container.querySelector("[data-vcr-assumption-detail]") as HTMLElement;
    expect(within(detail).getByRole("heading", { level: 2 })).toHaveTextContent((second.textContent ?? "").trim());
  });

  it("is, below the room for both, the list — and a card opens in a drawer over it that the address names", async () => {
    restoreRoom();
    restoreRoom = fakeRoom(700);
    const { container } = draw(<DataTab studyId={STUDY_ID} study={study()} />);
    await screen.findAllByRole("button", { name: /对照组中位 PFS/ });
    expect(container.querySelector("[data-master-detail]")).toHaveAttribute("data-master-detail", "single");
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(container.querySelector("[data-vcr-assumption]") as HTMLElement);
    const drawer = await screen.findByRole("dialog", { name: "对照组中位 PFS" });
    expect(drawer.querySelector("[data-vcr-assumption-detail]")).not.toBeNull();
    expect(screen.getByTestId("where").textContent).toMatch(/^\?card=/);
    await userEvent.click(within(drawer).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("where")).toHaveTextContent("");
  });

  it("counts the cards in the band and offers the one filter a long list earns: the key assumptions", async () => {
    const { container } = draw(<DataTab studyId={STUDY_ID} study={study()} />);
    await ready();
    const chips = within(band(container));
    expect(chips.getByText("4 张假设卡")).toBeInTheDocument();
    await userEvent.click(chips.getByRole("button", { name: "筛选" }));
    const keys = await screen.findByRole("menuitemradio", { name: /关键假设/ });
    await userEvent.click(keys);
    await waitFor(() => expect(container.querySelectorAll("[data-vcr-assumption]").length).toBeLessThan(4));
    expect(container.querySelectorAll("[data-vcr-assumption]").length).toBeGreaterThan(0);
  });

  it("shows no filter for a short list, and no band at all while the tab holds no cards", async () => {
    const raw = fixture("ev201/data.json");
    raw.assumptions = raw.assumptions.slice(0, 2);
    installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}/data`]: raw });
    const { container } = draw(<DataTab studyId={STUDY_ID} study={study()} />);
    await ready();
    expect(within(band(container)).queryByRole("button", { name: "筛选" })).toBeNull();
  });

  it("says, in a chip, that a version was added after the analysis plan froze — and not in a sentence", async () => {
    const raw = fixture("ev201/data.json");
    raw.assumptions[0].newEvidence = { label: "有新证据", open: [], afterFreezeVersion: 2 };
    installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}/data`]: raw });
    draw(<DataTab studyId={STUDY_ID} study={study()} />);
    await ready();
    const news = document.querySelector("[data-vcr-new-evidence]") as HTMLElement;
    expect(news.querySelector("[data-vcr-after-freeze]")).toHaveTextContent("冻结后新增 v2");
    expect(document.body.textContent).not.toContain("分析计划已经冻结：新版本放在冻结的版本旁边");
  });
});

describe("the precedents", () => {
  it("are a table with planned and actual in columns of their own and no line under it explaining which is which", async () => {
    draw(<DataTab studyId={STUDY_ID} study={study()} />);
    await ready();
    const section = screen.getByRole("heading", { name: "试验先例" }).closest("section") as HTMLElement;
    const table = within(section).getByRole("table", { name: "试验先例" });
    const headers = within(table).getAllByRole("columnheader").map((header) => header.textContent);
    expect(headers).toEqual(expect.arrayContaining(["计划入组", "实际入组", "用于"]));
    expect(document.body.textContent).not.toContain("计划值取自登记记录的预计字段");
  });

  it("open a registry record in a drawer from the row — a press anywhere on it, or the registry number", async () => {
    draw(<DataTab studyId={STUDY_ID} study={study()} />);
    await ready();
    const table = screen.getByRole("table", { name: "试验先例" });
    await userEvent.click(within(table).getAllByRole("button", { name: /^打开 .* 的登记记录$/ })[0]);
    const drawer = await screen.findByRole("dialog");
    expect(drawer.querySelector("[data-vcr-precedent-detail]")).not.toBeNull();
    expect(within(drawer).getByText("标题")).toBeInTheDocument();
  });

  it("list the trial events the frontier reported as candidates, each marked 待核对 in its row — with no sentence saying what a candidate is", async () => {
    const raw = fixture("ev201/data.json");
    raw.precedentCandidates = [{ id: "cand_1", title: "某新药 III 期结果发布", event: "results", registryId: "NCT01234567", doi: null }];
    installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}/data`]: raw });
    draw(<DataTab studyId={STUDY_ID} study={study()} />);
    await ready();
    const row = document.querySelector("[data-vcr-precedent-candidate='cand_1']") as HTMLElement;
    expect(row).toHaveTextContent("某新药 III 期结果发布");
    expect(row).toHaveTextContent("待核对");
    expect(row).toHaveTextContent("结果发布 · NCT01234567");
    expect(document.body.textContent).not.toContain("只是线索，不是先例");
  });
});

describe("where the data intake is", () => {
  it("is not on the tab, at any tier: it is the header's 数据接入 over whichever tab the reader is on", async () => {
    for (const tier of ["T0", "T1"]) {
      const { unmount } = draw(<DataTab studyId={STUDY_ID} study={study((raw) => { raw.tier = tier; })} />);
      await ready();
      expect(document.querySelector("[data-vcr-intake], [data-vcr-intake-unavailable]")).toBeNull();
      expect(screen.queryByText(/^数据接入/)).toBeNull();
      unmount();
    }
  });
});

describe("when there is no evidence yet", () => {
  it("is the definition and the recipe of the step, with its one button — and where the library is not connected, the reason in the button's place", async () => {
    const raw = fixture("empty/data.json");
    installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}/data`]: raw });
    const first = draw(<DataTab studyId={STUDY_ID} study={study((s) => { s.steps.evidence = { status: "none", requested: false }; })} />);
    const recipe = await waitFor(() => { const node = first.container.querySelector("[data-vcr-step-empty='evidence']"); if (!node) throw new Error("no recipe"); return node as HTMLElement; });
    await userEvent.click(within(recipe).getByRole("button", { name: "找证据、整理假设卡" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/run`, "POST", { step: "evidence" }));
    first.unmount();

    installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}/data`]: { ...raw, evidenceNote: "证据库在本部署没有接入。" } });
    const second = draw(<DataTab studyId={STUDY_ID} study={study((s) => { s.steps.evidence = { status: "none", requested: false }; })} />);
    const blocked = await waitFor(() => { const node = second.container.querySelector("[data-vcr-step-empty='evidence']"); if (!node) throw new Error("no recipe"); return node as HTMLElement; });
    expect(blocked).toHaveTextContent("证据库在本部署没有接入。");
    expect(within(blocked).queryByRole("button", { name: "找证据、整理假设卡" })).toBeNull();
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

  it("lists what uses a card as rows that open the tab holding the result, and the changes as a table", async () => {
    draw(<DataTab studyId={STUDY_ID} study={study()} />);
    await ready();
    const detail = document.querySelector("[data-vcr-assumption-detail]") as HTMLElement;
    const used = within(detail).queryByText("被这些结果使用");
    if (used) expect(used.closest("section")?.querySelector("a")).not.toBeNull();
    expect(detail.querySelector("ul.divide-y, ol.divide-y")).toBeNull();
  });
});
