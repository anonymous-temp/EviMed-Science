import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SourceProjectDialog } from "./SourceProjectDialog";
import type { SourceRecord } from "@/lib/sourceClient";
const copy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sourceClient", () => ({ copySourceToProject: copy }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const source = (id: string, projectId: string, shared = false, original = `knowledge-base/${id}.pdf`) => ({ id, projectId, revision: 3, display: { title: id, shared }, payload: { paths: [original], status: "ready" } }) as unknown as SourceRecord;
it("copies every ineligible selected version and returns the actual references without sending", async () => {
 const personal = { ...source("personal", "evimed-library"), personal: true };
 const shared = source("shared", "p2", true), own = source("own", "p1");
 const done = vi.fn(); copy.mockResolvedValue({ source: source("copied", "p1") });
 render(<SourceProjectDialog sources={[personal, shared, own]} conversation options={[{ id: "p1", label: "项目一" }]} onClose={() => {}} onDone={done} />);
 expect(screen.getByRole("combobox", { name: "目标项目" })).toHaveAccessibleDescription("添加后在目标项目保存独立版本，后续修改不会自动同步。");
 expect(done).not.toHaveBeenCalled();
 await userEvent.click(screen.getByRole("combobox", { name: "目标项目" })); await userEvent.click(screen.getByRole("button", { name: "项目一" }));
 await userEvent.click(screen.getByRole("button", { name: "添加到项目并在对话中使用" }));
 expect(copy).toHaveBeenCalledTimes(1); expect(copy).toHaveBeenCalledWith(personal, "p1"); expect(done).toHaveBeenCalledWith("p1", [source("copied", "p1"), shared, own]);
});
it("keeps a stale-version error in the dialog without navigating", async () => {
 const done = vi.fn(); copy.mockRejectedValue(new Error("版本已经更新，请重试"));
 render(<SourceProjectDialog sources={[source("old", "p2")]} options={[{ id: "p1", label: "项目一" }]} onClose={() => {}} onDone={done} />);
 await userEvent.click(screen.getByRole("combobox", { name: "目标项目" })); await userEvent.click(screen.getByRole("button", { name: "项目一" })); await userEvent.click(screen.getByRole("button", { name: "添加到项目" }));
 expect(await screen.findByRole("alert")).toBeInTheDocument(); expect(done).not.toHaveBeenCalled();
});

it("uses personal material already marked cross-project available without creating a project copy", async () => {
 const personal = { ...source("personal-shared", "evimed-library", true), personal: true };
 const done = vi.fn();
 render(<SourceProjectDialog sources={[personal]} conversation options={[{ id: "p1", label: "项目一" }]} onClose={() => {}} onDone={done} />);
 expect(done).not.toHaveBeenCalled();
 await userEvent.click(screen.getByRole("combobox", { name: "目标项目" }));
 await userEvent.click(screen.getByRole("button", { name: "项目一" }));
 await userEvent.click(screen.getByRole("button", { name: "在对话中使用" }));
 expect(copy).not.toHaveBeenCalled(); expect(done).toHaveBeenCalledWith("p1", [personal]);
});

it("names a selected document with nothing to copy before copying any of the others", async () => {
 const done = vi.fn(); copy.mockResolvedValue({ source: source("copied", "p1") });
 const page = source("知识页", "p2", false, "knowledge-base/wiki/page.md"), own = source("论文", "p2");
 render(<SourceProjectDialog sources={[own, page]} options={[{ id: "p1", label: "项目一" }]} onClose={() => {}} onDone={done} />);
 await userEvent.click(screen.getByRole("combobox", { name: "目标项目" })); await userEvent.click(screen.getByRole("button", { name: "项目一" }));
 expect(screen.getByRole("alert")).toHaveTextContent("“知识页”没有可复制的原件，取消选择后再添加。");
 expect(screen.getByRole("button", { name: "添加到项目" })).toBeDisabled();
 expect(copy).not.toHaveBeenCalled(); expect(done).not.toHaveBeenCalled();
});
