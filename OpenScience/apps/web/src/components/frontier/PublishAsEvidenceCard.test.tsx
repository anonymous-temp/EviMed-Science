import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import type { ResultVersion } from "@/lib/resultProvenance";
import { PublishAsEvidenceCard, defaultClaimSelection, isClinicalPackage } from "./PublishAsEvidenceCard";
import { card, zone } from "./__fixtures__/evidenceCards";

const client = vi.hoisted(() => ({ listOwnUserZones: vi.fn(), publishResultAsEvidenceCard: vi.fn() }));
vi.mock("@/lib/evidenceZoneClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceZoneClient")>()), ...client }));

const matrix = JSON.stringify({ claims: [
  { claimId: "CLM-001", claim: "卒中更少。" },
  { claimId: "CLM-002", claim: "出血减半。" },
  { claimId: "CLM-003", claim: "约少 50 例。", claimType: "derived" },
] });
const version = { versionId: `rv_${"a".repeat(64)}`, projectId: "stroke", path: "deliverables/d1/clinical-evidence-report.md",
  review: { status: "available", matrixVersionId: `rv_${"b".repeat(64)}`, matrixText: matrix, verification: { claims: [
    { claimId: "CLM-001", claimType: "direct", status: "verified", sources: [] },
    { claimId: "CLM-002", claimType: "direct", status: "quote_not_found", sources: [] },
    { claimId: "CLM-003", claimType: "derived", status: "derived", sources: [] },
  ] } } } as unknown as ResultVersion;
function Probe() { const location = useLocation(); return <pre data-testid="where">{location.pathname + location.search}</pre>; }
const mount = (value = version, onClose = vi.fn()) => render(<MemoryRouter><PublishAsEvidenceCard version={value} onClose={onClose} /><Probe /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  client.listOwnUserZones.mockResolvedValue([zone, { ...zone, id: "ez_2", title: "肾脏研究" }]);
  client.publishResultAsEvidenceCard.mockResolvedValue({ evidence: card, zone, created: true, outcome: "created", previousCardId: null, omitted: [] });
});

describe("publishing a result as an evidence card", () => {
  it("knows a clinical package by the matrix its capture recorded", () => {
    expect(isClinicalPackage(version)).toBe(true);
    expect(isClinicalPackage({ review: undefined })).toBe(false);
    expect(isClinicalPackage({ review: { status: "unknown" } })).toBe(false);
  });
  it("starts with the ✓ claims selected and the ⚠ ones and the estimates not", async () => {
    mount();
    const boxes = await screen.findAllByRole("checkbox");
    expect(boxes.map((box) => (box as HTMLInputElement).checked)).toEqual([true, false, false]);
    expect(defaultClaimSelection([{ claimId: "a", text: "", claimType: "direct", status: "verified" }, { claimId: "b", text: "", claimType: "direct", status: "no_quote" }])).toEqual(["a"]);
    expect(screen.getByLabelText("已核验")).toHaveTextContent("✓");
    expect(screen.getByText("生成的是草稿，发布由你自己决定。")).toBeInTheDocument();
  });
  it("lists the researcher's own zones, offers a new one, and sends exactly the selection to the chosen zone", async () => {
    mount();
    const zoneSelect = await screen.findByRole("combobox");
    expect(Array.from((zoneSelect as HTMLSelectElement).options).map((option) => option.text)).toEqual(["卒中研究", "肾脏研究", "新建专区"]);
    await userEvent.click(screen.getAllByRole("checkbox")[1]);
    await userEvent.selectOptions(zoneSelect, "ez_2");
    await userEvent.click(screen.getByRole("button", { name: "生成证据卡草稿" }));
    expect(client.publishResultAsEvidenceCard).toHaveBeenCalledWith(version.versionId, { projectId: "stroke", zoneId: "ez_2", claimIds: ["CLM-001", "CLM-002"] });
    // The draft opens in the card editor.
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(`/app/frontier/zones/ez_1/evidence/${card.id}?edit=1`));
  });
  it("makes a new zone when the researcher has none, with a name", async () => {
    client.listOwnUserZones.mockResolvedValue([]);
    mount();
    const name = await screen.findByLabelText("新专区的名称");
    await userEvent.clear(name);
    expect(screen.getByRole("button", { name: "生成证据卡草稿" })).toBeDisabled();
    await userEvent.type(name, "我的卒中研究");
    await userEvent.click(screen.getByRole("button", { name: "生成证据卡草稿" }));
    expect(client.publishResultAsEvidenceCard).toHaveBeenCalledWith(version.versionId, { projectId: "stroke", newZone: { title: "我的卒中研究" }, claimIds: ["CLM-001"] });
  });
  it("cannot be sent with no claim selected", async () => {
    mount();
    await userEvent.click((await screen.findAllByRole("checkbox"))[0]);
    expect(screen.getByRole("button", { name: "生成证据卡草稿" })).toBeDisabled();
  });
  it("says why a request was refused, by name, and keeps the choices", async () => {
    client.publishResultAsEvidenceCard.mockRejectedValue(new WebApiError("refused", { status: 409, code: "evidence_result_zone_kind_refused" }));
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "生成证据卡草稿" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("研究结果只能发布到用户专区");
    expect(screen.getAllByRole("checkbox")[0]).toBeChecked();
    expect(screen.getByRole("button", { name: "生成证据卡草稿" })).toBeEnabled();
    expect(screen.getByTestId("where")).toHaveTextContent("/");
  });
  it("shows a zones read that failed with a retry, and the loading state before it", async () => {
    client.listOwnUserZones.mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce([zone]);
    mount();
    expect(screen.getByText("正在读取你的专区")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("操作未完成");
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("combobox")).toBeInTheDocument();
  });
  it("publishes the server's own selection when the result's claims cannot be listed", async () => {
    mount({ ...version, review: { status: "unavailable", matrixVersionId: `rv_${"b".repeat(64)}` } } as unknown as ResultVersion);
    expect(await screen.findByText("这个结果的结论列表暂时读不到，将发布其中已核验的结论。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "生成证据卡草稿" }));
    expect(client.publishResultAsEvidenceCard).toHaveBeenCalledWith(version.versionId, { projectId: "stroke", zoneId: "ez_1" });
  });
  it("closes without sending anything", async () => {
    const onClose = vi.fn();
    mount(version, onClose);
    await userEvent.click(await screen.findByRole("button", { name: "取消" }));
    expect(onClose).toHaveBeenCalled();
    expect(client.publishResultAsEvidenceCard).not.toHaveBeenCalled();
  });
});
