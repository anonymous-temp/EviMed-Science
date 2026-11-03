import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { readVcrModelCard } from "@/lib/vcrClient";
import { VcrModelRecord } from "./VcrModelRecord";

afterEach(cleanup);

const card = (extra: Record<string, unknown> = {}) => readVcrModelCard({
  id: "m1", name: "已发表的预后方程", version: "1", tier: "literature", risk: "low", useCeiling: "design_support", inputs: ["age (years)"], limits: [], ...extra,
});

describe("the model record", () => {
  it("shows the TRIPOD-style words a card holds as ordinary rows, in their order (D3)", () => {
    render(<MemoryRouter><VcrModelRecord model={card({ tripod: [
      { key: "developmentPopulation", label: "开发人群", text: "2008-2014 年三家医院的 1,204 名患者" },
      { key: "validationStudy", label: "验证情况", text: "外部验证 2 项" },
      { key: "outcomeHorizon", label: "结局和时间范围", text: "12 个月死亡" },
      { key: "intendedUse", label: "预期用途", text: "辅助分层，不用于单个病人的决定" },
    ] })} /></MemoryRouter>);
    for (const label of ["开发人群", "验证情况", "结局和时间范围", "预期用途"]) expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText("辅助分层，不用于单个病人的决定")).toBeInTheDocument();
    expect(screen.getByText("2008-2014 年三家医院的 1,204 名患者")).toBeInTheDocument();
  });

  it("is complete without them: a card with none has no such row and no placeholder for one", () => {
    render(<MemoryRouter><VcrModelRecord model={card()} /></MemoryRouter>);
    expect(screen.queryByText("开发人群")).toBeNull();
    expect(screen.queryByText("预期用途")).toBeNull();
    expect(screen.getByText("输入")).toBeInTheDocument();
  });

  it("drops a row the server sent without words", () => {
    expect(card({ tripod: [{ key: "intendedUse", label: "预期用途", text: "" }, { label: "x", text: "y" }] }).tripod).toEqual([]);
  });
});
