import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArticleTextDialog } from "./ArticleTextDialog";
import { MembersDialog } from "./MembersDialog";
import { ProducerDialog } from "./ProducerDialog";
import { BudgetDialog } from "./tabs/BudgetDialog";

const client = vi.hoisted(() => ({
  getGeoMembers: vi.fn(),
  patchGeoProject: vi.fn(),
  setGeoBudget: vi.fn(),
  getGeoArticleText: vi.fn(),
}));
vi.mock("@/lib/geoClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/geoClient")>()), ...client }));

/**
 * The four dialogs the module drew by hand — a 12 px card on `z-50`, each with its own focus trap — are `FormDialog`s now (R13 V-4,
 * design reference §10.6): a 16 px panel on the `modal` tier, one Escape, one backdrop, one corner 关闭, and no way out while a
 * write is in flight.
 */
beforeEach(() => {
  vi.clearAllMocks();
  client.getGeoMembers.mockResolvedValue({ members: [], you: { roles: ["viewer"], abilities: ["read"] } });
  client.getGeoArticleText.mockResolvedValue({ markdown: "稿件正文" });
  client.patchGeoProject.mockResolvedValue({});
  client.setGeoBudget.mockResolvedValue({});
});

const dialogs: Array<[string, string, (close: () => void) => React.ReactElement]> = [
  ["成员", "成员", (close) => <MembersDialog geoId="geo_1" onClose={close} />],
  ["出品方", "出品方", (close) => <ProducerDialog geoId="geo_1" initial={null} onSaved={() => {}} onCancel={close} />],
  ["设置投放预算", "设置投放预算", (close) => <BudgetDialog geoId="geo_1" initial={null} suggestedTotal={1000} onSaved={() => {}} onCancel={close} />],
  ["稿件", "证据卡片", (close) => <ArticleTextDialog geoId="geo_1" articleId="a_1" title="证据卡片" onClose={close} />],
];

describe.each(dialogs)("%s", (_, name, make) => {
  it("is a 16 px panel on the modal tier, with one corner 关闭, and the first Escape closes it", async () => {
    const close = vi.fn();
    render(make(close));
    const dialog = await screen.findByRole("dialog", { name });
    expect(dialog).toHaveClass("rounded-panel", "shadow-e3");
    expect(dialog.parentElement).toHaveClass("z-modal");
    expect(dialog.parentElement?.className).not.toMatch(/\bz-\d/);
    expect(screen.getAllByRole("button", { name: "关闭" })).toHaveLength(1);
    await userEvent.keyboard("{Escape}");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes on a click on the backdrop and on the corner 关闭", async () => {
    const close = vi.fn();
    render(make(close));
    const dialog = await screen.findByRole("dialog", { name });
    await userEvent.click(dialog.parentElement!);
    expect(close).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(close).toHaveBeenCalledTimes(2);
  });
});

describe("a write in flight", () => {
  it("cannot be closed out from under the budget being saved, and then closes when it has settled", async () => {
    let settle: () => void = () => {};
    client.setGeoBudget.mockReturnValue(new Promise<void>((resolve) => { settle = resolve; }));
    const cancel = vi.fn();
    render(<BudgetDialog geoId="geo_1" initial={null} suggestedTotal={1000} onSaved={() => {}} onCancel={cancel} />);
    await screen.findByRole("dialog", { name: "设置投放预算" });
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(client.setGeoBudget).toHaveBeenCalled());
    await userEvent.keyboard("{Escape}");
    expect(cancel).not.toHaveBeenCalled();
    settle();
  });

  it("holds the producer's Escape while it is being saved", async () => {
    client.patchGeoProject.mockReturnValue(new Promise(() => {}));
    const cancel = vi.fn();
    render(<ProducerDialog geoId="geo_1" initial={null} onSaved={() => {}} onCancel={cancel} />);
    await screen.findByRole("dialog", { name: "出品方" });
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(client.patchGeoProject).toHaveBeenCalled());
    await userEvent.keyboard("{Escape}");
    expect(cancel).not.toHaveBeenCalled();
  });
});
