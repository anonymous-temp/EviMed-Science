import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import type { FileRoot } from "@ai4s/shared";
import { ArrowUp, Download, ListTree, Printer, ShieldAlert } from "lucide-react";
import type { WebAgentRun } from "@/lib/apiClient";
import { downloadArtifact } from "@/lib/artifactFile";
import { claimMatrixPathFor, claimStatuses, claimVerificationSummary } from "@/lib/claimCitations";
import { clearQuoteHighlight, highlightQuote } from "@/lib/quoteHighlight";
import { reportFacts, safetyClaimIds, type ReportFact } from "@/lib/reportMeta";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { parseFailureMessage } from "@/lib/errorText";
import { MarkdownViewer } from "@/components/markdown-viewer/MarkdownViewer";
import { ClaimEvidenceList, type ClaimReading } from "@/components/markdown-viewer/ClaimCitation";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { EvidenceMatrixTable } from "./EvidenceMatrixTable";
import { useClaimMatrix } from "./useClaimMatrix";

interface TocEntry {
  id: string;
  text: string;
  level: 2 | 3;
}

/** The report's own section on its limits, by the name the skill requires. */
const LIMITATIONS_HEADINGS = new Set(["局限性", "局限"]);

/** Tailwind's `lg`: from here the contents have a column beside the report. */
const WIDE_MEDIA = "(min-width: 1024px)";

/**
 * Whether the page is wide enough for the contents column. A media query in
 * script rather than a CSS toggle, so the page holds one table of contents —
 * the column or the folded list above the report — and never both.
 */
