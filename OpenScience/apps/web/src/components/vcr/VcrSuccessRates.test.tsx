import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { readSuccessRates, readVcrTrial, type VcrSuccessRates as SuccessRates } from "@/lib/vcrClient";
import { VcrSuccessRates } from "./VcrSuccessRates";
import payloads from "./__fixtures__/evidenceSynthesisPayloads.json";

/**
 * 历史上这一阶段的通过率: the reference table of the two published sources, drawn from the server's own page
 * (`__fixtures__/evidenceSynthesisPayloads.json`). A reference for the phase, in two columns, never this trial's probability.
 */

afterEach(cleanup);

const sample = (): SuccessRates => {
  const rates = readSuccessRates(payloads.successRates);
  if (!rates) throw new Error("the success rates sample did not read");
  return rates;
};
const draw = (rates: SuccessRates | null = sample()) => {
  const view = render(<VcrSuccessRates rates={rates} />);
  return { ...view, root: view.container.querySelector("[data-vcr-success-rates]") as HTMLElement };
};
const source = (root: HTMLElement, key: "bio" | "wong") => root.querySelector(`[data-vcr-success-source='${key}']`) as HTMLElement;
const figure = (column: HTMLElement, label: string) => column.querySelector(`[data-vcr-success-figure='${label}']`) as HTMLElement | null;
const NOT_IN_SOURCE = "这个来源没有这一栏";

