import { describe, expect, it } from "vitest";
import { KNOWLEDGE_BASE_FORMATS } from "@evimed/domain";
import { KNOWLEDGE_BASE_ACCEPT, KNOWLEDGE_BASE_FORMAT_FAMILIES, KNOWLEDGE_BASE_UPLOAD_HINT, partitionKnowledgeBaseFiles } from "./knowledgeBaseFiles";

describe("the knowledge base's accepted formats", () => {
  it("are named as families that are exactly what the upload check accepts", () => {
    const named = KNOWLEDGE_BASE_FORMAT_FAMILIES.flatMap(([, formats]) => formats);
    expect(new Set(named).size).toBe(named.length);
    expect([...named].sort()).toEqual([...KNOWLEDGE_BASE_FORMATS].sort());
    expect(KNOWLEDGE_BASE_ACCEPT.split(",")).toEqual(KNOWLEDGE_BASE_FORMATS.map((format) => `.${format}`));
    expect(KNOWLEDGE_BASE_UPLOAD_HINT).toContain("PDF");
    expect(KNOWLEDGE_BASE_UPLOAD_HINT).toContain("音视频暂不支持");
  });

  it("are told before anything is sent: a recording and an unknown format are refused with their reasons, the rest go on", () => {
    const { accepted, refused } = partitionKnowledgeBaseFiles([new File([""], "a.PDF"), new File([""], "b.wav"), new File([""], "noext"), new File([""], "c.md")]);
    expect(accepted.map((file) => file.name)).toEqual(["a.PDF", "c.md"]);
    expect(refused).toEqual([{ name: "b.wav", reason: "音视频暂不支持" }, { name: "noext", reason: "格式不在支持范围内" }]);
  });
});
