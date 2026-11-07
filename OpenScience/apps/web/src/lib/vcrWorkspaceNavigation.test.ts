import { describe, expect, it } from "vitest";
import { studyIdFromPath } from "./studyLocation";
import { parseVcrWorkspaceArea, vcrContextPath, vcrMatchingDestination, vcrWorkspaceAreaPath, vcrWorkspaceCurrentArea, vcrWorkspaceDestinationPath, VCR_ENTRANCES, VCR_WORKSPACE_AREAS } from "./vcrWorkspaceNavigation";

describe("VCR entrances", () => {
  it("has exactly five public entrances and keeps the archive readable but outside them", () => {
    expect(VCR_ENTRANCES).toEqual(["virtual-population", "patient-trajectory", "virtual-lab", "synthetic-control", "patient-matching"]);
    expect(VCR_WORKSPACE_AREAS).toContain("records");
    expect(VCR_ENTRANCES).not.toContain("records");
  });
  it("addresses module areas as query views without claiming a study", () => {
    for (const area of VCR_WORKSPACE_AREAS) {
      const path = new URL(vcrWorkspaceAreaPath(area), "https://vcr.invalid");
      expect(studyIdFromPath(path.pathname)).toBeNull();
      expect(parseVcrWorkspaceArea(path.search)).toBe(area);
      expect(vcrWorkspaceCurrentArea(path.pathname, path.search)).toBe(area === "records" ? null : area);
    }
  });
  it("opens the laboratory at the module root and for an unknown area", () => {
    expect(parseVcrWorkspaceArea("")).toBe("virtual-lab");
    expect(parseVcrWorkspaceArea("?area=unknown")).toBe("virtual-lab");
    expect(vcrWorkspaceCurrentArea("/app/virtual-research", "")).toBe("virtual-lab");
    expect(parseVcrWorkspaceArea("?area=records")).toBe("records");
  });
  it.each([["virtual-cohort", "virtual-population"], ["virtual-patient", "patient-trajectory"], ["virtual-trial", "virtual-lab"]])("reads the old area %s as %s", (old, entrance) => {
    expect(parseVcrWorkspaceArea(`?area=${old}`)).toBe(entrance);
    expect(vcrWorkspaceCurrentArea("/app/virtual-research", `?area=${old}`)).toBe(entrance);
  });
  it.each(["?new=1", "?tab=precedents", "?tab=definitions", "?tab=models", "?study=std_1", "?area=records"])("selects no entrance for library, draft, preview or archive %s", search => {
    expect(vcrWorkspaceCurrentArea("/app/virtual-research", search)).toBeNull();
  });
  it("keeps context in the explicitly addressed study only", () => {
    const from = { pathname: "/app/virtual-research/std_1/population", search: "?session=ses_1&conversation=open&level=cohort&step=population&private=drop" };
    expect(vcrWorkspaceDestinationPath("patient-trajectory", from)).toBe("/app/virtual-research/std_1/population?session=ses_1&conversation=open&level=individual");
    expect(vcrContextPath("/app/virtual-research/std_2/trial", from)).toBe("/app/virtual-research/std_2/trial");
    expect(vcrWorkspaceDestinationPath("virtual-lab", { pathname: "/app/chat/ses_1", search: from.search })).toBe("/app/virtual-research?area=virtual-lab");
  });
  it("retains the chat view while changing its result and individual level", () => {
    const path = vcrWorkspaceDestinationPath("patient-trajectory", { pathname: "/app/virtual-research/std_1/chat", search: "?result=trial&session=ses_1&conversation=open" });
    const url = new URL(path, "https://vcr.invalid");
    expect(url.pathname).toBe("/app/virtual-research/std_1/chat");
    expect(Object.fromEntries(url.searchParams)).toEqual({ session: "ses_1", conversation: "open", level: "individual", result: "population" });
    expect(vcrWorkspaceCurrentArea(url.pathname, url.search)).toBe("patient-trajectory");
    expect(vcrWorkspaceCurrentArea(url.pathname, "?result=population&level=cohort")).toBe("virtual-population");
    expect(vcrWorkspaceCurrentArea(url.pathname, "?result=comparator")).toBe("synthetic-control");
    expect(vcrWorkspaceCurrentArea(url.pathname, "?result=trial")).toBe("virtual-lab");
    expect(vcrWorkspaceCurrentArea(url.pathname, "?result=matching")).toBe("patient-matching");
  });
  it("sends matching through the replaceable descriptor and carries no handoff", () => {
    expect(vcrMatchingDestination.handoff).toBe("unavailable");
    expect(vcrMatchingDestination.path({ pathname: "/app/virtual-research/std_1/population", search: "?session=ses_1&cohort=secret" })).toBe("/app/virtual-research/std_1/matching?session=ses_1");
    expect(vcrWorkspaceDestinationPath("patient-matching", { pathname: "/app/virtual-research/std_1/population", search: "" })).toBe("/app/virtual-research/std_1/matching");
    expect(vcrWorkspaceDestinationPath("patient-matching", { pathname: "/app/chat/ses_1", search: "?session=ses_1" })).toBe("/app/virtual-research?area=patient-matching");
  });
  it.each(["%", "%E0%A4%A", "%2F", "a%20b"])("rejects malformed or unsafe study id %s", id => {
    const pathname = `/app/virtual-research/${id}/population`;
    expect(studyIdFromPath(pathname)).toBeNull();
    expect(vcrWorkspaceDestinationPath("patient-trajectory", { pathname, search: "?session=private" })).toBe("/app/virtual-research?area=patient-trajectory");
    expect(vcrWorkspaceDestinationPath("patient-matching", { pathname, search: "?session=private" })).toBe("/app/virtual-research?area=patient-matching");
  });
});
