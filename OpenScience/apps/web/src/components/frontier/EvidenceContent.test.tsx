import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EvidenceCard } from "@/lib/evidenceZoneClient";
import { EvidenceReading, evidenceDate } from "./EvidenceReading";
import { evidenceSourceId } from "./EvidenceContent";
const card: EvidenceCard = {
  id: "sample",
  zoneId: "zone",
  revision: 3,
  state: "published",
  canEdit: false,
  canResearch: false,
  title: "Trial",
  subtype: "academic",
  body: "Original body",
  summary: "Old summary",
  creator: null,
  reviewer: null,
  reviewedAt: null,
  claims: [],
  sources: [
    {
      title: "Primary trial",
      url: "https://example.org/trial",
      excerpt: "Original trial result",
      coverage: "abstract",
      checkedAt: "2026-10-01T00:00:00Z",
    },
  ],
  limitations: "Not studied in dialysis",
  discussion: [],
  review: null,
  content: {
    question: "What does this trial show?",
    answer: "An answer with uncertainty",
    population: "Adults with CKD",
    context: "Trial participants and observation period",
    nextStep: "Check applicability",
    comparisons: [
      {
        title: "Primary outcome",
        outcome: "Events",
        denominator: 2152,
        timeframe: "Trial observation; median 2.4 years",
        control: { label: "Placebo", events: 312 },
        intervention: { label: "Treatment", events: 197 },
        sourceIndexes: [1],
        relativeEffect: "HR 0.61 (95% CI 0.51–0.72)",
        note: "Counts during observation, not fixed-horizon risks",
      },
    ],
    tables: [
      {
        title: "Trial evidence",
        columns: ["Group", "Events / participants"],
        rows: [
          ["Treatment", "197 / 2152"],
          ["Placebo", "312 / 2152"],
        ],
        sourceIndexes: [1],
        caption: "Original event counts",
      },
    ],
  },
};
describe("question-based evidence content", () => {
  it("shows the answer, applicable population, original counts and traceable sources", () => {
    const { container } = render(<EvidenceReading evidence={card} />);
    expect(
      screen.getByRole("heading", { name: "What does this trial show?" }),
    ).toBeInTheDocument();
    expect(screen.getByText("An answer with uncertainty")).toBeInTheDocument();
    expect(screen.queryByText("Old summary")).not.toBeInTheDocument();
    expect(
      screen.getByText("Adults with CKD", { exact: false }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("table", { name: /Trial evidence/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("197 / 2152")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /Treatment.*2,152.*197/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Counts during observation, not fixed-horizon risks"),
    ).toBeInTheDocument();
    for (const link of screen.getAllByRole("link", { name: "查看来源 1" }))
      expect(
        container.querySelector(link.getAttribute("href")!),
      ).toHaveTextContent("Primary trial");
    expect(screen.getByText(/依据摘要/)).toBeInTheDocument();
  });
  it("labels annualized rates as person-years and never fixed-period person risk", () => {
    render(
      <EvidenceReading
        evidence={{
          ...card,
          content: {
            ...card.content!,
            tables: [],
            comparisons: [
              {
                title: "Annualized rate",
                outcome: "Stroke",
                measure: "rate",
                denominatorUnit: "person-years",
                denominator: 100,
                timeframe: "Annualized trial event rate",
                control: { label: "Warfarin", events: 1.6 },
                intervention: { label: "Apixaban", events: 1.27 },
                sourceIndexes: [1],
              },
            ],
          },
        }}
      />,
    );
    expect(
      screen.getByRole("img", { name: /Apixaban.*100 人年.*1.27 次/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("1.27 次 / 100 人年")).toBeInTheDocument();
    expect(screen.queryByText(/NNT/)).not.toBeInTheDocument();
  });
  it("keeps pending and stale AI review distinct from user peer review", () => {
    const editorial: NonNullable<EvidenceCard["editorial"]> = {
      author: { kind: "ai", name: "EviMed writer" },
      reviewer: null,
      status: "review-pending",
      reviewRevision: 2,
    };
    const view = render(<EvidenceReading evidence={{ ...card, editorial }} />);
    expect(screen.getByText("AI 编写 · EviMed writer")).toBeInTheDocument();
    expect(screen.getByText("当前内容待重新评议")).toBeInTheDocument();
    expect(screen.getByText("尚无当前内容的用户评议")).toBeInTheDocument();
    view.rerender(
      <EvidenceReading
        evidence={{
          ...card,
          editorial: {
            ...editorial,
            status: "ai-reviewed",
            reviewer: { kind: "ai", name: "AI reviewer" },
          },
        }}
      />,
    );
    expect(
      screen.queryByText("当前内容已完成 AI 评议"),
    ).not.toBeInTheDocument();
    view.rerender(
      <EvidenceReading
        evidence={{
          ...card,
          editorial: {
            ...editorial,
            status: "ai-reviewed",
            reviewer: { kind: "ai", name: "AI reviewer" },
            reviewRevision: 3,
          },
        }}
      />,
    );
    expect(screen.getByText("当前内容已完成 AI 评议")).toBeInTheDocument();
  });
  it("separates unsuccessful source refresh from the retained reading date and current AI review", () => {
    const checkedAt = "2026-10-01T00:00:00Z";
    const attemptedAt = "2026-10-02T06:00:00Z";
    const editorial: NonNullable<EvidenceCard["editorial"]> = {
      author: { kind: "ai", name: "Writer" },
      reviewer: { kind: "ai", name: "Reviewer" },
      status: "ai-reviewed",
      reviewRevision: card.revision,
      sourceCheckedAt: checkedAt,
      sourceChecks: [
        { sourceIndex: 1, status: "retained", attemptedAt, code: "web_read_unreadable" },
        { sourceIndex: 2, status: "checked", attemptedAt },
      ],
      findings: [{ kind: "coverage", text: "AI review remains about the scientific content" }],
    };
    const view = render(<EvidenceReading evidence={{
      ...card,
      editorial,
      sources: [...card.sources, { title: "Second source", url: "https://example.org/second", excerpt: "New reading", checkedAt: attemptedAt }],
    }} />);
    const retained = view.container.querySelector(`#${evidenceSourceId(card.id, 1)}`)!;
    expect(retained).toHaveTextContent(`上次成功读取于 ${evidenceDate(checkedAt)}`);
    expect(retained).toHaveTextContent(`尝试于 ${evidenceDate(attemptedAt)}`);
    expect(within(retained as HTMLElement).getByText(/本轮未能重新读取/)).toBeInTheDocument();
    expect(view.container.querySelector(`#${evidenceSourceId(card.id, 2)}`)).not.toHaveTextContent("未能重新读取");
    expect(screen.getByText(/全部来源上次核查于/)).toHaveTextContent(evidenceDate(checkedAt));
    expect(screen.getByText(/部分来源本轮尚未完成复核/)).toBeInTheDocument();
    expect(screen.getByText("当前内容已完成 AI 评议")).toBeInTheDocument();
    expect(screen.getByText("AI review remains about the scientific content")).toBeInTheDocument();
    expect(screen.queryByText(/web_read_unreadable/)).not.toBeInTheDocument();
    for (const link of screen.getAllByRole("link", { name: "查看来源 1" }))
      expect(view.container.querySelector(link.getAttribute("href")!)).toBe(retained);
    view.rerender(<EvidenceReading evidence={{ ...card, editorial: { ...editorial, sourceChecks: [{ sourceIndex: 1, status: "checked", attemptedAt }] } }} />);
    expect(screen.queryByText(/未能重新读取/)).not.toBeInTheDocument();
    expect(screen.getByText("当前内容已完成 AI 评议")).toBeInTheDocument();
  });
  it("does not describe deferred or missing-link source checks as attempted reads", () => {
    const attemptedAt = "2026-10-02T06:00:00Z";
    const editorial: NonNullable<EvidenceCard["editorial"]> = {
      author: { kind: "ai", name: "Writer" },
      reviewer: null,
      status: "review-pending",
      reviewRevision: null,
      sourceChecks: [{ sourceIndex: 1, status: "retained", attemptedAt, code: "evidence_source_check_deferred" }],
    };
    const view = render(<EvidenceReading evidence={{ ...card, editorial }} />);
    expect(screen.getByText(/本轮尚未核查/)).toHaveTextContent(`记录于 ${evidenceDate(attemptedAt)}`);
    expect(screen.queryByText(/尝试于|未能重新读取/)).not.toBeInTheDocument();
    view.rerender(<EvidenceReading evidence={{ ...card, editorial: {
      ...editorial,
      sourceChecks: [{ sourceIndex: 1, status: "retained", attemptedAt, code: "evidence_source_url_missing" }],
    } }} />);
    expect(screen.getByText(/缺少原文链接/)).toHaveTextContent(`记录于 ${evidenceDate(attemptedAt)}`);
    expect(screen.queryByText(/尝试于|未能重新读取/)).not.toBeInTheDocument();
  });
  it("omits exact answer duplication and preserves supplementary and legacy prose", () => {
    const content = {
      question: "Question",
      answer: "Answer",
      population: "Adults",
      sections: [{ title: "Finding", text: "Exact finding" }],
    };
    const view = render(
      <EvidenceReading
        evidence={{
          ...card,
          content,
          body: "Answer",
        }}
      />,
    );
    expect(screen.getAllByText("Answer")).toHaveLength(1);
    expect(screen.getAllByText("Exact finding")).toHaveLength(1);
    view.rerender(
      <EvidenceReading
        evidence={{
          ...card,
          content,
          body: "Answer\nAdults\n### Finding\nExact finding\nUnique appended note",
        }}
      />,
    );
    expect(screen.getByText(/Unique appended note/)).toBeInTheDocument();
    view.rerender(
      <EvidenceReading
        evidence={{ ...card, content, body: "A separate study-design note" }}
      />,
    );
    expect(
      screen.getByText("A separate study-design note"),
    ).toBeInTheDocument();
    view.rerender(
      <EvidenceReading
        evidence={{ ...card, content: null, body: "Legacy article" }}
      />,
    );
    expect(screen.getByText("Legacy article")).toBeInTheDocument();
  });
});
