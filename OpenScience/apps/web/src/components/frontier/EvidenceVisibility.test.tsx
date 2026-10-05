import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { EvidenceVisibility } from "./EvidenceVisibility";
import { zone } from "./__fixtures__/evidenceCards";

const client = vi.hoisted(() => ({ setEvidenceZoneVisibility: vi.fn() }));
vi.mock("@/lib/evidenceZoneClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceZoneClient")>()), ...client }));
beforeEach(() => vi.clearAllMocks());

describe("opening a zone to the internet", () => {
  it("explains in one line that it is not publishing, asks once, and then opens the zone", async () => {
    const onChanged = vi.fn();
    client.setEvidenceZoneVisibility.mockResolvedValue({ ...zone, visibility: "internet", revision: 4 });
    render(<EvidenceVisibility zone={zone} onChanged={onChanged} />);
    expect(screen.getByText("平台内可见")).toBeInTheDocument();
    expect(screen.getByText(/它和“发布”是分开的两步/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "公开到互联网" }));
    expect(client.setEvidenceZoneVisibility).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "公开" }));
    expect(client.setEvidenceZoneVisibility).toHaveBeenCalledWith(zone, "internet");
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ visibility: "internet" }));
  });
  it("takes an open zone back with one click", async () => {
    client.setEvidenceZoneVisibility.mockResolvedValue({ ...zone, visibility: "platform" });
    const onChanged = vi.fn();
    render(<EvidenceVisibility zone={{ ...zone, visibility: "internet" }} onChanged={onChanged} />);
    expect(screen.getByText("公开到互联网")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "取消公开" }));
    expect(client.setEvidenceZoneVisibility).toHaveBeenCalledWith(expect.objectContaining({ visibility: "internet" }), "platform");
    expect(onChanged).toHaveBeenCalled();
  });
  it("does not let a zone that is not published be opened, and says what to do first", () => {
    render(<EvidenceVisibility zone={{ ...zone, state: "draft" }} onChanged={vi.fn()} />);
    expect(screen.getByRole("button", { name: "公开到互联网" })).toBeDisabled();
    expect(screen.getByText("先发布专区，才能公开到互联网。")).toBeInTheDocument();
  });
  it("says why a refusal happened, by name, and leaves the zone as it was", async () => {
    client.setEvidenceZoneVisibility.mockRejectedValue(new WebApiError("no", { status: 409, code: "evidence_visibility_requires_publication" }));
    const onChanged = vi.fn();
    render(<EvidenceVisibility zone={zone} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole("button", { name: "公开到互联网" }));
    await userEvent.click(screen.getByRole("button", { name: "公开" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("专区先发布，才能公开到互联网");
    expect(onChanged).not.toHaveBeenCalled();
  });
});
