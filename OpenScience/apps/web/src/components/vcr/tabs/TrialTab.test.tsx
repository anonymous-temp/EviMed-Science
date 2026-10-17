import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readVcrStudy, type VcrStudy } from "@/lib/vcrClient";
import { TrialTab, VCR_ADD_DESIGN_DRAFT, VCR_CHANGE_ASSUMPTION_DRAFT } from "./TrialTab";
import { renderTab } from "../__fixtures__/tabFrame";
import { EMPTY_STUDY_ID, fixture, installVcrServer, STUDY_ID } from "../__fixtures__/serverFixtures";
import { VCR_NO_DEFINITION } from "../vcrText";

/**
 * 试验 (R19; audit B §4.4): the designs as one table with power as a bar, a row that opens the run behind it, the charts side by
 * side, and the three kinds of record of the step (the designs, the visit schedule, the regulatory log) as a switch in the band.
 * Under a frame, so the band's buttons are where a reader finds them. Every payload is a fixture of the server's.
 */

const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

const ev201 = (): VcrStudy => readVcrStudy(fixture("ev201/study.json"));
const emptyStudy = (): VcrStudy => readVcrStudy(fixture("empty/study.json"));
const withStep = (step: string, fields: Record<string, unknown>): VcrStudy => {
  const raw = fixture("ev201/study.json");
  raw.steps[step] = { ...raw.steps[step], ...fields };
  return readVcrStudy(raw);
};
const readerOf = (): VcrStudy => { const raw = fixture("ev201/study.json"); raw.abilities = ["read"]; return readVcrStudy(raw); };
const leadOf = (): VcrStudy => {
  const lead = ev201();
  lead.features = { simulations: false, predictions: true, platformPacks: false };
  lead.abilities = [...lead.abilities, "manage_study"];
  return lead;
};
const tab = (name: string) => `GET /vcr/studies/${STUDY_ID}/${name}`;
const gets = (name: string) => network.productRequest.mock.calls.filter(([path, method]) => path === `/vcr/studies/${STUDY_ID}/${name}` && (method ?? "GET") === "GET");
const nothingIn = (name: string) => ({ [tab(name)]: fixture(`empty/${name}.json`) });
const draw = (study: VcrStudy = ev201()) => renderTab(<TrialTab studyId={STUDY_ID} study={study} />);
const band = (container: HTMLElement) => container.querySelector("[data-page-chrome]") as HTMLElement;
const found = (root: ParentNode, selector: string) => waitFor(() => {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`nothing at ${selector}`);
  return node as HTMLElement;
});
/** The trial tab has read its route and drawn its comparison of the designs. */
const trialDrawn = () => screen.findByRole("table", { name: "方案的对比" });
/** Every 「区间」 on screen carries its name (plan §9.6). */
const BARE_INTERVAL = /(?<!预测|置信|可信|蒙特卡洛)区间/;

beforeEach(() => {
  toasts.success.mockReset();
  toasts.error.mockReset();
  installVcrServer(network.productRequest);
});

