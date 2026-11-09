import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { readVcrPatients } from "@/lib/vcrClient";
import { VcrPeopleRecords } from "./VcrPeopleRecords";

/** 虚拟患者记录 (round-2 review P1-8): what the model is told the researcher sees. */
const raw = { id: "res_people", createdAt: "2026-11-09T05:00:00Z", people: 400, source: "由模型的人群层面抽出", current: false, madeFor: "为更早的一版模型造的（这些人照样被模拟，个体参数属于旧模型）",
  outside: { people: 12, range: [14, 26] }, usedBy: ["多奈哌齐对比不用药"] };

describe("VcrPeopleRecords", () => {
  it("shows the record's size, source, model, out-of-range people and what ran on it", () => {
    const [record] = readVcrPatients({ peopleRecords: [raw] }).peopleRecords ?? [];
    const { container } = render(<VcrPeopleRecords records={[record]} />);
    expect(screen.getByText("虚拟患者记录")).toBeTruthy();
    expect(container).toHaveTextContent("400 个虚拟患者");
    expect(container).toHaveTextContent("为更早的模型造的");
    expect(container).toHaveTextContent("12 人超出拟合范围");
    expect(container).toHaveTextContent("12 个人的基线 MMSE 在模型拟合所用试验的入组范围（14–26 分）之外，他们的结果是外推。");
    expect(container).toHaveTextContent("多奈哌齐对比不用药");
    expect(container.textContent).not.toMatch(/res_people/);
  });

  it("is absent for a study with no record, and a record made for the current model carries no warning", () => {
    expect(render(<VcrPeopleRecords records={[]} />).container).toBeEmptyDOMElement();
    const [record] = readVcrPatients({ peopleRecords: [{ ...raw, current: true, madeFor: "为现在的模型造的", outside: null, usedBy: [] }] }).peopleRecords ?? [];
    const { container } = render(<VcrPeopleRecords records={[record]} />);
    expect(container).not.toHaveTextContent("更早的模型");
    expect(container).toHaveTextContent("还没有比较用到它");
  });
});
