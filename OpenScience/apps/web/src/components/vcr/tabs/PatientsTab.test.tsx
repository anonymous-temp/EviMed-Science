import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readVcrStudy, type VcrStudy } from "@/lib/vcrClient";
import { PatientsTab } from "./PatientsTab";
import { renderTab } from "../__fixtures__/tabFrame";
import { fixture, installVcrServer, STUDY_ID } from "../__fixtures__/serverFixtures";

/**
 * 虚拟患者, the owner's page (R19; audit B §4.5): a list of people with their record, not one example patient and a pile of cards.
 *
 * Rendered under a frame, so the band's one row of controls is where a reader finds it. Every payload is a fixture of the server's
 * (`vcr-views/ev201`), read through the real client; only the network is doubled, and the rows route here answers the way
 * `vcrRows.mjs` does — it pages, sorts and filters — so what the table asks for is what the server would be asked.
 */

const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));
const web = vi.hoisted(() => ({ fetchWithWebAuth: vi.fn() }));
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  fetchWithWebAuth: web.fetchWithWebAuth,
}));

const ev201 = (): VcrStudy => readVcrStudy(fixture("ev201/study.json"));
/** The EV-201 study with one step set to a state: it has a definition, so an empty tab is the step's own state and not 「还没有说话」. */
const withStep = (step: string, fields: Record<string, unknown>): VcrStudy => {
  const raw = fixture("ev201/study.json");
  raw.steps[step] = { ...raw.steps[step], ...fields };
  return readVcrStudy(raw);
};
const withAbilities = (abilities: string[]): VcrStudy => { const raw = fixture("ev201/study.json"); raw.abilities = abilities; return readVcrStudy(raw); };
const tab = (name: string) => `GET /vcr/studies/${STUDY_ID}/${name}`;
const seen = () => network.productRequest.mock.calls.map(([path]) => String(path));
const rowCalls = () => seen().filter((path) => path.includes("/patients/rows"));

/** The address the page is at, for a test to read what a press did to it. */
function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.search}</output>;
}

/** The rows route as the server answers it: a window of a table of sixty people, narrowed by the arm and a range, ordered by a column. */
function rowsRoute(all = 60) {
  return ({ query }: { query: URLSearchParams }) => {
    const base = fixture("ev201/patients-rows.json");
    const offset = Number(query.get("offset") ?? 0);
    const limit = Number(query.get("limit") ?? 25);
    let people = Array.from({ length: all }, (_, index) => ({
      patientId: `vp_${String(index + 1).padStart(3, "0")}`, age: 40 + index, ecog: index % 2, arm: index % 2, time: 20 - (index % 7), status: index % 3 === 0 ? 0 : 1, entry: 0,
    })) as Array<Record<string, number | string>>;
    const arm = query.get("arm");
    if (arm) people = people.filter((person) => String(person.arm) === arm);
    const range = query.get("filter[age]");
    if (range) {
      const [low, high] = range.split("..");
      people = people.filter((person) => (low === "" || Number(person.age) >= Number(low)) && (high === undefined || high === "" || Number(person.age) <= Number(high)));
    }
    const sort = query.get("sort");
    if (sort) {
      const key = sort.replace(/^-/, "");
      const direction = sort.startsWith("-") ? -1 : 1;
      people = [...people].sort((a, b) => (Number(a[key]) - Number(b[key])) * direction);
    }
    return { ...base, rows: people.slice(offset, offset + limit), total: people.length, all, offset, limit, sort: sort ? { column: sort.replace(/^-/, ""), descending: sort.startsWith("-") } : null };
  };
}

beforeEach(() => {
  toasts.success.mockReset();
  toasts.error.mockReset();
  web.fetchWithWebAuth.mockReset();
  installVcrServer(network.productRequest);
});

const draw = (study: VcrStudy = ev201(), route = "/") => renderTab(<><PatientsTab studyId={STUDY_ID} study={study} /><Where /></>, { route });
const band = (container: HTMLElement) => container.querySelector("[data-page-chrome]") as HTMLElement;