describe("试验 · the designs", () => {
  it("lists every design, greys the dominated one with the server's own sentence and no numbers", async () => {
    const { container } = draw();
    await trialDrawn();
    const codes = [...container.querySelectorAll("tr[data-vcr-design]")].map((row) => row.getAttribute("data-vcr-design"));
    expect(codes).toEqual(["A", "B", "C", "D"]);
    const d = container.querySelector("tr[data-vcr-design='D']") as HTMLElement;
    expect(d).toHaveAttribute("data-vcr-dominated");
    // D is dominated by B, not by C: C beats it by less than three combined Monte-Carlo errors on every measure, which the tie rule counts no more.
    expect(d.querySelector("[data-vcr-dominated-note]")).toHaveTextContent("在比较目标的全部指标上都不优于 B");
    expect(d.querySelectorAll("[data-vcr-measure]")).toHaveLength(0);
    expect(d.textContent).not.toContain("%");
  });

  it("is, in the order a reader reads it: the band, the sentence, the table, the setup folded, the charts", async () => {
    const { container } = draw();
    const table = await trialDrawn();
    const order = [band(container), container.querySelector("[data-headline]") as HTMLElement, table, container.querySelector("[data-vcr-setup]") as HTMLElement, container.querySelector("[data-chart-grid]") as HTMLElement];
    order.forEach((node, index) => {
      expect(node, `item ${index}`).not.toBeNull();
      if (index > 0) expect(order[index - 1].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING, `item ${index}`).toBeTruthy();
    });
    const setup = container.querySelector("[data-vcr-setup]") as HTMLElement;
    expect(setup.closest("details")).not.toHaveAttribute("open");
    expect(within(setup.closest("details") as HTMLElement).getByText("模拟设定")).toBeInTheDocument();
    expect(setup.textContent).not.toMatch(/ADEMP/);
    // The charts sit two to a row and the rows are full.
    const rows = container.querySelectorAll("[data-chart-grid] [data-chart-row]");
    expect(rows.length).toBeGreaterThan(0);
  });

  it("draws power as a bar and its number — the one measure the page is read for — and the others as numbers", async () => {
    const { container } = draw();
    await trialDrawn();
    const b = container.querySelector("tr[data-vcr-design='B']") as HTMLElement;
    expect(within(b).getByRole("img", { name: /^B 功效 81/ })).toBeInTheDocument();
    expect(b.querySelector("[data-vcr-measure='power']")).toHaveTextContent("81");
    expect(b.querySelector("[data-vcr-measure='assurance'] [role='img']")).toBeNull();
  });

  it("puts a Monte-Carlo error beside every simulated number in the grid — and says what it is on hover, not in a line under the table", async () => {
    const { container } = draw();
    await trialDrawn();
    const simulated = [...container.querySelectorAll("tr[data-vcr-design] [data-vcr-measure][data-vcr-source='predicted']")];
    // Prove the walk walked: A has four simulated measures, B and C five each (sample size and cost are set, not simulated).
    expect(simulated).toHaveLength(14);
    for (const cell of simulated) expect(cell.querySelector("[data-vcr-mcse]")).not.toBeNull();
    const b = container.querySelector("tr[data-vcr-design='B'] [data-vcr-measure='assurance']") as HTMLElement;
    expect(b).toHaveTextContent("71.0");
    expect(b.querySelector("[data-vcr-mcse]")).toHaveTextContent("±0.40");
    expect(document.body.textContent).not.toContain("功效后的 ±");
    await userEvent.hover(b.querySelector("[data-vcr-mcse]") as HTMLElement);
    expect((await screen.findAllByText("蒙特卡洛标准误")).length).toBeGreaterThan(0);
  });

  it("names the prediction interval under the last-patient-in cell, and writes no bare 区间", async () => {
    const { container } = draw();
    await trialDrawn();
    const duration = container.querySelector("tr[data-vcr-design='B'] [data-vcr-measure='duration_months']") as HTMLElement;
    expect(duration.querySelector("[data-vcr-interval]")).toHaveTextContent("80% 预测区间 13.90–19.30");
    expect(container.querySelector("tr[data-vcr-design='B'] [data-vcr-measure='cost']")).toHaveTextContent("3,900");
    expect(screen.getByText("成本（万元）")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(BARE_INTERVAL);
  });

  it("keeps the error and the cost's unit on the trade-off scatter's labels", async () => {
    const { container } = draw();
    const label = await found(container, "[data-vcr-scatter-label='C']");
    expect(label).toHaveTextContent("74.0%");
    expect(label).toHaveTextContent("±0.40");
    expect(label).toHaveTextContent("4,600 万元");
  });

  it("draws each design's last patient in as a point inside its named prediction interval", async () => {
    const { container } = draw();
    const timeline = await found(container, "[data-vcr-milestones]");
    expect([...timeline.querySelectorAll("[data-vcr-milestone]")].map((row) => row.getAttribute("data-vcr-milestone"))).toEqual(["A", "B", "C"]);
    const b = timeline.querySelector("[data-vcr-milestone='B']") as HTMLElement;
    expect(b).toHaveTextContent("末例入组");
    expect(b).toHaveTextContent("16.40");
    expect(b).toHaveTextContent("80% 预测区间 13.90–19.30");
  });

  it("has no counts band of its own: the four numbers are on 总览", async () => {
    const { container } = draw();
    await trialDrawn();
    expect(container.querySelector("[data-vcr-counts]")).toBeNull();
  });

  it("keeps a stale result on screen under its bar — and what a reader does about it, in the band, is not under the grey", async () => {
    const raw = fixture("ev201/trial.json");
    raw.stale = { reason: "假设卡已变更", queued: false, since: null };
    installVcrServer(network.productRequest, { [tab("trial")]: raw });
    const { container } = draw();
    await trialDrawn();
    expect(container.querySelector("[data-vcr-stale]")).toHaveTextContent("假设卡已变更 · 输入已变更，这些数字可能已过期");
    const greyed = container.querySelector("[data-vcr-stale-block] .opacity-disabled") as HTMLElement;
    expect(greyed.querySelector("tr[data-vcr-design='B']")).not.toBeNull();
    expect(greyed.contains(band(container))).toBe(false);
    expect(within(band(container)).getByRole("button", { name: "改选方案" })).toBeEnabled();
  });

  it("says a stopped computation once, over the part that is there — one Chinese sentence and 续算, not a second box and the engine's English", async () => {
    const raw = fixture("ev201/trial.json");
    raw.partial = { sentence: "这次模拟算完了 18,000 / 20,000 次重复就到了计算时间上限，下面是已完成部分的结果。" };
    installVcrServer(network.productRequest, { [tab("trial")]: raw });
    const { container } = draw();
    await trialDrawn();
    const notes = container.querySelectorAll("[data-vcr-partial]");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent("这次模拟算完了 18,000 / 20,000 次重复就到了计算时间上限，下面是已完成部分的结果。");
    expect(container.querySelector("[data-vcr-step-failed]")).toBeNull();
    await userEvent.click(within(notes[0] as HTMLElement).getByRole("button", { name: "续算" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/run`, "POST", { step: "trial" }));
  });

  describe("the comparison", () => {
    it("shows how many replicates the simulation ran and what each number comes from, for the designs that have them", async () => {
      const raw = fixture("ev201/trial.json");
      raw.designs[1].replicates = 5000;
      raw.designs[1].method = "解析 + 模拟";
      raw.designs[2].replicates = 3000;
      raw.designs[2].method = "模拟";
      installVcrServer(network.productRequest, { [tab("trial")]: raw });
      const { container } = draw();
      await trialDrawn();
      expect(screen.getByRole("columnheader", { name: "模拟次数" })).toBeInTheDocument();
      expect(container.querySelector("tr[data-vcr-design='B'] [data-vcr-replicates]")).toHaveTextContent("5,000");
      expect(container.querySelector("tr[data-vcr-design='B'] [data-vcr-method]")).toHaveTextContent("解析 + 模拟");
      expect(container.querySelector("tr[data-vcr-design='C'] [data-vcr-method]")).toHaveTextContent("模拟");
    });

    it("draws neither column where nobody has the number", async () => {
      const raw = fixture("ev201/trial.json");
      for (const design of raw.designs) { design.replicates = null; design.method = null; }
      installVcrServer(network.productRequest, { [tab("trial")]: raw });
      draw();
      await trialDrawn();
      expect(screen.queryByRole("columnheader", { name: "模拟次数" })).toBeNull();
      expect(screen.queryByRole("columnheader", { name: "来源" })).toBeNull();
    });

    it("opens a design's numbers for editing from its own row — written as that design's next version", async () => {
      installVcrServer(network.productRequest, {
        [`GET /vcr/studies/${STUDY_ID}/cards?kind=trial_scenario&object=scn_2`]: {
          kind: "trial_scenario", objectId: "scn_2", title: "B",
          settings: [{ path: "design.nTreat", label: "试验组人数", value: 400, unit: "人", integer: true, min: 1, max: null }],
        },
      });
      draw();
      await trialDrawn();
      await userEvent.click(screen.getByRole("button", { name: "改设定：方案 B" }));
      const drawer = await screen.findByRole("dialog", { name: /改设定：B/ });
      const field = await within(drawer).findByLabelText("试验组人数（人）");
      await userEvent.clear(field);
      await userEvent.type(field, "450");
      await userEvent.click(within(drawer).getByRole("button", { name: "保存" }));
      await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/cards`, "POST",
        { kind: "trial_scenario", objectId: "scn_2", set: { "design.nTreat": 450 } }));
      await waitFor(() => expect(gets("trial")).toHaveLength(2));
    });
  });
});

