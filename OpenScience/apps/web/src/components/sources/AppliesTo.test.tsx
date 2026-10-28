import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import type { SourceRecord } from "@/lib/sourceClient";
import { APPLIES_NOWHERE, AppliesToDialog, appliesView, conversationProjects } from "./AppliesTo";
import type { ProjectGroups } from "./useProjectGroups";

const api = vi.hoisted(() => ({ setSourceProjects: vi.fn() }));
vi.mock("@/lib/sourceClient", async (importOriginal) => ({ ...(await importOriginal<object>()), setSourceProjects: api.setSourceProjects }));

const labels = new Map([["p1", "疳证 Meta"], ["p2", "心衰随访"], ["p3", "药物安全"], ["study", "SGLT2 虚拟研究"], ["geo", "某药 GEO"]]);
const groups: ProjectGroups = {
  own: [{ id: "p1", label: "疳证 Meta" }, { id: "p2", label: "心衰随访" }, { id: "p3", label: "药物安全" }],
  studies: [{ id: "study", label: "SGLT2 虚拟研究" }], communication: [{ id: "geo", label: "某药 GEO" }], labels,
};
const source = (extra: Partial<SourceRecord> = {}) => ({
  id: "src_one", projectId: "p1", revision: 1, createdAt: "2026-10-03T08:00:00Z", updatedAt: "2026-10-03T08:00:00Z", deletedAt: null,
  display: { title: "ASPREE.pdf" }, payload: { paths: ["knowledge-base/ASPREE.pdf"], status: "complete" }, ...extra,
}) as unknown as SourceRecord;

describe("where a document takes effect, in words", () => {
  it("says every project, or names the holders first and then the projects it was sent to", () => {
    expect(appliesView(source({ appliesTo: "all" }), labels)).toEqual({ all: true, names: [], text: "所有项目" });
    const two = source({ holders: [{ id: "p2", name: "心衰随访" }], libraryProjects: ["p1"], appliesTo: ["p1", "p2"] });
    expect(appliesView(two, labels)?.text).toBe("心衰随访、疳证 Meta");
  });

  it("names a project the way the project list does, and leaves out one that cannot be named any more", () => {
    const view = appliesView(source({ holders: [{ id: "p1", name: "疳证 Meta（旧名）" }], libraryProjects: ["gone"], appliesTo: ["gone", "p1"] }), labels);
    expect(view?.names).toEqual(["疳证 Meta"]);
  });

  it("says that a document in storage that was handed to no project takes effect nowhere, and nothing at all for a row that carries no answer", () => {
    expect(appliesView(source({ personal: true, holders: [], libraryProjects: [], appliesTo: [] }), labels)?.text).toBe(APPLIES_NOWHERE);
    expect(appliesView(source(), labels)).toBeNull();
  });
});

describe("the projects whose conversation can read a selection", () => {
  it("is the one project a document takes effect in, the account's own projects for 「所有项目」, and what the documents share", () => {
    expect(conversationProjects([source({ appliesTo: ["p2"] })], groups).map((choice) => choice.id)).toEqual(["p2"]);
    expect(conversationProjects([source({ appliesTo: "all" })], groups).map((choice) => choice.id)).toEqual(["p1", "p2", "p3"]);
    expect(conversationProjects([source({ appliesTo: ["p1", "p2"] }), source({ appliesTo: ["p2", "p3"] })], groups).map((choice) => choice.id)).toEqual(["p2"]);
    expect(conversationProjects([source({ appliesTo: ["p1"] }), source({ appliesTo: ["p3"] })], groups)).toEqual([]);
    expect(conversationProjects([source({ appliesTo: "all" }), source({ appliesTo: ["p3"] })], groups).map((choice) => choice.id)).toEqual(["p3"]);
  });

  it("reads a project of another kind where the file lives in it, and falls back to the project that holds a row with no answer", () => {
    expect(conversationProjects([source({ appliesTo: ["geo"] })], groups).map((choice) => choice.id)).toEqual(["geo"]);
    expect(conversationProjects([source({ projectId: "p3" })], groups).map((choice) => choice.id)).toEqual(["p3"]);
    expect(conversationProjects([source({ personal: true, projectId: "evimed-library" })], groups)).toEqual([]);
    expect(conversationProjects([], groups)).toEqual([]);
  });
});

