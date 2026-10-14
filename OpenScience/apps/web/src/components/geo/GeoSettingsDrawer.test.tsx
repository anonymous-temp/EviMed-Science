import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GEO_PROJECT } from "./__fixtures__/geoProjects";
import { GeoSettingsDrawer } from "./GeoSettingsDrawer";

const client = vi.hoisted(() => ({ patchGeoProject: vi.fn() }));
vi.mock("@/lib/geoClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/geoClient")>()), ...client }));

const project = { ...GEO_PROJECT };

function renderDrawer(overrides: Partial<typeof project> = {}) {
  const handlers = { onClose: vi.fn(), onOpen: vi.fn(), onChanged: vi.fn() };
  const view = render(<GeoSettingsDrawer geoId="geo_masi" project={{ ...project, ...overrides }} {...handlers} />);
  return { ...view, ...handlers, drawer: () => screen.getByRole("dialog", { name: "项目设置" }) };
}

beforeEach(() => {
  client.patchGeoProject.mockReset().mockResolvedValue({});
});

describe("项目设置", () => {
  it("reads the five settings, each in its own row", () => {
    const { drawer } = renderDrawer();
    const rows = within(drawer()).getAllByRole("region").map((row) => row.getAttribute("aria-label"));
    expect(rows).toEqual(["测量的 AI 引擎", "覆盖周期", "投放预算", "出品方", "成员"]);
    expect(within(drawer()).getByRole("button", { name: "豆包" })).toHaveAttribute("aria-pressed", "true");
    expect(within(drawer()).getByText("8,000 灵豆 · 每天最多 800 灵豆")).toBeInTheDocument();
  });

  it("writes the engines the person chose, once, with 保存 — and not before", async () => {
    const { drawer, onChanged } = renderDrawer();
    expect(within(drawer()).queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
    await userEvent.click(within(drawer()).getByRole("button", { name: "Kimi" }));
    await userEvent.click(within(drawer()).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(client.patchGeoProject).toHaveBeenCalledWith("geo_masi", { engines: ["doubao", "qianwen", "deepseek", "yuanbao"] }));
    expect(onChanged).toHaveBeenCalled();
  });

  it("will not save a project with no engine to measure", async () => {
    const { drawer } = renderDrawer({ engines: ["doubao"] });
    await userEvent.click(within(drawer()).getByRole("button", { name: "豆包" }));
    expect(within(drawer()).getByRole("button", { name: "保存" })).toBeDisabled();
  });

  it("writes the coverage window the person chose", async () => {
    const { drawer } = renderDrawer();
    const group = within(drawer()).getByRole("group", { name: "覆盖周期" });
    await userEvent.click(within(group).getByRole("button", { name: "180 天" }));
    await userEvent.click(within(drawer()).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(client.patchGeoProject).toHaveBeenCalledWith("geo_masi", { coverageDays: 180 }));
  });

  it("offers the budget, the producer and the members as the dialogs they are: the drawer closes and the dialog opens", async () => {
    const { drawer, onClose, onOpen } = renderDrawer();
    await userEvent.click(within(drawer()).getAllByRole("button", { name: "修改" })[0]);
    expect(onClose).toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith("budget");
    await userEvent.click(within(drawer()).getAllByRole("button", { name: "修改" })[1]);
    expect(onOpen).toHaveBeenLastCalledWith("producer");
    await userEvent.click(within(drawer()).getByRole("button", { name: "管理" }));
    expect(onOpen).toHaveBeenLastCalledWith("members");
  });

  it("says a budget not set, and where no market is connected asks for none", () => {
    const set = renderDrawer({ budget: null });
    expect(within(set.drawer()).getByText("还没有设")).toBeInTheDocument();
    expect(within(set.drawer()).getByRole("button", { name: "设置" })).toBeInTheDocument();
    set.unmount();
    const off = renderDrawer({ budget: null, market: { configured: false } });
    expect(within(off.drawer()).getByText("等媒介集市接通")).toBeInTheDocument();
    expect(within(off.drawer()).queryByRole("button", { name: "设置" })).not.toBeInTheDocument();
  });

  it("is read-only for a viewer: nothing to change, the members to look at", () => {
    const { drawer } = renderDrawer({ access: { roles: ["viewer"], abilities: ["read"], owner: false } });
    expect(within(drawer()).getByRole("button", { name: "豆包" })).toBeDisabled();
    expect(within(drawer()).queryByRole("button", { name: "修改" })).not.toBeInTheDocument();
    expect(within(drawer()).queryByRole("group", { name: "覆盖周期" })).not.toBeInTheDocument();
    expect(within(drawer()).getByRole("button", { name: "查看" })).toBeInTheDocument();
  });
});