describe("通过率 · the reference", () => {
  it("opens with its title and the sentence that it is not this trial's probability", () => {
    const { root } = draw();
    expect(within(root).getByRole("heading", { name: "历史上这一阶段的通过率" })).toBeInTheDocument();
    expect(root.querySelector("[data-vcr-success-note]")).toHaveTextContent("不是这个试验成功的概率");
    expect(root.querySelector("[role='alert'], [role='status']")).toBeNull();
  });

  it("starts at the third phase of all indications, in two columns, one for each source", () => {
    const { root } = draw();
    expect(within(root).getByLabelText("阶段")).toHaveValue("phase3");
    expect(within(root).getByLabelText("适应症")).toHaveValue("all");
    const columns = [...root.querySelectorAll("[data-vcr-success-source]")];
    expect(columns.map((column) => column.getAttribute("data-vcr-success-source"))).toEqual(["bio", "wong"]);
    expect(within(source(root, "bio")).getByRole("heading", { name: "BIO / Informa / QLS（2011–2020）" })).toBeInTheDocument();
    expect(within(source(root, "wong")).getByRole("heading", { name: "Wong / Siah / Lo（2019）" })).toBeInTheDocument();
  });

  it("gives each source its own figures with what each counts to and the number it stands on", () => {
    const { root } = draw();
    const bio = source(root, "bio");
    expect(figure(bio, "到提交申报")).toHaveTextContent("57.8%");
    expect(figure(bio, "到提交申报")).toHaveTextContent("基于 1,928 次阶段转换");
    expect(figure(bio, "到获批")).toHaveTextContent("52.4%");
    expect(figure(bio, "到获批")).toHaveTextContent("基于 3,381 次阶段转换");
    const wong = source(root, "wong");
    expect(figure(wong, "到获批")).toHaveTextContent("59%");
    expect(figure(wong, "到获批")).toHaveTextContent("基于 7,532 条研发路径");
  });

  it("says a source does not have a figure the other has, and never fills it from the other", () => {
    const { root } = draw();
    // BIO counts the third phase to the filing; Wong has no such figure
    const missing = figure(source(root, "wong"), "到提交申报") as HTMLElement;
    expect(missing).toHaveTextContent(NOT_IN_SOURCE);
    expect(missing).not.toHaveTextContent("57.8");
    expect(missing.querySelector("[data-vcr-success-rate]")).toBeNull();
    // and the reverse: the rows are the same in both columns, so the pair reads across
    expect([...source(root, "bio").querySelectorAll("[data-vcr-success-figure]")].map((row) => row.getAttribute("data-vcr-success-figure")))
      .toEqual([...source(root, "wong").querySelectorAll("[data-vcr-success-figure]")].map((row) => row.getAttribute("data-vcr-success-figure")));
  });

  it("changes the figures with the phase", async () => {
    const { root } = draw();
    await userEvent.selectOptions(within(root).getByLabelText("阶段"), "phase2");
    const bio = source(root, "bio");
    expect(figure(bio, "进入下一期")).toHaveTextContent("28.9%");
    expect(figure(bio, "到获批")).toHaveTextContent("15.1%");
    expect(figure(bio, "到提交申报")).toBeNull();
    const wong = source(root, "wong");
    // the paper's overall second-phase rate to the next phase is left out: one source's missing cell is that source's alone
    expect(figure(wong, "进入下一期")).toHaveTextContent(NOT_IN_SOURCE);
    expect(figure(wong, "到获批")).toHaveTextContent("35.1%");
    await userEvent.selectOptions(within(root).getByLabelText("阶段"), "phase1");
    expect(figure(wong, "进入下一期")).toHaveTextContent("66.4%");
    expect(figure(wong, "进入下一期")).toHaveTextContent("基于 41,040 条研发路径");
    // a figure with no count stands without one
    expect(figure(wong, "到获批")).toHaveTextContent("13.8%");
    expect(figure(wong, "到获批")).not.toHaveTextContent("基于");
  });

  it("changes the figures with the indication, and names the group a source counted the indication in when it is another name", async () => {
    const { root } = draw();
    await userEvent.selectOptions(within(root).getByLabelText("适应症"), "oncology");
    expect(figure(source(root, "bio"), "到获批")).toHaveTextContent("43.9%");
    expect(figure(source(root, "wong"), "到获批")).toHaveTextContent("35.5%");
    expect(root.querySelector("[data-vcr-success-group]")).toBeNull();
    await userEvent.selectOptions(within(root).getByLabelText("适应症"), "neurology");
    expect(figure(source(root, "bio"), "到获批")).toHaveTextContent("46%");
    expect(figure(source(root, "wong"), "到获批")).toHaveTextContent("51.1%");
    expect(source(root, "wong").querySelector("[data-vcr-success-group]")).toHaveTextContent("该来源按“中枢神经（含精神）”统计");
    expect(source(root, "bio").querySelector("[data-vcr-success-group]")).toBeNull();
  });

  it("says once, in place of the figures, that a source has no row for the indication", async () => {
    const { root } = draw();
    await userEvent.selectOptions(within(root).getByLabelText("适应症"), "hematology");
    const wong = source(root, "wong");
    expect(wong.querySelectorAll("[data-vcr-success-missing]")).toHaveLength(1);
    expect(wong).toHaveTextContent(NOT_IN_SOURCE);
    expect(wong.querySelector("[data-vcr-success-figure]")).toBeNull();
    expect(wong.querySelector("[data-vcr-success-rate]")).toBeNull();
    // the other source is not touched by it, and its figures are its own
    expect(figure(source(root, "bio"), "到提交申报")).toHaveTextContent("76.8%");
    expect(figure(source(root, "bio"), "到获批")).toHaveTextContent("71.5%");
  });

  it("keeps how each source counts behind “怎么统计的”, closed until it is asked for", async () => {
    const { root } = draw();
    for (const key of ["bio", "wong"] as const) {
      const details = source(root, key).querySelector("details") as HTMLDetailsElement;
      expect(within(details).getByText("怎么统计的")).toBeInTheDocument();
      expect(details.open).toBe(false);
    }
    const bio = source(root, "bio").querySelector("details") as HTMLDetailsElement;
    expect(bio.querySelector("[data-vcr-success-method]")).toHaveTextContent("三期统计到提交上市申请");
    expect(bio.querySelector("[data-vcr-success-method]")).toHaveTextContent("按阶段统计");
    const wong = source(root, "wong").querySelector("details") as HTMLDetailsElement;
    expect(wong.querySelector("[data-vcr-success-method]")).toHaveTextContent("三期统计到获批");
    // the sentences are not on the page until the summary is pressed
    expect(bio.open).toBe(false);
    await userEvent.click(within(bio).getByText("怎么统计的"));
    expect(bio.open).toBe(true);
  });

  it("offers every phase and every indication the page carries, in native selects a keyboard reaches in order", async () => {
    const { root } = draw();
    const phase = within(root).getByLabelText("阶段") as HTMLSelectElement;
    const area = within(root).getByLabelText("适应症") as HTMLSelectElement;
    expect(phase.tagName).toBe("SELECT");
    expect([...phase.options].map((option) => option.textContent)).toEqual(["一期", "二期", "三期"]);
    expect(area.options).toHaveLength(16);
    expect(area.options[0].textContent).toBe("全部适应症");
    // reached by the Tab key in order, and each named by its label
    await userEvent.tab();
    expect(phase).toHaveFocus();
    await userEvent.tab();
    expect(area).toHaveFocus();
    expect(phase).toHaveAccessibleName("阶段");
    expect(area).toHaveAccessibleName("适应症");
  });
});