describe("虚拟患者 · the list of people", () => {
  it("puts what a reader controls above what it controls: the band, the sentence, the charts, the people, the calibration, the assumptions", async () => {
    const { container } = draw();
    await screen.findByRole("table", { name: "患者" });
    const at = (selector: string) => container.querySelector(selector) as HTMLElement;
    const order = [
      band(container), at("[data-headline]"), at("[data-chart-grid]"), screen.getByRole("table", { name: "患者" }),
      at("[data-vcr-calibration]"), screen.getByText("哪些假设影响最大 · 试验情景 12 个月 PFS 概率"),
    ];
    order.forEach((node, index) => {
      expect(node, `item ${index}`).not.toBeNull();
      if (index > 0) expect(order[index - 1].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING, `item ${index} follows item ${index - 1}`).toBeTruthy();
    });
  });

  it("says how many people there are, in which arms, how many had the event and where the first calibration stands", async () => {
    const { container } = draw();
    await screen.findByRole("table", { name: "患者" });
    const sentence = container.querySelector("[data-headline]") as HTMLElement;
    expect(sentence).toHaveTextContent("2,000 名虚拟患者 · 试验 1,000 · 对照 1,000 · 事件 1,687 · 对照组中位时间 3.9 个月（设定 4.1 ✓）");
  });

  it("opens what a number counts: an arm's count narrows the table to that arm, the total lets go", async () => {
    installVcrServer(network.productRequest, { [tab("patients/rows")]: rowsRoute() });
    const { container } = draw();
    await screen.findByRole("table", { name: "患者" });
    const sentence = container.querySelector("[data-headline]") as HTMLElement;
    await userEvent.click(within(sentence).getByRole("button", { name: /对照 1,000 名，只看这些/ }));
    await waitFor(() => expect(rowCalls().some((path) => path.includes("arm=0"))).toBe(true));
    // The toolbar says the same selection, and a chip lets go of it.
    expect(within(band(container)).getByRole("button", { name: "清除筛选" })).toBeInTheDocument();
    await userEvent.click(within(sentence).getByRole("button", { name: /看全部/ }));
    await waitFor(() => expect(within(band(container)).queryByRole("button", { name: "清除筛选" })).toBeNull());
  });

  it("filters by arm and by a band of a variable's own distribution — in the band, against the server", async () => {
    installVcrServer(network.productRequest, { [tab("patients/rows")]: rowsRoute() });
    const { container } = draw();
    const table = await screen.findByRole("table", { name: "患者" });
    expect(within(table).getAllByRole("row")).toHaveLength(26);
    const chips = band(container);
    await userEvent.click(within(chips).getByRole("button", { name: /^试验/ }));
    await waitFor(() => expect(rowCalls().some((path) => path.includes("arm=1"))).toBe(true));
    await waitFor(() => expect(within(screen.getByRole("table", { name: "患者" })).getAllByRole("row")).toHaveLength(26));
    expect(screen.getByRole("heading", { name: "患者" }).parentElement).toHaveTextContent("30 / 60");
    // age is continuous: its lower quarter is `..q1`, the table's own quartile — not a number typed against a column nobody has seen.
    await userEvent.click(within(chips).getByRole("button", { name: "age" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: /^≤ 57\.3/ }));
    await waitFor(() => expect(rowCalls().some((path) => decodeURIComponent(path).includes("filter[age]=..57.3"))).toBe(true));
  });

  it("sorts by a column — ascending, descending, then as it came — and a narrowing starts again from the first page", async () => {
    installVcrServer(network.productRequest, { [tab("patients/rows")]: rowsRoute() });
    draw();
    const table = await screen.findByRole("table", { name: "患者" });
    await userEvent.click(within(table).getByRole("button", { name: /按age排序$/ }));
    await waitFor(() => expect(rowCalls().some((path) => path.includes("sort=age"))).toBe(true));
    await userEvent.click(await screen.findByRole("button", { name: "按age排序，当前从小到大" }));
    await waitFor(() => expect(rowCalls().some((path) => path.includes("sort=-age"))).toBe(true));
    await userEvent.click(await screen.findByRole("button", { name: "按age排序，当前从大到小" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /按age排序$/ })).toBeInTheDocument());
  });

  it("pages the table by the server: next and previous, and the position it shows is the window it holds", async () => {
    installVcrServer(network.productRequest, { [tab("patients/rows")]: rowsRoute() });
    const { container } = draw();
    await screen.findByRole("table", { name: "患者" });
    const pager = container.querySelector("[data-vcr-pager]") as HTMLElement;
    expect(pager).toHaveTextContent("1–25");
    expect(within(pager).getByRole("button", { name: "上一页" })).toBeDisabled();
    await userEvent.click(within(pager).getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(rowCalls().some((path) => path.includes("offset=25"))).toBe(true));
    await waitFor(() => expect(container.querySelector("[data-vcr-pager]")).toHaveTextContent("26–50"));
    await userEvent.click(within(container.querySelector("[data-vcr-pager]") as HTMLElement).getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(container.querySelector("[data-vcr-pager]")).toHaveTextContent("51–60"));
    expect(within(container.querySelector("[data-vcr-pager]") as HTMLElement).getByRole("button", { name: "下一页" })).toBeDisabled();
  });

  it("says why a table too long to sort is not sorted, in the server's words, and offers the way back — no partial order", async () => {
    const { WebApiError } = await import("@/lib/apiClient");
    const route = rowsRoute();
    installVcrServer(network.productRequest, {
      [tab("patients/rows")]: (request: { query: URLSearchParams }) => {
        if (request.query.get("sort")) throw new WebApiError("too long", { status: 422, code: "vcr_rows_too_large" });
        return route(request);
      },
    });
    draw();
    const table = await screen.findByRole("table", { name: "患者" });
    await userEvent.click(within(table).getByRole("button", { name: /按age排序$/ }));
    expect(await screen.findByText(/这张表太长，不能整表排序/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "取消排序" }));
    expect(await screen.findByRole("table", { name: "患者" })).toBeInTheDocument();
  });

  it("opens a patient's record in a drawer from the row, and the address says whose: ?patient=", async () => {
    installVcrServer(network.productRequest, { [tab("patients/rows")]: rowsRoute() });
    draw();
    const table = await screen.findByRole("table", { name: "患者" });
    const row = table.querySelector("[data-vcr-patient-row='vp_003']") as HTMLElement;
    await userEvent.click(row);
    expect(screen.getByTestId("where")).toHaveTextContent("?patient=vp_003");
    const drawer = await screen.findByRole("dialog", { name: "虚拟患者 vp_003" });
    expect(await within(drawer).findByText("基线")).toBeInTheDocument();
    // The keyboard's way in is the id in the first cell, and closing lets go of the address.
    await userEvent.click(within(drawer).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("where")).toHaveTextContent("");
    await userEvent.click(within(table).getByRole("button", { name: "打开 vp_004 的记录" }));
    expect(screen.getByTestId("where")).toHaveTextContent("?patient=vp_004");
  });

  it("opens the record the address names — a link to one patient — with baseline, outcome and where they stand in their arm", async () => {
    draw(ev201(), "/?patient=vp_86b1ffc01a46");
    const drawer = await screen.findByRole("dialog", { name: "虚拟患者 vp_86b1ffc01a46" });
    expect(await within(drawer).findByText("试验")).toBeInTheDocument();
    expect(within(drawer).getByText("基线")).toBeInTheDocument();
    expect(within(drawer).getByText("结局")).toBeInTheDocument();
    expect(within(drawer).getByText("发生事件")).toBeInTheDocument();
    // The position is the table's own figures worded: the month, who was still followed, the arm's median.
    const position = within(drawer).getByText("在本组中的位置").closest("section") as HTMLElement;
    expect(position).toHaveTextContent("第 5.83 个月发生事件");
    expect(position).toHaveTextContent("本组 1,000 人中还有 552 人未发生事件");
    expect(position).toHaveTextContent("本组中位时间 6.85 个月");
    expect(within(drawer).queryByText("两种假设下")).toBeNull();
  });

  it("says a censored patient was still followed — and draws both assumptions only when the table holds an outcome for each", async () => {
    const { unmount } = draw(ev201(), "/?patient=vp_6408f547ca06");
    const drawer = await screen.findByRole("dialog", { name: "虚拟患者 vp_6408f547ca06" });
    await within(drawer).findByText("删失");
    expect(drawer).toHaveTextContent("随访到第 14 个月仍未发生事件");
    unmount();

    const record = fixture("ev201/patients-record.json");
    record.trajectories = [{ arm: "0", label: "对照", values: { y: 2.5 } }, { arm: "1", label: "试验", values: { y: 3.1 } }];
    installVcrServer(network.productRequest, { [tab("patients/vp_86b1ffc01a46")]: record });
    draw(ev201(), "/?patient=vp_86b1ffc01a46");
    const both = await screen.findByRole("dialog", { name: "虚拟患者 vp_86b1ffc01a46" });
    const trajectories = (await within(both).findByText("两种假设下")).closest("section") as HTMLElement;
    expect(trajectories).toHaveTextContent("对照");
    expect(trajectories).toHaveTextContent("2.5");
    expect(trajectories).toHaveTextContent("3.1");
    // No sentence about two outcomes of one person: the section's name says it.
    expect(both.textContent).not.toMatch(/不可能同时被观测|不是观察记录/);
  });

  it("says a record it cannot read, in the drawer, and keeps the list", async () => {
    const { WebApiError } = await import("@/lib/apiClient");
    installVcrServer(network.productRequest, {
      [tab("patients/vp_gone")]: () => { throw new WebApiError("gone", { status: 404, code: "vcr_patient_not_found" }); },
    });
    draw(ev201(), "/?patient=vp_gone");
    const drawer = await screen.findByRole("dialog", { name: "虚拟患者 vp_gone" });
    expect(await within(drawer).findByText(/这一批记录里没有这位虚拟患者/)).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "患者" })).toBeInTheDocument();
  });
});

