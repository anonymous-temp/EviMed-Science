import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { readGeoCell } from "@/lib/geoClient";
import { cell } from "./__fixtures__/geoProjects";
import { formatGeoValue, GeoCellText, geoCellPhrase, geoCellWord, geoSampleText } from "./GeoCellText";
import { geoNumberDraft } from "./AskAi";

describe("a GEO number", () => {
  it("is its value with the sample it rests on", () => {
    render(<GeoCellText cell={cell(18, 56, 310)} />);
    expect(screen.getByText("18%")).toBeInTheDocument();
    expect(screen.getByText("310 次里 56 次")).toBeInTheDocument();
    expect(geoCellPhrase(cell(18, 56, 310))).toBe("18%，310 次里 56 次");
  });

  it("never shows a rate under 30 answers: 「样本不足」 and how few there were", () => {
    const thin = cell(44, 12, 27, "insufficient");
    render(<GeoCellText cell={thin} />);
    expect(screen.getByText("样本不足")).toBeInTheDocument();
    expect(screen.getByText("27 次回答")).toBeInTheDocument();
    expect(screen.queryByText(/44/)).not.toBeInTheDocument();
  });

  it("says 「未测」 for an engine that was not measured and 「—」 for what cannot be measured — never zero", () => {
    expect(geoCellWord(cell(null, null, null, "absent"))).toBe("未测");
    expect(geoCellWord(cell(0, 0, 0, "absent"))).toBe("未测");
    expect(geoCellWord(cell(null, null, null, "not_measurable"))).toBe("—");
    expect(geoCellWord(null)).toBe("—");
    expect(geoSampleText(cell(null, null, null, "absent"))).toBeNull();
  });

  it("reads a malformed cell as unmeasured, not as a number", () => {
    expect(readGeoCell(undefined)).toMatchObject({ value: null, status: "not_measurable" });
    expect(readGeoCell({ value: "18", status: "great" })).toMatchObject({ value: null, status: "not_measurable" });
    expect(readGeoCell({ value: 18, numerator: 56, denominator: 310, status: "ok", dataType: "forecast" }))
      .toEqual({ value: 18, numerator: 56, denominator: 310, ciLow: null, ciHigh: null, status: "ok", dataType: "forecast" });
  });

  it("formats on the metric's own scale", () => {
    expect(formatGeoValue(18.4)).toBe("18%");
    expect(formatGeoValue(0.43)).toBe("0.4%");
    expect(formatGeoValue(38.2, "index")).toBe("38");
    expect(geoCellPhrase(cell(38, null, 1240), "index")).toBe("38，1,240 次回答");
  });

  it("writes 问 AI's draft from the number, its name, the date and the sample", () => {
    expect(geoNumberDraft({ product: "玛仕度肽注射液", scope: "豆包", name: "品牌提及率", cell: cell(18, 56, 310), date: "9月22日" }))
      .toBe("玛仕度肽注射液 · 豆包 · 品牌提及率：18%，310 次里 56 次（9月22日测量）。这个数说明了什么，接下来该做什么？");
    expect(geoNumberDraft({ name: "引用命中率", cell: cell(6, 2, 24, "insufficient") }))
      .toBe("引用命中率：样本不足，24 次回答。这个数说明了什么，接下来该做什么？");
  });
});