describe("the 「生效项目」 dialog", () => {
  beforeEach(() => { api.setSourceProjects.mockReset(); });
  afterEach(cleanup);
  const open = (document: SourceRecord, onSaved = vi.fn(), onClose = vi.fn()) => {
    render(<AppliesToDialog source={document} projects={groups.own} labels={labels} onClose={onClose} onSaved={onSaved} />);
    return { onSaved, onClose };
  };

  it("starts from what the document says, keeps the holders checked and fixed, and sends only what was added", async () => {
    api.setSourceProjects.mockResolvedValue({ libraryProjects: ["p3"], appliesTo: ["p1", "p3"] });
    const { onSaved } = open(source({ holders: [{ id: "p1", name: "疳证 Meta" }], libraryProjects: null, appliesTo: ["p1"] }));
    const dialog = screen.getByRole("dialog", { name: "生效项目" });
    expect(within(dialog).getByRole("radio", { name: "选择项目" })).toBeChecked();
    const held = within(dialog).getByRole("checkbox", { name: /疳证 Meta/ });
    expect(held).toBeChecked(); expect(held).toBeDisabled();
    expect(within(dialog).getByText(/所在项目/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "保存" })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "药物安全" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(api.setSourceProjects).toHaveBeenCalledWith("src_one", ["p3"]);
    expect(onSaved).toHaveBeenCalledWith({ sourceId: "src_one", libraryProjects: ["p3"], appliesTo: ["p1", "p3"] });
  });

  it("offers every project, those made later too, and sends the word", async () => {
    api.setSourceProjects.mockResolvedValue({ libraryProjects: "all", appliesTo: "all" });
    open(source({ holders: [{ id: "p1", name: "疳证 Meta" }], libraryProjects: ["p2"], appliesTo: ["p1", "p2"] }));
    const dialog = screen.getByRole("dialog", { name: "生效项目" });
    expect(within(dialog).getByRole("checkbox", { name: "心衰随访" })).toBeChecked();
    expect(within(dialog).getByText("包括以后新建的项目。")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("radio", { name: "所有项目" }));
    expect(within(dialog).queryByRole("group", { name: "选择项目" })).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(api.setSourceProjects).toHaveBeenCalledWith("src_one", "all");
  });

  it("lists a project that holds the file whatever its kind, and a document in storage with no holder has only the person's own projects to choose", () => {
    open(source({ holders: [{ id: "geo", name: "某药 GEO" }], libraryProjects: null, appliesTo: ["geo"] }));
    const held = screen.getByRole("checkbox", { name: /某药 GEO/ });
    expect(held).toBeChecked(); expect(held).toBeDisabled();
    expect(screen.getAllByRole("checkbox").map((box) => (box as HTMLInputElement).checked)).toEqual([true, false, false, false]);
    cleanup();
    open(source({ personal: true, holders: [], libraryProjects: [], appliesTo: [] }));
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
  });

  it("says a refusal in the registry's sentence and stays open with the choice", async () => {
    api.setSourceProjects.mockRejectedValue(new WebApiError("no", { status: 400, code: "library_projects_invalid" }));
    const { onSaved } = open(source({ holders: [{ id: "p1", name: "疳证 Meta" }], libraryProjects: null, appliesTo: ["p1"] }));
    await userEvent.click(screen.getByRole("radio", { name: "所有项目" }));
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("适用项目的选择不完整");
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "所有项目" })).toBeChecked();
  });

  it("says a changed revision as the house does: ask the person to read it again", async () => {
    api.setSourceProjects.mockRejectedValue(new WebApiError("conflict", { status: 409, code: "product_revision_conflict" }));
    open(source({ holders: [{ id: "p1", name: "疳证 Meta" }], libraryProjects: null, appliesTo: ["p1"] }));
    await userEvent.click(screen.getByRole("radio", { name: "所有项目" }));
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