describe("通过率 · what is not there", () => {
  it("draws nothing for no reference", () => {
    expect(draw(null).container).toBeEmptyDOMElement();
  });

  it("says a source has no column when neither source has a figure for the choice, and does not crash", async () => {
    const rates = sample();
    const emptied: SuccessRates = {
      ...rates,
      areas: rates.areas.map((area) => ({ ...area, phases: Object.fromEntries(Object.entries(area.phases).map(([phase]) => [phase, { bio: null, wong: null }])) })),
    };
    const { root } = draw(emptied);
    expect(root.querySelectorAll("[data-vcr-success-missing]")).toHaveLength(2);
    expect(root.querySelector("[data-vcr-success-figure]")).toBeNull();
  });

  it("falls back to the first phase and the first indication when the usual ones are not offered", () => {
    const rates = sample();
    const { root } = draw({ ...rates, phases: rates.phases.slice(0, 2), areas: rates.areas.slice(1) });
    expect(within(root).getByLabelText("阶段")).toHaveValue("phase1");
    expect(within(root).getByLabelText("适应症")).toHaveValue("oncology");
  });

  it("leaves out the disclosure of a source that sent no words for it", () => {
    const rates = sample();
    const { root } = draw({ ...rates, sources: rates.sources.map((entry) => ({ ...entry, endpoint: null, method: null })) });
    expect(root.querySelector("details")).toBeNull();
  });
});

describe("读取 · the payload", () => {
  it("keeps every figure as the source prints it, and a source or a figure it lacks as null", () => {
    const rates = sample();
    expect(rates.sources.map((entry) => [entry.key, entry.id])).toEqual([["bio", "bio_2011_2020"], ["wong", "wong_2019"]]);
    const all = rates.areas.find((area) => area.id === "all")!;
    expect(all.phases.phase2.bio).toEqual({ toNext: { text: "28.9%", n: 4933 }, toFiling: null, toApproval: { text: "15.1%", n: 8314 } });
    expect(all.phases.phase2.wong?.toNext).toBeNull();
    expect(all.phases.phase1.wong?.toApproval).toEqual({ text: "13.8%", n: null });
    expect(rates.areas.find((area) => area.id === "hematology")!.phases.phase2.wong).toBeNull();
    expect(rates.areas.find((area) => area.id === "neurology")!.wongGroup).toBe("中枢神经（含精神）");
  });

  it("reads anything of an unknown shape as no reference, and leaves out a source the page has no column for", () => {
    for (const garbage of [undefined, null, 7, "x", [], {}, { title: "t" }, { title: "t", sources: [], phases: [], areas: [] }]) expect(readSuccessRates(garbage)).toBeNull();
    const odd = { ...payloads.successRates, sources: [...payloads.successRates.sources, { id: "third_2030", label: "x" }, { id: "bio_x" }] };
    expect(readSuccessRates(odd)?.sources.map((entry) => entry.key)).toEqual(["bio", "wong"]);
    const broken = { ...payloads.successRates, areas: [{ id: "all", label: "全部", phases: { phase3: { bio: "x", wong: { toApproval: { text: 59 } } } } }, { id: "none" }] };
    const read = readSuccessRates(broken)!;
    expect(read.areas).toHaveLength(1);
    expect(read.areas[0].phases.phase3).toEqual({ bio: null, wong: { toNext: null, toFiling: null, toApproval: null } });
  });

  it("comes through the trial tab's reader, null when the server sent none", () => {
    expect(readVcrTrial({ successRates: payloads.successRates }).successRates?.title).toBe("历史上这一阶段的通过率");
    for (const junk of [undefined, null, "x", {}, 5, []]) expect(readVcrTrial({ successRates: junk }).successRates).toBeNull();
  });
});
