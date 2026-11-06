import { describe, expect, it } from "vitest";
import { studyIdFromPath } from "./studyLocation";
import { parseVcrWorkspaceArea, vcrContextPath, vcrWorkspaceAreaPath, vcrWorkspaceCurrentArea, vcrWorkspaceDestinationPath, VCR_WORKSPACE_AREAS } from "./vcrWorkspaceNavigation";

describe("VCR directories", () => {
  it("addresses module areas as query views without claiming a study", () => {
    for (const area of VCR_WORKSPACE_AREAS) {
      const path = new URL(vcrWorkspaceAreaPath(area), "https://vcr.invalid");
      expect(studyIdFromPath(path.pathname)).toBeNull();
      expect(parseVcrWorkspaceArea(path.search)).toBe(area);
      expect(vcrWorkspaceCurrentArea(path.pathname, path.search)).toBe(area);
    }
    expect(parseVcrWorkspaceArea("?area=unknown")).toBe("records");
  });
  it.each(["?new=1", "?tab=precedents", "?tab=definitions", "?tab=models"])("does not select records for library/draft %s", search => {
    expect(vcrWorkspaceCurrentArea("/app/virtual-research", search)).toBeNull();
  });
  it("keeps context in the explicitly addressed study only", () => {
    const from = { pathname: "/app/virtual-research/std_1/population", search: "?session=ses_1&conversation=open&level=cohort&step=population&private=drop" };
    expect(vcrWorkspaceDestinationPath("virtual-patient", from)).toBe("/app/virtual-research/std_1/population?session=ses_1&conversation=open&level=individual");
    expect(vcrWorkspaceDestinationPath("records", from)).toBe("/app/virtual-research");
    expect(vcrContextPath("/app/virtual-research/std_2/trial", from)).toBe("/app/virtual-research/std_2/trial");
    expect(vcrWorkspaceDestinationPath("virtual-trial", { pathname: "/app/chat/ses_1", search: from.search })).toBe("/app/virtual-research?area=virtual-trial");
  });
  it("retains the chat view while changing its result and individual level", () => {
    const path = vcrWorkspaceDestinationPath("virtual-patient", { pathname: "/app/virtual-research/std_1/chat", search: "?result=trial&session=ses_1&conversation=open" });
    const url = new URL(path, "https://vcr.invalid");
    expect(url.pathname).toBe("/app/virtual-research/std_1/chat");
    expect(Object.fromEntries(url.searchParams)).toEqual({ session: "ses_1", conversation: "open", level: "individual", result: "population" });
    expect(vcrWorkspaceCurrentArea(url.pathname, url.search)).toBe("virtual-patient");
    expect(vcrWorkspaceCurrentArea(url.pathname, "?result=population&level=cohort")).toBe("virtual-cohort");
    expect(vcrWorkspaceCurrentArea(url.pathname, "?result=comparator")).toBe("synthetic-control");
    expect(vcrWorkspaceCurrentArea(url.pathname, "?result=trial")).toBe("virtual-trial");
    expect(vcrWorkspaceCurrentArea(url.pathname, "?result=matching")).toBe("patient-matching");
  });
  it.each(["%", "%E0%A4%A", "%2F", "a%20b"])("rejects malformed or unsafe study id %s", id => {
    const pathname = `/app/virtual-research/${id}/population`;
    expect(studyIdFromPath(pathname)).toBeNull();
    expect(vcrWorkspaceDestinationPath("virtual-patient", { pathname, search: "?session=private" })).toBe("/app/virtual-research?area=virtual-patient");
  });
});