describe("试验 · the run behind a row", () => {
  it("opens from the row — by a press anywhere on it, or by the design's name — and shows the run as numbers and a mark, not as sentences", async () => {
    const { container } = draw();
    await trialDrawn();
    // The record is not a card under the table any more.
    expect(screen.queryByText("本次运行")).toBeNull();
    await userEvent.click(container.querySelector("tr[data-vcr-design='B']") as HTMLElement);
    const drawer = await screen.findByRole("dialog", { name: "方案 B · 2:1 随机" });
    const record = drawer.querySelector("[data-vcr-design-record='B']") as HTMLElement;
    expect(record).toHaveTextContent("方法方案的模拟运行");
    expect(record).toHaveTextContent("模拟次数16,000");
    expect(record).toHaveTextContent("随机种子5");
    const check = record.querySelector("[data-vcr-check]") as HTMLElement;
    expect(check).toHaveAttribute("data-vcr-check", "agrees");
    expect(check).toHaveTextContent("解析 80 · 仿真 81");
    expect(check).toHaveTextContent("相差 0.4 个百分点");
    expect(within(check).getByRole("img", { name: "一致" })).toBeInTheDocument();
    expect(record.textContent).not.toMatch(/一阶近似|容许的/);
    await userEvent.click(within(drawer).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "打开方案 C 的计算详情" }));
    expect(await screen.findByRole("dialog", { name: /方案 C/ })).toBeInTheDocument();
  });

  it("marks a check that did not agree with a ⚠, and a closed form that is only a first-order approximation with its chip", async () => {
    const raw = fixture("ev201/trial.json");
    raw.designs[2].record.check = { analytic: 80, simulated: 86, differencePoints: 6, allowedPoints: 2.7, approximate: true, agrees: false };
    installVcrServer(network.productRequest, { [tab("trial")]: raw });
    const { container } = draw();
    await trialDrawn();
    await userEvent.click(container.querySelector("tr[data-vcr-design='C']") as HTMLElement);
    const check = (await screen.findByRole("dialog", { name: /方案 C/ })).querySelector("[data-vcr-check]") as HTMLElement;
    expect(check).toHaveAttribute("data-vcr-check", "differs");
    expect(within(check).getByRole("img", { name: "不一致" })).toBeInTheDocument();
    expect(check).toHaveTextContent("相差 6 个百分点（容许 2.7）");
    expect(check).toHaveTextContent("一阶近似");
  });

  it("offers 改设定 in the record for a reader who may write", async () => {
    const { container } = draw();
    await trialDrawn();
    await userEvent.click(container.querySelector("tr[data-vcr-design='B']") as HTMLElement);
    const drawer = await screen.findByRole("dialog", { name: /方案 B/ });
    expect(within(drawer).getByRole("button", { name: "改设定" })).toBeInTheDocument();
  });
});

