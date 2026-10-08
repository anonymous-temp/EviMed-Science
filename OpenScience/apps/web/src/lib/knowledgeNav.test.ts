import { afterEach, describe, expect, it } from "vitest";
import { legacySourceParam, listPath, readListState, readReaderView, readerPath, recallListPosition, rememberListPosition, scopeOf, scopeParam } from "./knowledgeNav";

const params = (search: string) => new URLSearchParams(search);
const none = { scope: null, kind: null, q: "" } as const;

describe("the knowledge base's address", () => {
  it("round-trips the scope, the type and the search, and writes nothing for the defaults", () => {
    expect(listPath(none)).toBe("/app/files");
    expect(listPath({ scope: "paper-1", kind: "table", q: "疳证" })).toBe("/app/files?scope=paper-1&kind=table&q=%E7%96%B3%E8%AF%81");
    expect(readListState(params("scope=paper-1&kind=table&q=%E7%96%B3%E8%AF%81"))).toEqual({ scope: "paper-1", kind: "table", q: "疳证" });
    expect(readListState(params("scope=shared"))).toEqual({ scope: "shared", kind: null, q: "" });
    expect(readListState(params(""))).toEqual(none);
  });

  it("reads an address as untrusted: an unknown type, an empty or oversized scope or search is not taken", () => {
    expect(readListState(params("kind=nonsense&scope=%20&q=%20%20"))).toEqual(none);
    expect(readListState(params(`scope=${"p".repeat(201)}&q=${"x".repeat(500)}`))).toEqual({ scope: null, kind: null, q: "x".repeat(200) });
    expect(readListState(params("kind=literature&kind=table")).kind).toBe("literature");
  });

  it("puts a document at its own address, carrying the list it was opened from and what it shows", () => {
    expect(readerPath("src_abc", none)).toBe("/app/files/src_abc");
    expect(readerPath("src_abc", { scope: "shared", kind: "literature", q: "共识" }, { tab: "original", page: 5 }))
      .toBe("/app/files/src_abc?scope=shared&kind=literature&q=%E5%85%B1%E8%AF%86&tab=original&page=5");
    // An id is one path segment: it cannot carry a path, however it is spelled.
    expect(readerPath("../etc/passwd", none)).toBe("/app/files/..%2Fetc%2Fpasswd");
  });

  it("reads the tab and the page of a document's address, and ignores what is not one", () => {
    expect(readReaderView(params("tab=original&page=12"))).toEqual({ tab: "original", page: 12 });
    expect(readReaderView(params("tab=content"))).toEqual({ tab: "content", page: null });
    expect(readReaderView(params("tab=elsewhere&page=-3"))).toEqual({ tab: null, page: null });
    expect(readReaderView(params("page=2.5"))).toEqual({ tab: null, page: null });
    expect(readReaderView(params("page=0"))).toEqual({ tab: null, page: null });
    expect(readReaderView(params("page=1000000"))).toEqual({ tab: null, page: null });
    expect(readReaderView(params("page=abc"))).toEqual({ tab: null, page: null });
  });

  it("reads a legacy ?source= only when it is a document's id", () => {
    expect(legacySourceParam(params("source=src_1a2b3c"))).toBe("src_1a2b3c");
    expect(legacySourceParam(params("source=..%2F..%2Fetc"))).toBeNull();
    expect(legacySourceParam(params("source=%3Cscript%3E"))).toBeNull();
    expect(legacySourceParam(params("source="))).toBeNull();
    expect(legacySourceParam(params("tab=sources"))).toBeNull();
  });

  it("turns a list state into a scope and back, with the tab's own project standing for none", () => {
    expect(scopeOf(none, "default")).toEqual({ kind: "project", projectId: "default" });
    expect(scopeOf({ ...none, scope: "paper-1" }, "default")).toEqual({ kind: "project", projectId: "paper-1" });
    expect(scopeOf({ ...none, scope: "shared" }, "default")).toEqual({ kind: "shared" });
    expect(scopeParam({ kind: "project", projectId: "default" }, "default")).toBeNull();
    expect(scopeParam({ kind: "project", projectId: "paper-1" }, "default")).toBe("paper-1");
    expect(scopeParam({ kind: "shared" }, "default")).toBe("shared");
  });
});

describe("where the list was left", () => {
  afterEach(() => window.sessionStorage.clear());

  it("is kept for the list state it was in, and for no other", () => {
    rememberListPosition({ scope: "paper-1", kind: null, q: "" }, { scroll: 420, count: 100 });
    expect(recallListPosition({ scope: "paper-1", kind: null, q: "" })).toEqual({ scroll: 420, count: 100 });
    expect(recallListPosition(none)).toBeNull();
    expect(recallListPosition({ scope: "paper-1", kind: "table", q: "" })).toBeNull();
  });

  it("is read as untrusted: what is not a position is not one, and an enormous list is bounded", () => {
    const key = (state: typeof none) => `evimed:knowledge-list-position:${new URLSearchParams(listPath(state).split("?")[1] ?? "")}`;
    for (const bad of ["not json", "null", "[]", JSON.stringify({ scroll: -1, count: 5 }), JSON.stringify({ scroll: 5, count: 0 }), JSON.stringify({ scroll: "5", count: 5 }), JSON.stringify({ scroll: 5, count: 2.5 })]) {
      window.sessionStorage.setItem(key(none), bad);
      expect(recallListPosition(none), bad).toBeNull();
    }
    window.sessionStorage.setItem(key(none), JSON.stringify({ scroll: 5, count: 50_000 }));
    expect(recallListPosition(none)).toEqual({ scroll: 5, count: 1000 });
  });

  it("is a convenience: a storage that refuses is a list that opens at the top, not an error", () => {
    const original = Object.getOwnPropertyDescriptor(window, "sessionStorage")!;
    Object.defineProperty(window, "sessionStorage", { configurable: true, get() { throw new Error("storage is disabled"); } });
    try {
      expect(() => rememberListPosition(none, { scroll: 1, count: 1 })).not.toThrow();
      expect(recallListPosition(none)).toBeNull();
    } finally {
      Object.defineProperty(window, "sessionStorage", original);
    }
  });
});
