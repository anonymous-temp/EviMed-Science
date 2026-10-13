import { describe, expect, it } from "vitest";
import { KNOWLEDGE_BASE_ACCEPT, KNOWLEDGE_BASE_UPLOAD_HINT, partitionKnowledgeBaseFiles } from "./knowledgeBaseFiles";

describe("what the knowledge base's picker offers", () => {
  it("is every file: the picker filters by no list", () => {
    expect(KNOWLEDGE_BASE_ACCEPT).toBe("");
    expect(KNOWLEDGE_BASE_UPLOAD_HINT).toContain("只保存原件");
    expect(KNOWLEDGE_BASE_UPLOAD_HINT).not.toMatch(/[「」]|不支持/);
  });

  it("turns nothing away before it is sent, whatever the file is called", () => {
    // GA07, the probe of 2026-10-12: source code, a notebook, an archive, a recording and a name with no extension were
    // each refused here by name.
    const names = ["a.PDF", "app.ts", "analysis.ipynb", "src.zip", "b.wav", "Makefile", "cohort.sav", "c.md"];
    const { accepted, refused } = partitionKnowledgeBaseFiles(names.map((name) => new File([""], name)));
    expect(accepted.map((file) => file.name)).toEqual(names);
    expect(refused).toEqual([]);
  });
});
