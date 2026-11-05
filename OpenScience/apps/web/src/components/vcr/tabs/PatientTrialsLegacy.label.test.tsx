import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PatientTrialsLegacy } from "./PatientTrialsLegacy";

vi.mock("@/lib/projects", () => ({ useProjectStore: { getState: () => ({ projects: [], select: vi.fn(), load: vi.fn() }) } }));

describe("the earlier patient page names a person the way every other page does", () => {
  it("says P-xxxxxx for a study key, never the key", () => {
    const page = { available: true, subject: "P32655ea5d0fe2ebf", trials: [], selected: null } as any;
    render(<PatientTrialsLegacy studyId="std_1" study={{ abilities: ["run", "read_patient_level"] } as any} page={page} roster={[]} asked={null} picked={null} facts={[]} onPick={vi.fn()} onSearched={vi.fn()} />);
    expect(screen.getByText("还没有为 P-32655E 找过试验。")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("P32655ea5d0fe2ebf");
  });
});
