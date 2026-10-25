import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { GeoScopeDialog } from "./GeoScopeDialog";
import { GEO_PROJECT } from "./__fixtures__/geoProjects";
const client = vi.hoisted(() => ({ getGeoQuestions: vi.fn().mockResolvedValue({ sets: [], groups: [] }) }));
vi.mock("@/lib/geoClient", async original => ({ ...await original<typeof import("@/lib/geoClient")>(), ...client }));
beforeEach(() => client.getGeoQuestions.mockReset().mockResolvedValue({ sets: [], groups: [] }));

describe("GEO analytical range form", () => {
  it("shows selected historical groups beside the full catalog and lets the reader remove them", async () => {
    const user = userEvent.setup(); const apply = vi.fn();
    client.getGeoQuestions.mockImplementation(async (_id, scope) => ({ sets: [], groups: typeof scope === "object"
      ? [{ id: "old", name: "历史问题群", questions: [{ clientTags: [" 高龄 "] }] }]
      : [{ id: "new", name: "当前问题群", questions: [] }] }));
    render(<MemoryRouter><GeoScopeDialog geoId="g" project={GEO_PROJECT} initial={{ from: "2026-10-01", groupIds: ["old"] }} onApply={apply} onClose={vi.fn()} /></MemoryRouter>);
    const old = await screen.findByRole("button", { name: "历史问题群" });
    expect(old).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByRole("button", { name: "当前问题群" })).toBeVisible();
    await user.click(old); await user.click(screen.getByRole("button", { name: "高龄" }));
    await user.click(screen.getByRole("button", { name: "应用范围" }));
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ groupIds: [], from: "2026-10-01", clientTags: [" 高龄 "] }));
  });
  it("reads a frozen selection alone while keeping its resolved range editable", async () => {
    const apply = vi.fn();
    render(<MemoryRouter><GeoScopeDialog geoId="g" project={GEO_PROJECT} initial={{ selectionRef: "saved", from: "2026-10-01", groupIds: ["old"] }} onApply={apply} onClose={vi.fn()} /></MemoryRouter>);
    await waitFor(() => expect(client.getGeoQuestions).toHaveBeenCalledWith("g", { selectionRef: "saved" }));
    expect(screen.getByLabelText("回答开始日期")).toHaveValue("2026-10-01");
    expect(screen.getByRole("button", { name: "已选择的问题群 1" })).toHaveAttribute("aria-pressed", "true");
  });
  it("applies multi-platform/date choices together and removes a stale frozen reference", async () => {
    const user = userEvent.setup(); const apply = vi.fn();
    render(<MemoryRouter><GeoScopeDialog geoId="g" project={GEO_PROJECT} initial={{ selectionRef: "old", engines: ["deepseek"] }} onApply={apply} onClose={vi.fn()} /></MemoryRouter>);
    await user.type(screen.getByLabelText("回答开始日期"), "2026-10-01");
    await user.type(screen.getByLabelText("回答结束日期"), "2026-10-02");
    await user.click(screen.getByRole("button", { name: "豆包" }));
    await user.click(screen.getByRole("button", { name: "应用范围" }));
    await waitFor(() => expect(apply).toHaveBeenCalledWith(expect.objectContaining({ from: "2026-10-01", to: "2026-10-02", engines: ["deepseek", "doubao"], selectionRef: undefined })));
  });
  it("requires two comparison endpoints and a real timezone without mutating the project", async () => {
    const user = userEvent.setup(); const apply = vi.fn();
    render(<MemoryRouter><GeoScopeDialog geoId="g" project={GEO_PROJECT} initial={{ compareFrom: "2026-10-01" }} onApply={apply} onClose={vi.fn()} /></MemoryRouter>);
    await user.click(screen.getByRole("button", { name: "应用范围" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("完整的对比区间"); expect(apply).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("对比结束日期"), "2026-10-02");
    await user.clear(screen.getByLabelText("日期时区")); await user.type(screen.getByLabelText("日期时区"), "invalid");
    await user.click(screen.getByRole("button", { name: "应用范围" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("有效时区"); expect(apply).not.toHaveBeenCalled();
  });
});
