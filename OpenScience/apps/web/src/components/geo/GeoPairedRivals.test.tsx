import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { GeoFrameHarness } from "./__fixtures__/geoFrameHarness";
import { geoProject } from "./__fixtures__/geoTabs";
import { GeoPairedRivals } from "./GeoPairedRivals";

const read = vi.hoisted(() => vi.fn());
vi.mock("@/lib/geoAnalysisClient", () => ({ getGeoAnalysis: read }));

const row = (name: string, pool: string, ours: number, rival: number, n = 50, unknown = 0) => ({
  key: `${name}-${pool}`, label: `${name} · ${pool}`, metricId: "M-16",
  dimensions: { entityName: name, entityLabel: name, entityKind: "brand", own: false, period: "selected", pool },
  values: {
    current: { value: rival, state: "known", metric: { denominator: n } },
    pairedOwn: { value: ours, state: "known", metric: { denominator: n } },
    unknown: { value: unknown, state: "known" },
  },
});

function result(rows: ReturnType<typeof row>[], nextOffset: number | null = null) {
  return { rows: rows.map(item => ({ ...item, values: { ...item.values,
    current: { ...item.values.current, members: { exact: true, selectionRef: "gsel_frozen", expectedDigest: "digest-1", rowKey: item.key, columnKey: "current", unit: "answers", total: item.values.current.metric.denominator } },
    pairedOwn: { ...item.values.pairedOwn, members: { exact: true, selectionRef: "gsel_frozen", expectedDigest: "digest-1", rowKey: item.key, columnKey: "pairedOwn", unit: "answers", total: item.values.pairedOwn.metric.denominator } },
  } })), selection: { reference: "gsel_frozen" }, digest: "digest-1", page: { nextOffset } };
}

function renderCard() {
  return render(<MemoryRouter initialEntries={["/app/geo/geo_1/visibility?from=2026-10-01&to=2026-10-31&session=s1"]}>
    <GeoFrameHarness project={geoProject()} tab="visibility" scope={{ from: "2026-10-01", to: "2026-10-31" }}>
      <GeoPairedRivals geoId="geo_1" />
    </GeoFrameHarness>
  </MemoryRouter>);
}

beforeEach(() => { read.mockReset(); });

it("shows each registered rival only beside its own paired cohort and carries the scope into the full analysis", async () => {
  read.mockResolvedValue(result([row("竞品甲", "P2", 20, 40, 50, 7), row("竞品乙", "P3", 60, 30, 40), row("竞品丙", "P2", 40, 20)], 20));
  renderCard();
  const card = await screen.findByRole("region", { name: "本品与竞品提及率" });
  expect(within(card).getByText("竞品甲 · 品类问题")).toBeVisible();
  expect(within(card).getByText("本品 20% · 竞品 40%")).toBeVisible();
  expect(within(card).getByText("50 条合资格回答 · 7 条历史依据未知")).toBeVisible();
  expect(card).toHaveTextContent("每组使用该竞品各自的合资格回答，不跨组排名");
  const link = within(card).getByRole("link", { name: "查看全部竞品分析" });
  expect(link.getAttribute("href")).toContain("analysis=V08");
  expect(link.getAttribute("href")).toContain("selectionRef=gsel_frozen");
  expect(link.getAttribute("href")).toContain("session=s1");
  expect(read).toHaveBeenCalledWith("geo_1", { from: "2026-10-01", to: "2026-10-31" }, { viewId: "V08", metricId: "M-16", dimension: "project" });
});

it("does not invent a comparison from insufficient, unknown, unpaired or generic observations", async () => {
  const insufficient = row("样本少", "P2", 10, 20, 10); insufficient.values.current.state = "insufficient";
  const mismatched = row("分母不同", "P2", 10, 20, 50); mismatched.values.pairedOwn.metric.denominator = 40;
  const generic = row("通用名", "P2", 10, 20, 50); generic.dimensions.entityKind = "generic";
  read.mockResolvedValue(result([insufficient, mismatched, generic]));
  renderCard();
  const card = await screen.findByRole("region", { name: "本品与竞品提及率" });
  expect(card).toHaveTextContent("当前范围暂无可比的竞品读数");
  expect(card).not.toHaveTextContent("样本少 · 品类问题");
  expect(card).not.toHaveTextContent("分母不同 · 品类问题");
  expect(card).not.toHaveTextContent("通用名 · 品类问题");
});

it("reports a failed comparison read and retries without changing the selection", async () => {
  read.mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce(result([row("竞品甲", "P2", 20, 40)]));
  renderCard();
  expect(await screen.findByRole("alert")).toHaveTextContent("竞品比较暂时无法读取");
  await userEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByText("本品 20% · 竞品 40%")).toBeVisible();
});

it("pages the frozen selection before claiming no pair and retains a rival's historical name", async () => {
  const own = { ...row("本品", "P1", 20, 30), dimensions: { ...row("本品", "P1", 20, 30).dimensions, own: true } };
  const renamed = row("现名", "P3", 20, 40);
  Object.assign(renamed.dimensions, { entityLabel: "当前登记：现名（历史登记：旧名）" });
  read.mockResolvedValueOnce(result(Array.from({ length: 20 }, () => own), 20))
    .mockResolvedValueOnce(result([renamed, { ...own, dimensions: { ...own.dimensions, period: "day" } }]));
  renderCard();
  expect(await screen.findByText("当前登记：现名（历史登记：旧名） · 泛症状问题")).toBeVisible();
  expect(read).toHaveBeenLastCalledWith("geo_1", { selectionRef: "gsel_frozen" }, { viewId: "V08", metricId: "M-16", dimension: "project" }, 20, "digest-1");
  expect(screen.queryByText("当前范围暂无可比的竞品读数，可查看完整分析与原因。")).not.toBeInTheDocument();
});

it("does not call an unpageable partial first page complete", async () => {
  read.mockResolvedValue({ rows: [], page: { nextOffset: 20 } });
  renderCard();
  expect(await screen.findByText("当前页未找到可比读数，请在完整分析中继续查看。")).toBeVisible();
});