describe("虚拟患者 · what the people are measured against", () => {
  it("lays the setting, the generated value and the evidence's interval side by side, and marks one outside as a mark — not a verdict", async () => {
    const raw = fixture("ev201/patients.json");
    raw.calibration.rows[0] = { ...raw.calibration.rows[0], generated: 6.4, difference: 2.3, status: "outside" };
    installVcrServer(network.productRequest, { [tab("patients")]: raw });
    const { container } = draw();
    const strip = await waitFor(() => {
      const node = container.querySelector("[data-vcr-calibration]");
      if (!node) throw new Error("no strip");
      return node as HTMLElement;
    });
    expect(within(strip).getByText("1 项生成值偏出证据区间")).toBeInTheDocument();
    const first = strip.querySelector("[data-vcr-calibration-row='control_median']") as HTMLElement;
    expect(first).toHaveAttribute("data-vcr-calibration-status", "outside");
    expect(within(first).getByRole("img", { name: "生成值在证据区间之外" })).toBeInTheDocument();
    expect(first).toHaveTextContent("4.1 个月");
    expect(first).toHaveTextContent("6.4 个月");
    expect(first).toHaveTextContent("3–5.6");
    // A row without an interval carries no mark: 「在区间内」 is a claim only an interval can make.
    const hazard = strip.querySelector("[data-vcr-calibration-row='hazard_ratio']") as HTMLElement;
    expect(hazard).toHaveAttribute("data-vcr-calibration-status", "unknown");
    expect(within(hazard).queryByRole("img")).toBeNull();
    // The sentence's own number takes the reader to the strip.
    const sentence = container.querySelector("[data-headline]") as HTMLElement;
    expect(sentence).toHaveTextContent("（设定 4.1 ⚠）");
  });

  it("draws each variable against what the study declared, and says how many records broke a limit — the engine's count", async () => {
    const raw = fixture("ev201/patients.json");
    raw.profile[0] = { ...raw.profile[0], declared: { family: "normal", params: { mean: 62, sd: 9 }, constraints: [{ kind: "bounds", min: 18, max: 90 }] }, declaredText: "正态分布，均数 62、标准差 9；限定在 18–90", violations: 12 };
    installVcrServer(network.productRequest, { [tab("patients")]: raw });
    const { container } = draw();
    const age = await waitFor(() => {
      const node = container.querySelector("[data-vcr-distribution='age']");
      if (!node) throw new Error("no distribution");
      return node as HTMLElement;
    });
    expect(age).toHaveTextContent("设定 正态分布，均数 62、标准差 9；限定在 18–90");
    expect(age.querySelector("[data-vcr-limit='broken']")).toHaveTextContent("违反 12 条");
    expect(age.querySelector("[data-vcr-expected]")).not.toBeNull();
    expect(screen.getByText("1 个变量有记录越出设定的限定")).toBeInTheDocument();
    // A variable that declared nothing neither passes nor fails.
    expect(container.querySelector("[data-vcr-distribution='ecog'] [data-vcr-limit]")).toBeNull();
  });

  it("names the model in the band and opens its record — the card and the ICH M15 assessment — in a drawer, not under the charts", async () => {
    const { container } = draw();
    await screen.findByRole("table", { name: "患者" });
    expect(screen.queryByText("模型评估")).toBeNull();
    expect(document.body.textContent).not.toContain("数字孪生");
    await userEvent.click(within(band(container)).getByRole("button", { name: /模型：/ }));
    const drawer = await screen.findByRole("dialog", { name: "二线 NSCLC 多西他赛组 PFS · Weibull" });
    expect(within(drawer).getByText("可信度层级 · 文献模型")).toBeInTheDocument();
    expect(drawer.querySelector("[data-vcr-twin]")).toHaveTextContent("基线条件化预测");
    expect(within(drawer).getByText("研究设计支持", { exact: false })).toBeInTheDocument();
  });

  it("keeps the tornado last and folded", async () => {
    draw();
    const folded = (await screen.findByText(/哪些假设影响最大/)).closest("details") as HTMLElement;
    expect(folded).not.toHaveAttribute("open");
  });

  it("shows the engine's example patient as a person — age and ECOG — and leaves its identifier to the record", async () => {
    draw();
    expect(await screen.findByText("示例患者 · 年龄 62 岁 · ECOG 1")).toBeInTheDocument();
    expect(screen.queryByText("VP-0412")).toBeNull();
  });
});

