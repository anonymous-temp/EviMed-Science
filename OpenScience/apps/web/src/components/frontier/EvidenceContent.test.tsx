import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EvidenceCard } from "@/lib/evidenceZoneClient";
import { EvidenceReading, evidenceDay } from "./EvidenceReading";
import { EvidenceReviews } from "./EvidenceDiscussion";
import { evidenceSourceId } from "./EvidenceContent";
/** The article and what readers made of it, which the reading page keeps in two places. */
const Full = ({ evidence }: { evidence: EvidenceCard }) => (
  <>
    <EvidenceReading evidence={evidence} />
    <EvidenceReviews evidence={evidence} />
  </>
);
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
    // The question is the page's title, not a heading of the article.
    expect(
      screen.queryByRole("heading", { name: "What does this trial show?" }),
    ).not.toBeInTheDocument();
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
  // R29, 2026-10-10: whether the AI has reviewed a card, and whether that review is current, is the pipeline's bookkeeping; the card's
  // findings are its content. The user peer review line stays: it is about what readers have said.
  it("does not say whether the AI has reviewed the card, current or stale, and keeps the line about readers' reviews", () => {
    const editorial: NonNullable<EvidenceCard["editorial"]> = {
      author: { kind: "ai", name: "EviMed writer" },
      reviewer: null,
      status: "review-pending",
      reviewRevision: 2,
    };
    const gone = [/当前内容待重新评议/, /当前内容已完成 AI 评议/, /AI 待评议/, /AI 已评议/];
    const view = render(<Full evidence={{ ...card, editorial }} />);
    expect(screen.getByText("AI 编写 · EviMed writer")).toBeInTheDocument();
    expect(screen.getByText("尚无当前内容的用户评议")).toBeInTheDocument();
    for (const pattern of gone) expect(screen.queryByText(pattern)).not.toBeInTheDocument();
    view.rerender(
      <Full
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
    for (const pattern of gone) expect(screen.queryByText(pattern)).not.toBeInTheDocument();
    expect(screen.queryByText("AI reviewer")).not.toBeInTheDocument();
  });
  it("says nothing of a source refresh that did not happen, keeps the card's own reading date, and keeps the AI's findings", () => {
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
    const view = render(<Full evidence={{
      ...card,
      editorial,
      sources: [...card.sources, { title: "Second source", url: "https://example.org/second", excerpt: "New reading", checkedAt: attemptedAt }],
    }} />);
    const retained = view.container.querySelector(`#${evidenceSourceId(card.id, 1)}`)!;
    // The maintenance pipeline's bookkeeping (what it read when, what it kept from last time) is not on the page.
    for (const pattern of [/上次成功读取于/, /尝试于/, /本轮未能重新读取/, /沿用上次保留内容/, /部分来源本轮尚未完成复核/, /当前内容已完成 AI 评议/])
      expect(view.container.textContent).not.toMatch(pattern);
    expect(view.container.querySelector(`#${evidenceSourceId(card.id, 2)}`)).not.toHaveTextContent("读取于");
    expect(screen.getByText(/全部来源上次核查于/)).toHaveTextContent(evidenceDay(checkedAt));
    expect(screen.getByText("AI review remains about the scientific content")).toBeInTheDocument();
    expect(screen.queryByText(/web_read_unreadable/)).not.toBeInTheDocument();
    for (const link of screen.getAllByRole("link", { name: "查看来源 1" }))
      expect(view.container.querySelector(link.getAttribute("href")!)).toBe(retained);
    view.rerender(<Full evidence={{ ...card, editorial: { ...editorial, sourceChecks: [{ sourceIndex: 1, status: "checked", attemptedAt }] } }} />);
    expect(screen.queryByText(/未能重新读取|当前内容已完成 AI 评议/)).not.toBeInTheDocument();
  });
  it("draws nothing for a deferred or missing-link source check", () => {
    const attemptedAt = "2026-10-02T06:00:00Z";
    const editorial: NonNullable<EvidenceCard["editorial"]> = {
      author: { kind: "ai", name: "Writer" },
      reviewer: null,
      status: "review-pending",
      reviewRevision: null,
      sourceChecks: [{ sourceIndex: 1, status: "retained", attemptedAt, code: "evidence_source_check_deferred" }],
    };
    const view = render(<EvidenceReading evidence={{ ...card, editorial }} />);
    expect(view.container.textContent).not.toMatch(/本轮尚未核查|缺少原文链接|记录于|尝试于|未能重新读取|沿用上次保留内容/);
    view.rerender(<EvidenceReading evidence={{ ...card, editorial: {
      ...editorial,
      sourceChecks: [{ sourceIndex: 1, status: "retained", attemptedAt, code: "evidence_source_url_missing" }],
    } }} />);
    expect(view.container.textContent).not.toMatch(/本轮尚未核查|缺少原文链接|记录于|尝试于|未能重新读取|沿用上次保留内容/);
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

it('publication notices warn readers and cannot display a current AI review endorsement',()=>{
  const editorial: NonNullable<EvidenceCard['editorial']>={author:{kind:'ai',name:'AI writer'},reviewer:{kind:'ai',name:'Old AI reviewer'},status:'ai-reviewed',reviewRevision:card.revision};
  render(<Full evidence={{...card,editorial,sources:card.sources.map(source=>({...source,publicationStatus:{kind:'retracted',notices:['Synthetic journal retraction notice']}}))}}/>);
  expect(screen.getByRole('alert')).toHaveTextContent('原有结论需要重新核查');
  expect(screen.getByText('Synthetic journal retraction notice')).toBeInTheDocument();
  expect(screen.queryByText('AI 已评议')).not.toBeInTheDocument();
  expect(screen.queryByText('当前内容已完成 AI 评议')).not.toBeInTheDocument();
  expect(screen.queryByText(/当前内容待重新评议|AI 待评议/)).not.toBeInTheDocument();
});


it("shows an account revision history alongside the original AI author without claiming human review", () => {
  const editedAt="2026-10-01T12:00:00Z";
  render(<EvidenceReading evidence={{...card,editorial:{
    author:{kind:"ai",name:"Original evidence AI",model:"synthetic-test"},
    reviewer:null,status:"review-pending",reviewRevision:null,
    lastEditor:{userId:"alice",name:"Alice",editedAt},
  }}}/>);
  expect(screen.getByText(/AI 编写 · Original evidence AI/)).toBeInTheDocument();
  expect(screen.getByText(`用户修订记录 · Alice · ${evidenceDay(editedAt)}`)).toBeInTheDocument();
  expect(screen.queryByText(/人工评议|医生|已完成 AI 评议|AI 待评议/)).not.toBeInTheDocument();
});