describe("试验 · what the band offers", () => {
  it("is the choice, the two things said in the conversation, and the registry — in the band, above the table", async () => {
    const { container } = draw();
    const table = await trialDrawn();
    const chips = within(band(container));
    expect(chips.getByRole("button", { name: "改选方案" })).toBeInTheDocument();
    expect(chips.getByRole("button", { name: "加一个方案" })).toBeInTheDocument();
    expect(chips.getByRole("button", { name: "改假设" })).toBeInTheDocument();
    expect(band(container).compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chips.getByRole("button", { name: /^方案\s*4/ })).toBeInTheDocument();
  });

  it("offers 选定方案 as the one primary action while nothing has been chosen, and 改选方案 once something is", async () => {
    const raw = fixture("ev201/trial.json");
    raw.decision = null;
    for (const design of raw.designs) design.chosen = false;
    installVcrServer(network.productRequest, { [tab("trial")]: raw });
    const { container } = draw();
    await trialDrawn();
    expect(within(band(container)).getByRole("button", { name: "选定方案" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "改选方案" })).toBeNull();
    expect(container.querySelector("[data-headline]")).not.toHaveTextContent("已选定方案");
  });

  it("puts a draft in the study's conversation view for 加一个方案 and for 改假设 — and does not send it, and goes nowhere", async () => {
    const { container, spies } = draw();
    await trialDrawn();
    await userEvent.click(within(band(container)).getByRole("button", { name: "加一个方案" }));
    expect(spies.openChat).toHaveBeenLastCalledWith(VCR_ADD_DESIGN_DRAFT);
    await userEvent.click(within(band(container)).getByRole("button", { name: "改假设" }));
    expect(spies.openChat).toHaveBeenLastCalledWith(VCR_CHANGE_ASSUMPTION_DRAFT);
    expect(network.productRequest.mock.calls.some(([path, method]) => method === "POST" && String(path).includes("/run"))).toBe(false);
  });

  it("offers none of the three to a reader who cannot write, and no 改设定 either — and says what was decided all the same", async () => {
    const { container } = draw(readerOf());
    await trialDrawn();
    for (const name of ["选定方案", "改选方案", "加一个方案", "改假设", "改设定"]) {
      expect(screen.queryByRole("button", { name: new RegExp(`^${name}`) })).toBeNull();
    }
    expect(container.querySelector("[data-headline]")).toHaveTextContent("已选定方案 B，理由：成功把握与样本量的折中；方案 C 周期更长。");
  });
});