describe("虚拟患者 · what the band offers", () => {
  it("offers 下载 CSV, 重新生成 and 改设定 to a reader who may, in the band's one row", async () => {
    const { container } = draw();
    await screen.findByRole("table", { name: "患者" });
    const chips = within(band(container));
    expect(chips.getByRole("button", { name: "下载 CSV" })).toBeInTheDocument();
    expect(chips.getByRole("button", { name: "重新生成" })).toBeInTheDocument();
    expect(chips.getByRole("button", { name: "改设定" })).toBeInTheDocument();
    expect(container.querySelectorAll("[data-page-chrome]")).toHaveLength(1);
  });

  it("offers a reader who cannot run or write the download and nothing that would be refused", async () => {
    const { container } = draw(withAbilities(["read"]));
    await screen.findByRole("table", { name: "患者" });
    const chips = within(band(container));
    expect(chips.getByRole("button", { name: "下载 CSV" })).toBeInTheDocument();
    expect(chips.queryByRole("button", { name: "重新生成" })).toBeNull();
    expect(chips.queryByRole("button", { name: "改设定" })).toBeNull();
  });

  it("downloads the table through the records route, under the file's own name; a refusal is a toast", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    URL.createObjectURL = vi.fn(() => "blob:records");
    URL.revokeObjectURL = vi.fn();
    web.fetchWithWebAuth.mockResolvedValue(new Response("a,b\n1,2\n", { status: 200, headers: { "content-disposition": 'attachment; filename="virtual-patients.csv"' } }));
    const { container } = draw();
    await screen.findByRole("table", { name: "患者" });
    await userEvent.click(within(band(container)).getByRole("button", { name: "下载 CSV" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(String(web.fetchWithWebAuth.mock.calls[0][0])).toMatch(/\/vcr\/studies\/std_1\/records\/res_10\.csv$/);
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe("virtual-patients.csv");

    click.mockClear();
    web.fetchWithWebAuth.mockResolvedValue(new Response(JSON.stringify({ error: "x", code: "vcr_records_not_synthetic" }), { status: 403, headers: { "content-type": "application/json" } }));
    await userEvent.click(within(band(container)).getByRole("button", { name: "下载 CSV" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(click).not.toHaveBeenCalled();
    click.mockRestore();
  });

  it("generates again with one request and stays on the page: no navigation, no toast that promises a result", async () => {
    const { container, spies } = draw();
    await screen.findByRole("table", { name: "患者" });
    await userEvent.click(within(band(container)).getByRole("button", { name: "重新生成" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith(`/vcr/studies/${STUDY_ID}/run`, "POST", { step: "patients" }));
    expect(network.productRequest.mock.calls.filter(([path, method]) => String(path).endsWith("/run") && method === "POST")).toHaveLength(1);
    await waitFor(() => expect(spies.refresh).toHaveBeenCalled());
    expect(toasts.success).not.toHaveBeenCalled();
    expect(screen.getByTestId("where")).toHaveTextContent("");
  });

  it("opens the settings that made the people, as the population's own numbers", async () => {
    installVcrServer(network.productRequest, {
      [`GET /vcr/studies/${STUDY_ID}/cards?kind=population`]: { kind: "population", objectId: "pop_1", title: "人群设定", settings: [{ path: "n", label: "生成记录数", value: 1000, unit: "条", integer: true, min: 1, max: null }] },
    });
    const { container } = draw();
    await screen.findByRole("table", { name: "患者" });
    await userEvent.click(within(band(container)).getByRole("button", { name: "改设定" }));
    const drawer = await screen.findByRole("dialog", { name: "改人群设定" });
    expect(await within(drawer).findByLabelText("生成记录数（条）")).toHaveValue(1000);
  });
});

describe("虚拟患者 · a study with no people yet", () => {
  it("is the step's recipe and its one button — no band row, no panel, no assessment, no example card", async () => {
    installVcrServer(network.productRequest, { [tab("patients")]: fixture("empty/patients.json") });
    const { container } = draw(withStep("patients", { status: "none", requested: false }));
    const recipe = await waitFor(() => {
      const node = container.querySelector("[data-vcr-step-empty='patients']");
      if (!node) throw new Error("no recipe");
      return node as HTMLElement;
    });
    expect(within(recipe).getByRole("button", { name: "生成虚拟患者" })).toBeInTheDocument();
    expect(container.querySelector("[data-page-chrome]")).toBeNull();
    expect(screen.queryByText("预测与验证")).toBeNull();
    expect(screen.queryByText("模型评估")).toBeNull();
    expect(container.querySelector("[data-vcr-example]")).toBeNull();
    expect(screen.queryByRole("button", { name: /导入预测文件|导入试验预测/ })).toBeNull();
  });

  it("says what is going on while the step runs — and still draws nothing of another feature beside it", async () => {
    installVcrServer(network.productRequest, { [tab("patients")]: fixture("empty/patients.json") });
    const { container } = draw(withStep("patients", { status: "running" }));
    const running = await waitFor(() => {
      const node = container.querySelector("[data-vcr-step-running='patients']");
      if (!node) throw new Error("no strip");
      return node as HTMLElement;
    });
    expect(running).toHaveTextContent("生成虚拟患者");
    expect(container.querySelector("[data-page-chrome]")).toBeNull();
    expect(screen.queryByText("预测与验证")).toBeNull();
    expect(screen.queryByRole("button", { name: /导入/ })).toBeNull();
  });
});

describe("虚拟患者 · the second view, 预测验证", () => {
  const history = { id: "history-1", kind: "history", createdAt: "2026-01-01", hash: "h", summary: { origin: "2026-01-01", subjects: 40, events: 80 } };
  const longitudinal = (records: unknown[]) => ({ available: true, records, providers: [], templates: { events: { columns: ["subject_id"], example: ["synthetic"] }, prediction: { schema: 1 } } });

  it("exists only when there is follow-up history or a prediction: with none the band has no switch and the tab no panel", async () => {
    installVcrServer(network.productRequest, { [tab("longitudinal")]: longitudinal([]) });
    const { container } = draw();
    await screen.findByRole("table", { name: "患者" });
    expect(within(band(container)).queryByRole("button", { name: "预测验证" })).toBeNull();
    expect(screen.queryByLabelText("输入历史")).toBeNull();
  });

  it("is left alone, with no error line, when the records cannot be read", async () => {
    // The longitudinal route is not in the fixture server: it answers with a failure, and the patients view is unaffected.
    const { container } = draw();
    await screen.findByRole("table", { name: "患者" });
    expect(within(band(container)).queryByRole("button", { name: "预测验证" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("is a switch in the band, beside the other view, and swaps the body — the band keeps its one row", async () => {
    installVcrServer(network.productRequest, { [tab("longitudinal")]: longitudinal([history]) });
    const { container } = draw();
    await screen.findByRole("table", { name: "患者" });
    const chips = within(band(container));
    expect(await chips.findByRole("button", { name: "预测验证" })).toHaveAttribute("aria-pressed", "false");
    expect(chips.getByRole("button", { name: "虚拟患者" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(chips.getByRole("button", { name: "预测验证" }));
    expect(await screen.findByLabelText("输入历史")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "患者" })).toBeNull();
    expect(container.querySelectorAll("[data-page-chrome]")).toHaveLength(1);
    // The templates and imports are behind the band's ⋯ here, and the switch is still beside it.
    expect(within(band(container)).getByRole("button", { name: "模板与导入" })).toBeInTheDocument();
    await userEvent.click(within(band(container)).getByRole("button", { name: "虚拟患者" }));
    expect(await screen.findByRole("table", { name: "患者" })).toBeInTheDocument();
  });
});
