import { describe, expect, it } from "vitest";
import { readableSourceRef } from "./EvidenceTab";

describe("readableSourceRef", () => {
  it("never shows a preserved page's hash", () => {
    expect(readableSourceRef("web-page:e1edc04a1ac28750")).toBeNull();
    expect(readableSourceRef(".evimed-sources/label/x.md")).toBeNull();
  });
  it("keeps a literature id readable", () => {
    expect(readableSourceRef("PMID:40421736")).toBe("PMID 40421736");
    expect(readableSourceRef("doi: 10.1056/NEJMoa2300000")).toBe("DOI 10.1056/NEJMoa2300000");
  });
  it("keeps a name a person wrote", () => {
    expect(readableSourceRef("中国成人超重和肥胖症预防控制指南 2024")).toBe("中国成人超重和肥胖症预防控制指南 2024");
  });
});