function useWide(): boolean {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(WIDE_MEDIA).matches);
  useEffect(() => {
    const media = window.matchMedia(WIDE_MEDIA);
    const onChange = () => setWide(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return wide;
}

/**
 * A delivered report, read (plan §5 act 4, §8.3; appendix D §10.6–§10.8).
 *
 * Above the text: when the search stopped, what the report stands on, which
 * model wrote it and what limits it declares — 「未注明」 wherever the package
 * does not say — and how many of its claims were found in their preserved
 * sources. Then any conclusion a clinical-safety finding names, with its
 * evidence open. Then the report, each sentence ending in a 依据 mark that
 * opens what it rests on; or the evidence matrix as a table. A table of
 * contents beside it, and a way out on paper: the Markdown file, or print /
 * save as PDF from a print copy on white paper whatever the theme.
 *
 * `page` is the standalone reader (`/app/runs/:runId/files/*`); `pane` is the
 * same reader in a drawer or the right pane, with the contents folded.
 */
export function ReportReader({
  path,
  root,
  text,
  run = null,
  runId = null,
  layout,
  focusClaim = null,
  highlight = null,
}: {
  path: string;
  root?: FileRoot;
  text: string;
  run?: WebAgentRun | null;
  runId?: string | null;
  layout: "page" | "pane";
  /** A claim to bring into view and open, e.g. from 「在报告中查看」 or the frame's 依据 tab. */
  focusClaim?: string | null;
  /** A quotation to find and mark in this text — a preserved source opened from a claim. */
  highlight?: string | null;
}) {
  const { document: matrix, verification, verified } = useClaimMatrix(path, root);
  const [view, setView] = useState<"report" | "matrix">("report");
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const wide = useWide();
  const articleRef = useRef<HTMLDivElement>(null);
  // Heading ids are the reader's own, so two readers on one page (a drawer
  // over the runs page, say) never share one.
  const idPrefix = `report${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const filename = path.slice(path.lastIndexOf("/") + 1);

  const safety = useMemo(() => safetyClaimIds(run?.qualityNotices), [run?.qualityNotices]);
  const reading: ClaimReading = useMemo(
    () => ({ verified, runId: runId ?? run?.id ?? null, safety, pagesRead: run?.pagesRead }),
    [verified, runId, run?.id, safety, run?.pagesRead],
  );
  const statuses = useMemo(() => claimStatuses(verification), [verification]);
  const summary = claimVerificationSummary(verification);
  const safetyInMatrix = matrix ? [...safety].filter((id) => matrix.claims.has(id)) : [];
  // The facts block belongs to a delivered report; a README has none of them.
  const isReport = claimMatrixPathFor(path) != null || matrix != null;
  const [quoteFound, setQuoteFound] = useState<boolean | null>(null);
  // The print copy exists only while printing — the button, Ctrl/⌘+P and the
  // browser menu all pass through `beforeprint` — so the page never carries
  // a second copy of the report for a screen reader to find.
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    const before = () => flushSync(() => setPrinting(true));
    const after = () => setPrinting(false);
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);

  // Headings get their ids from the page as rendered, so the contents always
  // match what is on screen, whatever the Markdown looked like.
  useEffect(() => {
    const article = articleRef.current;
    if (!article || view !== "report") return;
    const entries: TocEntry[] = [];
    article.querySelectorAll<HTMLHeadingElement>("h2, h3").forEach((heading, index) => {
      if (!heading.id) heading.id = `${idPrefix}-sec-${index + 1}`;
      const label = heading.textContent?.trim() ?? "";
      if (label) entries.push({ id: heading.id, text: label, level: heading.tagName === "H2" ? 2 : 3 });
    });
    setToc(entries);
    // `reading` too: a change to it re-renders the document's marks, and the
    // headings with them.
  }, [text, matrix, verification, reading, view, idPrefix]);

  // Which section is being read, for the contents' current mark.
  useEffect(() => {
    const article = articleRef.current;
    if (!article || toc.length === 0 || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "0px 0px -70% 0px" },
    );
    for (const entry of toc) {
      const heading = document.getElementById(entry.id);
      if (heading && article.contains(heading)) observer.observe(heading);
    }
    return () => observer.disconnect();
  }, [toc]);

  // A quotation named from a claim: find it in this source and mark it.
  useEffect(() => {
    const article = articleRef.current;
    if (!highlight || !article) {
      setQuoteFound(null);
      return;
    }
    setQuoteFound(highlightQuote(article, highlight));
    return () => clearQuoteHighlight();
    // Re-found whenever the document re-renders: a highlight holds a range
    // over text nodes, and a re-render can replace them.
  }, [highlight, text, matrix, reading]);

  // A claim named from outside: bring its sentence into view and open it.
  useEffect(() => {
    // The id is checked before it goes near a selector.
    if (!focusClaim || !/^CLM-\d{3,6}$/.test(focusClaim) || !matrix || view !== "report") return;
    const mark = articleRef.current?.querySelector<HTMLButtonElement>(`[data-claims~="${focusClaim}"]`);
    if (!mark) return;
    if (typeof mark.scrollIntoView === "function") mark.scrollIntoView({ block: "center" });
    mark.focus();
    mark.click();
    // Again once the checks arrive: the marks re-render with their verdicts.
  }, [focusClaim, matrix, verification, reading, view]);

  const limitationsTarget = toc.find((entry) => LIMITATIONS_HEADINGS.has(entry.text))?.id ?? null;
  const facts = reportFacts({ meta: matrix?.meta ?? null, claims: matrix?.claims ?? null, run, limitationsTarget, verification });

  const scrollTo = (id: string) => {
    const element = document.getElementById(id);
    if (element && typeof element.scrollIntoView === "function") element.scrollIntoView({ block: "start" });
    setActive(id);
  };

  const download = async () => {
    try {
      await downloadArtifact(path, root, filename);
    } catch (error) {
      toast.error(`无法下载 ${filename}：${parseFailureMessage(error, "该文件")}`);
    }
  };

  const contents = toc.length > 0 && (
    <nav aria-label="目录">
      <ol className="space-y-0.5 text-ui">
        {toc.map((entry) => (
          <li key={entry.id} className={entry.level === 3 ? "pl-3" : undefined}>
            <button
              type="button"
              onClick={() => scrollTo(entry.id)}
              aria-current={active === entry.id ? "location" : undefined}
              className={cn(
                "w-full truncate rounded px-2 py-1 text-left hover:bg-surface-2",
                active === entry.id ? "bg-accent-soft text-accent-strong" : entry.level === 2 ? "text-text" : "text-muted",
              )}
              title={entry.text}
            >
              {entry.text}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2" data-print-hide="">
      {matrix && (
        <SegmentedControl
          value={view}
          onChange={setView}
          aria-label="查看"
          options={[{ value: "report", label: "报告" }, { value: "matrix", label: `证据矩阵（${matrix.claims.size}）` }]}
        />
      )}
      <div className="flex-1" />
      <Button size="sm" variant="ghost" onClick={() => void download()}>
        <Download size={16} aria-hidden="true" />下载 Markdown
      </Button>
      <Button size="sm" variant="ghost" onClick={() => window.print()} title="打印，或在打印对话框里选「存为 PDF」">
        <Printer size={16} aria-hidden="true" />打印 / 存为 PDF
      </Button>
    </div>
  );

  // On a phone the page is the paper: edge to edge, 16 px sides (DESIGN.md,
  // collapsing strategy), where a card inside the page's own padding left
  // about eighteen characters a line.
  const reportPage = (
    <div className="rounded-card border border-border bg-surface px-12 py-11 max-sm:rounded-none max-sm:border-x-0 max-sm:px-4 max-sm:py-6">
      {highlight && quoteFound === true && (
        <p role="status" className="mb-6 rounded-input border border-border bg-warn-soft px-3 py-2 text-ui text-text">
          已在这份保存的原文里定位到引文，高亮处就是它。
        </p>
      )}
      {highlight && quoteFound === false && (
        <div role="note" className="mb-6 rounded-input border border-warn bg-warn-soft px-3 py-2 text-ui text-warn-strong">
          <p>这段引文没有在这份保存的原文里找到——这正是需要核对的地方：</p>
          <blockquote className="mt-1 border-l-2 border-strong pl-2 text-text">“{highlight}”</blockquote>
        </div>
      )}
      {isReport && <ReportFacts facts={facts} onJump={scrollTo} />}
      {isReport && summary && (
        <p
          role="note"
          className={cn(
            "mb-6 rounded-input border px-3 py-2 text-ui",
            summary.attention ? "border-warn bg-warn-soft text-warn-strong" : "border-border bg-accent-soft text-accent-strong",
          )}
        >
          {summary.text}
        </p>
      )}
      {matrix && safetyInMatrix.length > 0 && (
        <section aria-labelledby="report-safety" className="mb-8 rounded-input border border-danger bg-danger-soft p-4">
          <h2 id="report-safety" className="flex items-center gap-1.5 text-ui font-semibold text-danger-strong">
            <ShieldAlert size={16} aria-hidden="true" />涉及临床安全的结论 · {safetyInMatrix.length} 条
          </h2>
          <p className="mb-2 mt-1 text-caption text-text">核验在这些结论上发现了临床安全问题；它们的依据在这里展开，引用前请逐条核对。</p>
          <ClaimEvidenceList ids={safetyInMatrix} claims={matrix.claims} statuses={statuses} reading={reading} />
        </section>
      )}
      <div ref={articleRef}>
        <MarkdownViewer variant="document" claims={matrix?.claims} claimStatuses={statuses} reading={reading}>{text}</MarkdownViewer>
      </div>
    </div>
  );

  const body = view === "matrix" && matrix
    ? <EvidenceMatrixTable claims={matrix.claims} verified={verified} runId={reading.runId} className="max-sm:rounded-none max-sm:border-x-0" />
    : reportPage;

  return (
    <>
      {layout === "page" ? (
        <div className="mx-auto flex w-full max-w-content-full gap-8 px-6 py-6 max-sm:px-0 max-sm:py-3">
          {wide && view === "report" && toc.length > 0 && (
            <aside className="sticky top-4 max-h-[calc(100vh-6rem)] w-56 shrink-0 self-start overflow-y-auto" data-print-hide="">
              <p className="mb-2 flex items-center gap-1.5 px-2 text-caption font-medium text-muted"><ListTree size={16} aria-hidden="true" />目录</p>
              {contents}
              {/* A 60 KB report needs a way back up (appendix D §4.5). */}
              <button
                type="button"
                onClick={() => articleRef.current?.closest(".overflow-y-auto")?.scrollTo({ top: 0 })}
                className="mt-3 flex items-center gap-1 px-2 text-caption text-link hover:underline"
              >
                <ArrowUp size={16} aria-hidden="true" />回到顶部
              </button>
            </aside>
          )}
          <div className={cn("min-w-0 flex-1 space-y-4", view === "report" && "max-w-content")}>
            <div className="space-y-3 max-sm:px-4">
              {toolbar}
              {/* No column for them on a narrower page: the contents fold
                * above the report, as they do in the pane. */}
              {!wide && view === "report" && toc.length > 0 && (
                <Disclosure summary={<>目录 · {toc.length} 节</>} className="rounded-input border border-border bg-surface px-3 py-2">
                  {contents}
                </Disclosure>
              )}
            </div>
            {body}
          </div>
        </div>
      ) : (
        <div className="min-h-full space-y-4 px-6 py-6 max-sm:px-0 max-sm:py-3">
          <div className="mx-auto max-w-content space-y-3 max-sm:px-4">
            {toolbar}
            {view === "report" && toc.length > 0 && (
              <Disclosure summary={<>目录 · {toc.length} 节</>} className="rounded-input border border-border bg-surface px-3 py-2">
                {contents}
              </Disclosure>
            )}
          </div>
          <div className={cn("mx-auto", view === "report" ? "max-w-content" : "max-w-none")}>{body}</div>
        </div>
      )}
      {printing && <PrintCopy facts={isReport ? facts : []} text={text} matrix={matrix} statuses={statuses} reading={reading} />}
    </>
  );
}

/** The four facts a reader weighs before the first sentence, 「未注明」 where the package is silent. */
function ReportFacts({ facts, onJump }: { facts: ReportFact[]; onJump: (id: string) => void }) {
  return (
    <dl className="mb-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-b border-border pb-5 text-ui">
      {facts.map((fact) => (
        <div key={fact.label} className="contents">
          <dt className="text-muted">{fact.label}</dt>
          <dd className={cn("min-w-0 break-words", fact.missing ? "text-muted" : "text-text")}>
            {fact.target ? (
              <button type="button" onClick={() => onJump(fact.target!)} className="min-h-6 text-left text-link hover:underline">
                {fact.value}
              </button>
            ) : fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * What the printer gets: the facts and the report, on white paper whatever
 * the theme (`data-theme="light"` re-scopes the tokens), each 依据 mark a
 * plain word. Hidden on screen; the print stylesheet hides everything else.
 */
function PrintCopy({ facts, text, matrix, statuses, reading }: {
  facts: ReportFact[];
  text: string;
  matrix: ReturnType<typeof useClaimMatrix>["document"];
  statuses: Map<string, string>;
  reading: ClaimReading;
}) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div data-print-root="" data-theme="light" aria-hidden="true" className="hidden bg-surface text-text print:block">
      <dl className="mb-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-ui">
        {facts.map((fact) => (
          <div key={fact.label} className="contents">
            <dt className="text-muted">{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
      <MarkdownViewer variant="document" claims={matrix?.claims} claimStatuses={statuses} reading={{ ...reading, print: true }}>{text}</MarkdownViewer>
    </div>,
    document.body,
  );
}
