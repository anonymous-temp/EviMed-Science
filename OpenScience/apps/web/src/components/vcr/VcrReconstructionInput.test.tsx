import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { VcrReconstructionInput } from "./VcrReconstructionInput";
it.each(["published_curve", "curve_image"])("preserves %s source identity without claiming publication", kind => {
  render(<MemoryRouter><VcrReconstructionInput studyId="calculation_1" selected="result_42" available choices={[{ resultId: "result_42", label: "Kaplan–Meier reconstruction", version: 4, createdAt: "2026-10-20", method: "evidence.reconstruct_km", valueSource: "reconstructed", table: "reconstructed-ipd", source: { kind, origin: { title: "Dataset-derived survival figure" } }, timeUnit: "months" }]} scenario={{}} disabled={false} onChange={() => undefined} onRefresh={() => undefined} /></MemoryRouter>);
  expect(screen.getByLabelText("曲线重建结果")).toHaveValue("result_42");
  expect(screen.getByText("Dataset-derived survival figure")).toBeInTheDocument();
  expect(screen.getByText("曲线重建，不能当作真实患者观测")).toBeInTheDocument();
  expect(screen.queryByText(/文献曲线重建/)).toBeNull();
});
