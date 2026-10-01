import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZoneEditor, CardEditor } from "./EvidenceEditors";
import type { EvidenceCard } from "@/lib/evidenceZoneClient";
const client = vi.hoisted(() => ({
  saveEvidenceZone: vi.fn(),
  saveEvidenceCard: vi.fn(),
}));
vi.mock("@/lib/evidenceZoneClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/evidenceZoneClient")>()),
  ...client,
}));
beforeEach(() => vi.clearAllMocks());
describe("zone editor", () => {
  it("keeps text on save failure and reuses request ID on unchanged retry", async () => {
    client.saveEvidenceZone.mockRejectedValue(new Error("conflict"));
    render(
      <MemoryRouter>
        <ZoneEditor onSaved={vi.fn()} onCancel={vi.fn()} />
      </MemoryRouter>,
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: "专区名称" }),
      "急诊",
    );
    await userEvent.click(screen.getByRole("button", { name: "保存专区" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "专区名称" })).toHaveValue(
      "急诊",
    );
    const requestId = client.saveEvidenceZone.mock.calls[0][2];
    await userEvent.click(screen.getByRole("button", { name: "保存专区" }));
    expect(client.saveEvidenceZone.mock.calls[1][2]).toBe(requestId);
  });
  it("does not act on a late save after unmount", async () => {
    let resolve: (value: unknown) => void = () => {};
    client.saveEvidenceZone.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const saved = vi.fn();
    const view = render(
      <MemoryRouter>
        <ZoneEditor onSaved={saved} onCancel={vi.fn()} />
      </MemoryRouter>,
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: "专区名称" }),
      "急诊",
    );
    await userEvent.click(screen.getByRole("button", { name: "保存专区" }));
    view.unmount();
    resolve({ id: "zone" });
    await Promise.resolve();
    expect(saved).not.toHaveBeenCalled();
  });
});
describe("card content editing", () => {
  it("preserves scientific tables and updates the answer when an existing card is edited", async () => {
    const card = {
      id: "card",
      zoneId: "zone",
      title: "Question",
      subtype: "academic",
      summary: "Original answer",
      body: "Original text",
      limitations: "Limit",
      sources: [
        {
          title: "Paper",
          url: "https://example.org",
          excerpt: "Quote",
          coverage: "abstract",
          sha256: "retained-hash",
        },
      ],
      content: {
        question: "Question",
        answer: "Original answer",
        population: "Adults",
        tables: [
          {
            title: "Evidence",
            columns: ["Outcome", "Result"],
            rows: [["Stroke", "1.27%/year"]],
            sourceIndexes: [1],
          },
        ],
      },
    } as EvidenceCard;
    client.saveEvidenceCard.mockResolvedValue(card);
    const saved = vi.fn();
    render(
      <MemoryRouter>
        <CardEditor
          zoneId="zone"
          card={card}
          onSaved={saved}
          onCancel={vi.fn()}
        />
      </MemoryRouter>,
    );
    const answer = screen.getByRole("textbox", { name: "核心回答" });
    await userEvent.clear(answer);
    await userEvent.type(answer, "Updated answer");
    await userEvent.click(screen.getByRole("button", { name: "保存证据" }));
    expect(client.saveEvidenceCard).toHaveBeenCalledWith(
      "zone",
      expect.objectContaining({
        summary: "Updated answer",
        content: expect.objectContaining({
          answer: "Updated answer",
          population: "Adults",
          tables: card.content!.tables,
        }),
      }),
      card,
      expect.any(String),
    );
    expect(saved).toHaveBeenCalledWith(card);
  });
  it("keeps structured source links attached to the right paper when another source is removed", async () => {
    const card = {
      id: "card",
      title: "Question",
      subtype: "knowledge",
      summary: "Answer",
      body: "Evidence",
      limitations: "",
      sources: [
        { title: "First", url: "https://example.org/1", excerpt: "Quote 1" },
        { title: "Second", url: "https://example.org/2", excerpt: "Quote 2" },
      ],
      content: {
        question: "Question",
        answer: "Answer",
        population: "Adults",
        tables: [
          {
            title: "Evidence",
            columns: ["Result"],
            rows: [["Finding"]],
            sourceIndexes: [2],
          },
        ],
      },
    } as EvidenceCard;
    client.saveEvidenceCard.mockResolvedValue(card);
    render(
      <MemoryRouter>
        <CardEditor
          zoneId="zone"
          card={card}
          onSaved={vi.fn()}
          onCancel={vi.fn()}
        />
      </MemoryRouter>,
    );
    await userEvent.click(
      screen.getAllByRole("button", { name: "移除此来源" })[0],
    );
    expect(screen.getByRole("textbox", { name: "表 1 来源编号" })).toHaveValue(
      "1",
    );
    await userEvent.click(screen.getByRole("button", { name: "保存证据" }));
    expect(
      client.saveEvidenceCard.mock.calls[0][1].content.tables[0].sourceIndexes,
    ).toEqual([1]);
    expect(client.saveEvidenceCard.mock.calls[0][1].sources[0].title).toBe(
      "Second",
    );
  });
});
