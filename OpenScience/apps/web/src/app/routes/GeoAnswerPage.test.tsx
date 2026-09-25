import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { answerFilled, evidenceFilled, geoProject } from "@/components/geo/__fixtures__/geoTabs";
import { GeoAnswerPage } from "./GeoAnswerPage";

const client = vi.hoisted(() => ({ getGeoAnswer: vi.fn(), getGeoEvidence: vi.fn(), getGeoProject: vi.fn() }));
vi.mock("@/lib/geoClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/geoClient")>()),
  ...client,
}));

function Probe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderAnswer(snapshotId = "snap_deepseek") {
  return render(
    <MemoryRouter initialEntries={[`/app/geo/geo_1/answers/${snapshotId}`]}>
      <Routes>
        <Route path="/app/geo/:geoId/answers/:snapshotId" element={<><GeoAnswerPage /><Probe /></>} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  client.getGeoAnswer.mockReset().mockResolvedValue(answerFilled);
  client.getGeoEvidence.mockReset().mockResolvedValue(evidenceFilled);
  client.getGeoProject.mockReset().mockResolvedValue(geoProject());
});

describe("one answer", () => {
  it("heads the page with the way back, the question, the date switcher and the screenshot", async () => {
    renderAnswer();
    expect(await screen.findByRole("heading", { level: 1, name: "打了减重针一直恶心，要不要停药？" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回诊断" })).toHaveAttribute("href", "/app/geo/geo_1/diagnosis");
    expect(screen.getByRole("link", { name: /截图/ })).toHaveAttribute("href", expect.stringContaining(`/geo/projects/geo_1/screenshots/${"a".repeat(64)}`));
    await userEvent.click(screen.getByRole("button", { name: /测量日期/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "9月22日" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/app/geo/geo_1/answers/snap_deepseek_old");
  });

  it("lists the engines asked the same question, with what each answer did", async () => {
    renderAnswer();
    const nav = await screen.findByRole("navigation", { name: "AI 引擎" });
    const deepseek = within(nav).getByText("DeepSeek").closest("[data-geo-sibling]") as HTMLElement;
    expect(within(deepseek).getByText("讲错 1 处")).toHaveClass("text-danger");
    expect(within(nav).getByRole("link", { name: /元宝.*提及 · 引用你/ })).toHaveAttribute("href", "/app/geo/geo_1/answers/snap_yuanbao");
    expect(within(nav).getByText("未提及")).toBeInTheDocument();
    expect(within(nav).getByText("未测")).toBeInTheDocument();
  });

  it("marks the wrong sentence with a wavy red line and says beneath it what is right, per which label, from which source, and what was done", async () => {
    renderAnswer();
    const wrong = await waitFor(() => {
      const found = document.querySelector("[data-geo-wrong]");
      if (!found) throw new Error("not yet");
      return found as HTMLElement;
    });
    expect(wrong).toHaveTextContent("它需要每天注射一次");
    expect(wrong).toHaveClass("decoration-wavy", "decoration-danger");
    expect(screen.getAllByText("玛仕度肽", { selector: "strong" }).length).toBeGreaterThan(0);

    const correction = document.querySelector("[data-geo-correction]") as HTMLElement;
    // The correction sits right under the paragraph that says it.
    expect(wrong.closest("p")?.nextElementSibling).toBe(correction);
    await waitFor(() => expect(correction).toHaveTextContent("讲错我方：对的是每周一次皮下注射，从低剂量起始，按说明书逐步增加剂量。"));
    expect(correction).toHaveTextContent("依据：玛仕度肽注射液说明书（国家药监局 2025）");
    expect(correction).toHaveTextContent("出处：[3] 玛仕度肽（百科词条）");
    expect(correction).toHaveTextContent("处置：修改百科词条 · 纠正中");
  });

  it("lists the cited sources, with those not used in the body said so", async () => {
    renderAnswer();
    const cited = await screen.findByRole("region", { name: "引用的信源" });
    expect(within(cited).getAllByRole("listitem")).toHaveLength(3);
    expect(within(cited).getByText("只列在参考资料")).toBeInTheDocument();
    expect(within(cited).getByRole("link", { name: "打开玛仕度肽" })).toHaveAttribute("href", "https://baike.baidu.com/item/x");
  });

  it("says a 百度 answer is mention-only", async () => {
    client.getGeoAnswer.mockResolvedValue({
      ...answerFilled,
      snapshot: { ...answerFilled.snapshot, engine: "baidu", answerText: null, surface: { mode: "inclusion" }, screenshot: false, citations: [] },
      errors: [],
      facts: { brands: [{ name: "玛仕度肽", ours: true, competitor: false, position: null, inRecommendation: false, count: 1 }], statements: [] },
    });
    renderAnswer();
    expect(await screen.findByText("只测提及：回答里提到了我们的产品。")).toBeInTheDocument();
  });

  it("says an answer that is not there", async () => {
    client.getGeoAnswer.mockRejectedValue(new WebApiError("not found", { status: 404, code: "not_found" }));
    renderAnswer();
    expect(await screen.findByText("这条回答不存在或已删除。")).toBeInTheDocument();
  });
});