describe("试验 · the decision", () => {
  it("highlights only the design a recorded decision chose, says so in the sentence — the design's letter opens its run — and starts 改选方案 from that record", async () => {
    const { container } = draw();
    await trialDrawn();
    const ours = [...container.querySelectorAll("tr[data-row-ours]")].map((row) => row.getAttribute("data-vcr-design"));
    expect(ours).toEqual(["B"]);
    const sentence = container.querySelector("[data-headline]") as HTMLElement;
    expect(sentence).toHaveTextContent("已选定方案 B，理由：成功把握与样本量的折中；方案 C 周期更长。");
    await userEvent.click(within(sentence).getByRole("button", { name: "方案 B，看它是怎么算的" }));
    expect(await screen.findByRole("dialog", { name: /方案 B/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    // The decision form is behind the button, not a card under the table.
    expect(screen.queryByLabelText("比较目标")).toBeNull();
    await userEvent.click(within(band(container)).getByRole("button", { name: "改选方案" }));
    const drawer = await screen.findByRole("dialog", { name: "选定方案" });
    const goal = within(drawer).getByLabelText("比较目标");
    expect(goal).toHaveValue("在成功把握尽量高、样本量尽量少的目标下选哪个方案");
    expect(within(drawer).getByRole("radio", { name: "B" })).toBeChecked();
    expect(within(drawer).getByLabelText("选择理由")).toHaveValue("成功把握与样本量的折中；方案 C 周期更长。");
    // What the drawer used to say under its title is in the field it is about.
    expect(drawer.textContent).not.toContain("先写比较目标，再选一个，并说明理由。");
    expect(goal).toHaveAttribute("placeholder", expect.stringContaining("先写比较目标"));
    expect(drawer).not.toHaveTextContent(/不自动选定/);
    expect(within(drawer).getByText("上次记录于 今天 09:07")).toBeInTheDocument();
  });

  it("writes nothing until a goal is written and a design chosen, then posts the exact decision and re-reads", async () => {
    const raw = fixture("ev201/trial.json");
    raw.decision = null;
    for (const design of raw.designs) design.chosen = false;
    installVcrServer(network.productRequest, { [tab("trial")]: raw });
    const { container } = draw();
    await trialDrawn();
    await userEvent.click(within(band(container)).getByRole("button", { name: "选定方案" }));
    const drawer = await screen.findByRole("dialog", { name: "选定方案" });
    const save = within(drawer).getByRole("button", { name: "写入决策记录" });
    expect(save).toBeDisabled();
    // Nobody chose: every design is a grey.
    expect(container.querySelectorAll("tr[data-row-ours]")).toHaveLength(0);
    expect(within(drawer).getByRole("radio", { name: "D" })).toBeDisabled();

    await userEvent.click(within(drawer).getByRole("radio", { name: "B" }));
    expect(save).toBeDisabled();
    // Choosing in the form is not a recorded decision: still no brand.
    expect(container.querySelectorAll("tr[data-row-ours]")).toHaveLength(0);

    await userEvent.type(within(drawer).getByLabelText("比较目标"), "成功把握不低于 70%");
    expect(save).toBeEnabled();
    await userEvent.type(within(drawer).getByLabelText("选择理由"), "样本量更少");
    await userEvent.click(save);

    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/decisions`, "POST", {
      question: "成功把握不低于 70%",
      chosen: { id: "scn_2", code: "B", label: "方案 B 2:1 随机" },
      alternatives: [{ code: "A", label: "方案 A 单臂 + 文献对照" }, { code: "C", label: "方案 C 1:1 随机 + 一次期中分析" }],
      rationale: "样本量更少",
    }));
    expect(toasts.success).toHaveBeenCalledWith("已写入决策记录。");
    // The tab is read again, so the highlight comes back from the server, and the form is closed.
    await waitFor(() => expect(gets("trial")).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "选定方案" })).toBeNull());
  });

  it("sends one decision while the first is still being written", async () => {
    let release: (value: unknown) => void = () => {};
    installVcrServer(network.productRequest, {
      [`POST /vcr/studies/${STUDY_ID}/decisions`]: () => new Promise((resolve) => { release = resolve; }),
    });
    const { container } = draw();
    await trialDrawn();
    await userEvent.click(within(band(container)).getByRole("button", { name: "改选方案" }));
    const save = within(await screen.findByRole("dialog", { name: "选定方案" })).getByRole("button", { name: "写入决策记录" });
    await userEvent.click(save);
    await userEvent.click(save);
    expect(network.productRequest.mock.calls.filter(([path, method]) => String(path).endsWith("/decisions") && method === "POST")).toHaveLength(1);
    expect(save).toBeDisabled();
    release({});
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
  });
});

describe("试验 · the registry of predictions", () => {
  it("keeps the registry out of the page: 登记预测 opens it in a drawer, where each forecast shows its freezing time — no hash, no version — and, once there is one, the actual beside it", async () => {
    const { container, unmount } = draw();
    await trialDrawn();
    // Neither the list nor a form stands under the results: they are behind one button in the band.
    expect(container.querySelector("[data-vcr-forecast]")).toBeNull();
    expect(container.querySelector("[data-vcr-file-prediction]")).toBeNull();
    await userEvent.click(within(band(container)).getByRole("button", { name: "登记预测" }));
    const drawer = await screen.findByRole("dialog", { name: "登记预测" });
    const forecast = drawer.querySelector("[data-vcr-forecast='fct_1']") as HTMLElement;
    expect(forecast).toHaveTextContent("入组预测");
    expect(forecast.querySelector("[data-vcr-forecast-hash]")).toBeNull();
    expect(forecast.textContent).not.toMatch(/哈希|HASH|\bv\d+\b|fct_/);
    expect(forecast).toHaveTextContent("冻结于 今天 09:07");
    expect(forecast.querySelector("[data-vcr-forecast-line='last_patient_in_months']")).toHaveTextContent("14.2 个月");
    expect(within(forecast).queryByText("实际")).not.toBeInTheDocument();
    // Nobody here may file (only the lead may, and only where there is a registry): the drawer is the list and nothing else.
    expect(within(drawer).queryByRole("tab")).toBeNull();
    expect(within(drawer).queryByLabelText("试验登记号")).toBeNull();
    unmount();

    const raw = fixture("ev201/trial.json");
    raw.forecasts[0].lines[0].actual = "15.1 个月";
    raw.forecasts[0].comparedAt = "今天 12:00";
    installVcrServer(network.productRequest, { [tab("trial")]: raw });
    const again = draw();
    await trialDrawn();
    await userEvent.click(within(band(again.container)).getByRole("button", { name: "登记预测" }));
    const compared = (await screen.findByRole("dialog", { name: "登记预测" })).querySelector("[data-vcr-forecast='fct_1']") as HTMLElement;
    expect(within(compared).getByText("实际")).toBeInTheDocument();
    expect(compared.querySelector("[data-vcr-forecast-line='last_patient_in_months']")).toHaveTextContent("14.2 个月15.1 个月");
    expect(compared).toHaveTextContent("与实际对照于 今天 12:00");
  });

  it("gives the lead the registered list and the form as the drawer's two tabs, files from the engine's own result, and shows what was filed", async () => {
    const { container } = draw(leadOf());
    await trialDrawn();
    await userEvent.click(within(band(container)).getByRole("button", { name: "登记预测" }));
    const drawer = await screen.findByRole("dialog", { name: "登记预测" });
    // Registered first, because something is: the tab list says how many.
    expect(within(drawer).getByRole("tab", { name: /已登记/, selected: true })).toBeInTheDocument();
    expect(drawer.querySelector("[data-vcr-forecast='fct_1']")).toHaveTextContent("入组预测");
    await userEvent.click(within(drawer).getByRole("tab", { name: "新登记" }));
    const filing = drawer.querySelector("[data-vcr-file-prediction]") as HTMLElement;
    expect(within(filing).getByLabelText("方案")).toBeInTheDocument();
    expect(within(filing).getByLabelText("预测的指标")).toBeInTheDocument();
    // What the form used to say about itself is its shape: it has no field for the number.
    expect(filing.textContent).not.toContain("这里不输入数字");
    expect(within(filing).queryByLabelText(/数值|概率值/)).toBeNull();
    const file = within(filing).getByRole("button", { name: "登记预测" });
    expect(file).toBeDisabled();
    await userEvent.type(within(filing).getByLabelText("试验登记号"), "NCT02296125");
    await userEvent.type(within(filing).getByLabelText("主要终点"), "总生存期");
    await userEvent.click(file);
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/predictions`, "POST",
      expect.objectContaining({ registryId: "NCT02296125", endpoint: "总生存期", resultPath: expect.stringMatching(/^measure\(/) })));
    expect(toasts.success).toHaveBeenCalledWith("已登记预测。");
    // The trial is read again so the new forecast is in the list, and the drawer goes back to what has been registered.
    await waitFor(() => expect(gets("trial").length).toBeGreaterThan(1));
    await waitFor(() => expect(within(drawer).getByRole("tab", { name: /已登记/, selected: true })).toBeInTheDocument());
  });

  it("opens the lead's drawer on the form when nothing has been registered yet, and offers no button to a reader with nothing to see or file", async () => {
    const raw = fixture("ev201/trial.json");
    raw.forecasts = [];
    installVcrServer(network.productRequest, { [tab("trial")]: raw });
    const first = draw(leadOf());
    await trialDrawn();
    await userEvent.click(within(band(first.container)).getByRole("button", { name: "登记预测" }));
    const drawer = await screen.findByRole("dialog", { name: "登记预测" });
    expect(within(drawer).queryByRole("tab")).toBeNull();
    expect(within(drawer).getByLabelText("试验登记号")).toBeInTheDocument();
    first.unmount();

    // A reader who may not file, and nothing filed: no button at all — it would open an empty drawer.
    const reader = draw();
    await trialDrawn();
    expect(within(band(reader.container)).queryByRole("button", { name: "登记预测" })).toBeNull();
  });
});

describe("试验 · designs nothing has computed", () => {
  /** The conversation wrote the scenarios and the engine has not finished: designs with their configured size and cost, no measure of a result. */
  const written = (names: string[] = ["A", "B", "C", "D"]) => {
    const raw = fixture("ev201/trial.json");
    raw.designs = raw.designs.filter((design: any) => names.includes(design.code)).map((design: any) => ({
      ...design, dominated: false, dominatedBy: null, chosen: false,
      measures: Object.fromEntries(Object.entries(design.measures).filter(([key]) => key === "sample_size" || key === "cost")),
    }));
    raw.columns = raw.columns.filter((column: any) => column.key === "sample_size" || column.key === "cost");
    raw.headline = null; raw.decision = null; raw.footnotes = []; raw.grid = null; raw.powerCurve = null; raw.forecasts = []; raw.milestones = []; raw.ademp = []; raw.partial = null; raw.stale = null;
    return raw;
  };

  it("is a list with 「还没算」 on each design and the step's own state under it — no table, no metric column, and never 选定方案", async () => {
    installVcrServer(network.productRequest, { [tab("trial")]: written() });
    const { container } = draw(withStep("trial", { status: "none", requested: false }));
    const list = await found(container, "[data-vcr-not-computed]");
    expect(screen.queryByRole("table", { name: "方案的对比" })).toBeNull();
    const rows = [...list.querySelectorAll("[data-vcr-design]")];
    expect(rows.map((row) => row.getAttribute("data-vcr-design"))).toEqual(["A", "B", "C", "D"]);
    for (const row of rows) expect(row.closest("li")).toHaveTextContent("还没算");
    // The state is the recipe and its one button, not a form.
    expect(within(list).getByRole("button", { name: "模拟试验方案" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /选定方案|改选方案/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "登记预测" })).toBeNull();
    // What the conversation does stays: another design, another hypothesis.
    expect(screen.getByRole("button", { name: "加一个方案" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "改假设" })).toBeInTheDocument();
  });

  it("says the computation is under way while it is, and offers nothing to start", async () => {
    installVcrServer(network.productRequest, { [tab("trial")]: written() });
    const { container } = draw(withStep("trial", { status: "running" }));
    const list = await found(container, "[data-vcr-not-computed]");
    const running = list.querySelector("[data-vcr-step-running='trial']") as HTMLElement;
    expect(running).not.toBeNull();
    expect(within(running).queryByRole("button", { name: "模拟试验方案" })).toBeNull();
  });

  it("says a step that did not finish once, on top with 接着做 — and does not say it again under the list", async () => {
    installVcrServer(network.productRequest, { [tab("trial")]: written() });
    const { container } = draw(withStep("trial", { status: "failed", note: "计算时间用完了" }));
    const list = await found(container, "[data-vcr-not-computed]");
    expect(container.querySelectorAll("[data-vcr-step-failed]")).toHaveLength(1);
    expect(list.querySelector("[data-vcr-step-failed]")).toBeNull();
    expect(screen.getAllByRole("button", { name: "接着做" })).toHaveLength(1);
  });

  it("offers a reader who cannot write no band when there is nothing to conclude", async () => {
    installVcrServer(network.productRequest, { [tab("trial")]: written() });
    const raw = fixture("ev201/study.json");
    raw.abilities = ["read"];
    raw.steps.trial = { status: "none", requested: false };
    const { container } = draw(readVcrStudy(raw));
    await found(container, "[data-vcr-not-computed]");
    expect(container.querySelector("[data-page-chrome]")).toBeNull();
  });

  it("keeps the table when some designs ran: the unrun rows say 「还没算」 where the numbers would be, and cannot be chosen", async () => {
    const raw = fixture("ev201/trial.json");
    // Design C has been written and not computed.
    raw.designs[2].measures = Object.fromEntries(Object.entries(raw.designs[2].measures).filter(([key]) => key === "sample_size" || key === "cost"));
    installVcrServer(network.productRequest, { [tab("trial")]: raw });
    const { container } = draw();
    await trialDrawn();
    expect(container.querySelector("[data-vcr-not-computed]")).toBeNull();
    const c = container.querySelector("tr[data-vcr-design='C']") as HTMLElement;
    expect(c.querySelector("[data-vcr-measure='power']")).toBeNull();
    expect(c.querySelectorAll("[data-vcr-not-run]").length).toBeGreaterThan(0);
    expect(c).toHaveTextContent("还没算");
    // A design that ran with no value in one column is 「—」, not 「还没算」.
    expect(container.querySelector("tr[data-vcr-design='A']")).not.toHaveTextContent("还没算");
    await userEvent.click(within(band(container)).getByRole("button", { name: /选定方案|改选方案/ }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByRole("radio", { name: "C" })).toBeDisabled();
    expect(within(drawer).getByRole("radio", { name: "A" })).toBeEnabled();
  });
});

describe("试验 · the three kinds of record", () => {
  const schedule = () => ({
    protocolVersion: 2,
    visits: [{ visit: "筛选期", day: -14, windowDays: 7, note: "", procedures: [{ name: "知情同意", note: "" }, { name: "血常规", note: "" }] }],
    totals: { visits: 1, activities: 2, entries: 2, firstDay: -14, lastDay: -14 },
  });

  it("has no switch while the step holds only designs and the reader cannot add the others", async () => {
    const { container } = draw(readerOf());
    await trialDrawn();
    expect(within(band(container)).queryByRole("button", { name: "监管" })).toBeNull();
    expect(within(band(container)).queryByRole("button", { name: "访视" })).toBeNull();
  });

  it("is a switch in the band — 方案 · 访视 · 监管 — and shows one kind at a time", async () => {
    const raw = fixture("ev201/trial.json");
    raw.regulatory = [{ id: "rc_1", date: "2026-09-01", agency: "CDE", type: "沟通交流会", summary: "讨论单臂设计", outcome: "同意以外部对照支持", attachments: [] }];
    installVcrServer(network.productRequest, { [tab("trial")]: raw });
    const { container } = draw();
    await trialDrawn();
    const chips = within(band(container));
    expect(chips.getByRole("button", { name: /^方案/ })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(chips.getByRole("button", { name: /^监管/ }));
    const log = await screen.findByRole("table", { name: "监管沟通" });
    expect(log).toHaveTextContent("CDE");
    expect(log).toHaveTextContent("同意以外部对照支持");
    expect(screen.queryByRole("table", { name: "方案的对比" })).toBeNull();
    // The buttons of the designs give way to the one of the log.
    expect(chips.queryByRole("button", { name: "改选方案" })).toBeNull();
    expect(chips.getByRole("button", { name: "添加监管沟通" })).toBeInTheDocument();
    await userEvent.click(chips.getByRole("button", { name: /^方案/ }));
    expect(await trialDrawn()).toBeInTheDocument();
  });

  it("records the first contact from the empty log, for a reader who may write", async () => {
    const { container } = draw();
    await trialDrawn();
    await userEvent.click(within(band(container)).getByRole("button", { name: /^监管/ }));
    expect(await screen.findByText("还没有监管沟通记录")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "记录监管沟通" }));
    const drawer = await screen.findByRole("dialog", { name: "添加监管沟通记录" });
    expect(within(drawer).getByLabelText("机构")).toBeInTheDocument();
  });

  it("shows the visit schedule when the protocol has one", async () => {
    const raw = fixture("ev201/trial.json");
    raw.schedule = schedule();
    installVcrServer(network.productRequest, { [tab("trial")]: raw });
    const { container } = draw();
    await trialDrawn();
    await userEvent.click(within(band(container)).getByRole("button", { name: /^访视/ }));
    expect(await screen.findByRole("table", { name: "访视日程" })).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "方案的对比" })).toBeNull();
  });
});

describe("试验 · before there are designs", () => {
  it("says the first sentence is missing on a study nobody has described, with no decision form", async () => {
    installVcrServer(network.productRequest, nothingIn("trial"));
    renderTab(<TrialTab studyId={EMPTY_STUDY_ID} study={emptyStudy()} />, { studyId: EMPTY_STUDY_ID });
    expect(await screen.findByText(VCR_NO_DEFINITION)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "选定方案" })).not.toBeInTheDocument();
  });

  it("says where a step that was asked for waits", async () => {
    installVcrServer(network.productRequest, nothingIn("trial"));
    const { container } = draw(withStep("trial", { status: "none", requested: true }));
    await found(container, "[data-vcr-step-waiting='trial']");
    expect(container.querySelector("[data-page-chrome]")).toBeNull();
  });
});
