import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZoneEditor } from "./EvidenceEditors";
const client = vi.hoisted(() => ({ saveEvidenceZone: vi.fn() }));
vi.mock("@/lib/evidenceZoneClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceZoneClient")>()), ...client }));
beforeEach(() => vi.clearAllMocks());
describe("zone editor", () => {
  it("keeps text on save failure and reuses request ID on unchanged retry", async () => {
    client.saveEvidenceZone.mockRejectedValue(new Error("conflict")); render(<MemoryRouter><ZoneEditor onSaved={vi.fn()} onCancel={vi.fn()} /></MemoryRouter>);
    await userEvent.type(screen.getByRole("textbox", { name: "专区名称" }), "急诊"); await userEvent.click(screen.getByRole("button", { name: "保存专区" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument(); expect(screen.getByRole("textbox", { name: "专区名称" })).toHaveValue("急诊"); const requestId = client.saveEvidenceZone.mock.calls[0][2];
    await userEvent.click(screen.getByRole("button", { name: "保存专区" })); expect(client.saveEvidenceZone.mock.calls[1][2]).toBe(requestId);
  });
  it("does not act on a late save after unmount", async () => {
    let resolve: (value: unknown) => void = () => {}; client.saveEvidenceZone.mockImplementation(() => new Promise(done => { resolve = done; })); const saved = vi.fn();
    const view = render(<MemoryRouter><ZoneEditor onSaved={saved} onCancel={vi.fn()} /></MemoryRouter>); await userEvent.type(screen.getByRole("textbox", { name: "专区名称" }), "急诊"); await userEvent.click(screen.getByRole("button", { name: "保存专区" })); view.unmount(); resolve({ id: "zone" }); await Promise.resolve(); expect(saved).not.toHaveBeenCalled();
  });
});
