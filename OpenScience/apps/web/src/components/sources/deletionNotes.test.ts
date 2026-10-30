import { describe, expect, it } from "vitest";
import type { SourceRecord } from "@/lib/sourceClient";
import { documentDeletionNote, projectDeletionNote } from "./deletionNotes";

const labels = new Map([["p1", "疳证 Meta"], ["p2", "心衰随访"], ["p3", "药物安全"]]);
const source = (extra: Partial<SourceRecord> = {}) => ({ id: "src_one", projectId: "p1", display: { title: "ASPREE.pdf" }, ...extra }) as unknown as SourceRecord;

describe("what deleting a document says it does", () => {
  it("names every project that holds a copy, and that all of the copies go", () => {
    const note = documentDeletionNote(source({ holders: [{ id: "p1", name: "旧名" }, { id: "p2", name: "心衰随访" }], libraryProjects: null, appliesTo: ["p1", "p2"] }), labels);
    expect(note.body).toBe("这份资料在账户里的所有副本都会删除（所在项目：“疳证 Meta”“心衰随访”），删除后不再用于回答。");
    expect(note.consequences).toBeUndefined();
  });

  it("says which other projects lose it, when the person had sent it to them", () => {
    const note = documentDeletionNote(source({ holders: [{ id: "p1", name: "疳证 Meta" }], libraryProjects: ["p2", "p3"], appliesTo: ["p1", "p2", "p3"] }), labels);
    expect(note.consequences).toBe("它原先还对“心衰随访”“药物安全”生效，这些项目也读不到它了。");
    // A project that cannot be named any more is left out, not shown as an id.
    expect(documentDeletionNote(source({ holders: [{ id: "p1", name: "疳证 Meta" }], libraryProjects: ["gone"], appliesTo: ["p1", "gone"] }), labels).consequences).toBeUndefined();
  });

  it("says every project when it took effect in all of them, and does not claim a holder for a file kept only in storage", () => {
    const wide = documentDeletionNote(source({ holders: [{ id: "p1", name: "疳证 Meta" }], libraryProjects: "all", appliesTo: "all" }), labels);
    expect(wide.consequences).toBe("它原先对所有项目生效，删除后所有项目都读不到它。");
    const stored = documentDeletionNote(source({ personal: true, holders: [], libraryProjects: [], appliesTo: [] }), labels);
    expect(stored.body).toBe("这份资料在账户里的所有副本都会删除，删除后不再用于回答。");
  });
});

describe("what deleting a project says it takes from other projects", () => {
  it("is nothing when no document was sent elsewhere", () => {
    expect(projectDeletionNote([], labels)).toBeNull();
  });

  it("names a few of the documents and the projects they were sent to", () => {
    const note = projectDeletionNote([
      { sourceId: "src_a", title: "ASPREE", projects: ["p2"] }, { sourceId: "src_b", title: "ARISTOTLE", projects: ["p2", "p3"] },
    ], labels);
    expect(note).toBe("只在这个项目里保存、却被设为在“心衰随访”“药物安全”生效的资料（《ASPREE》《ARISTOTLE》）会随项目一起删除，那些项目也读不到它们。");
  });

  it("counts the rest past three, and says every project where any was sent to all", () => {
    const many = Array.from({ length: 5 }, (_, index) => ({ sourceId: `src_${index}`, title: `文献${index}`, projects: index === 4 ? "all" as const : ["p2"] }));
    expect(projectDeletionNote(many, labels)).toBe("只在这个项目里保存、却被设为在所有项目生效的资料（《文献0》《文献1》《文献2》等5份）会随项目一起删除，那些项目也读不到它们。");
  });

  it("says nothing when none of the projects can be named any more", () => {
    expect(projectDeletionNote([{ sourceId: "src_a", title: "ASPREE", projects: ["gone"] }], labels)).toBeNull();
  });
});
