import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import type { ResultVersion } from "@/lib/resultProvenance";
import type { FileRoot } from "@ai4s/shared";
import { Download, Printer, ShieldAlert } from "lucide-react";
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
import { Menu } from "@/components/ui/Menu";
import { Outline, useOutline } from "@/components/ui/Outline";
import { Tabs } from "@/components/ui/Tabs";
import { STICKY_BELOW_BAND } from "@/components/layout/chrome";
import { List } from "@/components/ui/ListRow";
import { useContainerNarrow } from "@/lib/useContainerNarrow";
import { useWide } from "@/lib/useMediaQuery";
import { EvidenceMatrixTable } from "./EvidenceMatrixTable";
import { SourceCardList, sourceCardEntries } from "./SourceCards";
import { useClaimMatrix } from "./useClaimMatrix";

const OUTLINE_PAGE_MIN = 880;
const SOURCES_PAGE_MIN = 1096;

/**
 * Component: ReportReader; owner: H; rules: DS11, DS22.1, DS22.2, AT22/24/30.
 * Anatomy: Report/matrix toolbar, document, outline, and recorded evidence.
 * Variants: Addressed reader or embedded pane; print has a separate copy.
 * States: Recorded verification, pending/error states and immutable-version availability remain distinct.
 * Hit area: Shared tabs, disclosure, export menu and source jump button.
 * Keyboard: Outline navigates the document; jumping to sources also transfers focus.
 * Long content: Reading measure, folded outline and full source cards in document flow.
 * Theme: Existing paper surface, ink and semantic verification roles.
 * Responsive: The addressed reader adds columns only when its measured width supports them.
 * Verification: ReportReader.test.tsx and the non-GEO reading walkthrough.
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
  immutableVersion,
  onDownload,
  sourceRunId,
  externalExportActions = false,
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
  /** Historical bytes may only read evidence captured for the same version. */
  immutableVersion?: ResultVersion;
  /** A scoped reader supplies its authorized bytes; it never falls back to another workspace. */
  onDownload?: () => void | Promise<void>;
  /** Null suppresses ordinary workspace source links outside a scoped result grant. */
  sourceRunId?: string | null;
  /** An enclosing inspector owns the combined export menu and print action. */
  externalExportActions?: boolean;
}) {
  // Pictures a report names by relative path are read from its own folder in this workspace. A historical version or a scoped
  // reader has bytes of its own and never reaches for the live workspace.
  const assetBase = useMemo(() => (immutableVersion || onDownload ? undefined : { path, root }), [immutableVersion, onDownload, path, root]);
  const { document: matrix, verification, verified, verificationState, retry: retryChecks } = useClaimMatrix(path, root, !immutableVersion, immutableVersion);
  const [view, setView] = useState<"report" | "matrix">("report");
  const wide = useWide();
  const pageRef = useRef<HTMLDivElement>(null);
  const sourcesRef = useRef<HTMLDivElement>(null);
  const outlineNarrow = useContainerNarrow(pageRef, OUTLINE_PAGE_MIN);
  const sourcesNarrow = useContainerNarrow(pageRef, SOURCES_PAGE_MIN);
  const articleRef = useRef<HTMLDivElement>(null);
  // Heading ids are the reader's own, so two readers on one page (a drawer
  // over the runs page, say) never share one.
  const idPrefix = `report${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const filename = path.slice(path.lastIndexOf("/") + 1);

  const safety = useMemo(() => safetyClaimIds(run?.qualityNotices), [run?.qualityNotices]);
  const reading: ClaimReading = useMemo(
    () => ({ verified, runId: sourceRunId !== undefined ? sourceRunId : runId ?? run?.id ?? immutableVersion?.producer.runId ?? null, safety, pagesRead: run?.pagesRead }),
    [verified, runId, run?.id, immutableVersion?.producer.runId, safety, run?.pagesRead, sourceRunId],
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

  // The contents are read off the page as rendered, so they always match what is on screen, whatever the Markdown looked like.
  // `reading` re-renders the document's marks, and the headings with them.
  const { entries: toc, active, select: scrollTo } = useOutline(articleRef, {
    enabled: view === "report",
    idPrefix,
    refresh: [text, matrix, verification, reading],
  });

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

  const facts = reportFacts({ meta: matrix?.meta ?? null, run });
  const sources = useMemo(() => layout === "page" && matrix ? sourceCardEntries(matrix.claims.values(), verified) : [], [layout, matrix, verified]);
  const outlineColumn = wide && !outlineNarrow && view === "report";
  const sourcesColumn = wide && !sourcesNarrow && view === "report" && sources.length > 0;
  const sourceCards = matrix && <SourceCardList claims={matrix.claims} verified={verified} runId={reading.runId} className="mt-8 border-t border-border pt-6" />;

  const download = async () => {
    try {
      if (onDownload) await onDownload();
      else if (immutableVersion) {
        const { readResultBytes, saveResultBlob } = await import("@/lib/resultProvenance");
        saveResultBlob(await readResultBytes(immutableVersion), filename);
      } else await downloadArtifact(path, root, filename);
    } catch (error) {
      toast.error(`无法下载 ${filename}：${parseFailureMessage(error, "该文件")}`);
    }
  };

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2" data-print-hide="">
      {matrix && (
        <Tabs
          label="查看"
          value={view}
          onChange={setView}
          items={[{ value: "report", label: "报告" }, { value: "matrix", label: "证据矩阵", count: matrix.claims.size }]}
          className="border-b-0"
        />
      )}
      <div className="flex-1" />
      {!externalExportActions && <Menu label="导出与打印" items={[
        { label: "下载 Markdown", icon: Download, onSelect: () => void download() },
        { label: "打印 / 存为 PDF", icon: Printer, onSelect: () => window.print() },
      ]}><Button size="md" variant="text">导出与打印</Button></Menu>}
    </div>
  );

  // On a phone the page is the paper: edge to edge, 16 px sides (DESIGN.md,
  // collapsing strategy), where a card inside the page's own padding left
  // about eighteen characters a line.
  const reportPage = (
    <div className="rounded-card border border-border bg-surface px-12 py-11 max-sm:rounded-none max-sm:border-x-0 max-sm:px-4 max-sm:py-6">
      {/* A located quotation is its own highlight; only a miss is said. */}
      {highlight && quoteFound === false && (
        <div role="note" className="mb-6 text-ui text-warn-strong">
          <p>⚠ 未找到这段引文</p>
          <blockquote className="mt-1 border-l-2 border-strong pl-2 text-text">“{highlight}”</blockquote>
        </div>
      )}
      {isReport && <ReportFacts facts={facts} onJump={scrollTo} />}
      {immutableVersion && !matrix && <p role="note" className="mb-6 text-ui text-verify-pending">此版本尚无可读取的逐句证据核对记录。</p>}
      {isReport && summary && (
        <p role="note" className="mb-6 text-ui text-verify-pending">{summary.text}</p>
      )}
      {matrix && safetyInMatrix.length > 0 && (
        <section aria-labelledby="report-safety" className="mb-8 rounded-card bg-danger-soft p-4">
          <h2 id="report-safety" className="mb-2 flex items-center gap-1.5 text-ui font-semibold text-danger-strong">
            <ShieldAlert size={16} aria-hidden="true" />涉及临床安全的结论 · {safetyInMatrix.length} 条
          </h2>
          <ClaimEvidenceList ids={safetyInMatrix} claims={matrix.claims} statuses={statuses} reading={reading} />
        </section>
      )}
      <div ref={articleRef} data-result-rendered={immutableVersion ? "" : undefined}>
        <MarkdownViewer variant="document" claims={matrix?.claims} claimStatuses={statuses} reading={reading} assetBase={assetBase}>{text}</MarkdownViewer>
      </div>
      {/* The sources the report stands on, as cards (融合方案 §8.3): what kind
        * of study each is, whether its quotation is in it, and whether it has
        * since been retracted — none of which a numbered reference list can
        * say. The report's own 参考文献 prose stays where the writer put it. */}
      {layout === "page" && sources.length > 0 ? <div ref={sourcesRef} tabIndex={-1} className="scroll-mt-4">{sourceCards}</div> : sourceCards}
    </div>
  );

  const body = view === "matrix" && matrix
    ? (
      <EvidenceMatrixTable
        claims={matrix.claims}
        verified={verified}
        verificationState={verificationState}
        onRetry={immutableVersion ? undefined : retryChecks}
        runId={reading.runId}
        ground={layout === "pane" ? "surface-2" : "bg"}
        className="max-sm:rounded-none max-sm:border-x-0"
      />
    )
    : reportPage;

  return (
    <>
      {layout === "page" ? (
        <div ref={pageRef} className="mx-auto w-full max-w-wide space-y-4 py-3 sm:py-6">
          <div className="border-b border-border pb-3">{toolbar}</div>
          <div className="flex items-start justify-center gap-6">
            {outlineColumn && <Outline layout="column" className="w-40" entries={toc} active={active} onSelect={scrollTo} onTop={() => articleRef.current?.closest(".overflow-y-auto")?.scrollTo({ top: 0 })} />}
            <div className={cn("min-w-0 flex-1 space-y-4", view === "report" && "max-w-read")}>
              {!outlineColumn && view === "report" && <Outline layout="folded" entries={toc} active={active} onSelect={scrollTo} />}
              {body}
            </div>
            {sourcesColumn && (
              <aside aria-label="报告来源摘要" data-print-hide="" className={cn("sticky w-52 shrink-0 space-y-3 border-l border-border pl-4", STICKY_BELOW_BAND)}>
                <h2 className="text-ui font-semibold text-text">来源 · {sources.length}</h2>
                <List divided className="border-y border-border">
                  {sources.slice(0, 3).map((source) => (
                    <li key={source.key} className="break-words py-2 text-ui text-text-2">
                      {source.title}
                      {(source.journal || source.year) && <p className="mt-1 text-caption text-text-3">{[source.journal, source.year].filter(Boolean).join(" · ")}</p>}
                    </li>
                  ))}
                </List>
                <Button variant="text" size="sm" className="text-link" onClick={() => {
                  sourcesRef.current?.scrollIntoView?.({ block: "start" });
                  sourcesRef.current?.focus({ preventScroll: true });
                }}>查看全部来源</Button>
              </aside>
            )}
          </div>
        </div>
      ) : (
        <div className="min-h-full space-y-4 px-6 py-6 max-sm:px-0 max-sm:py-3">
          <div className="mx-auto max-w-read space-y-3 max-sm:px-4">
            {toolbar}
            {view === "report" && <Outline layout="folded" entries={toc} active={active} onSelect={scrollTo} />}
          </div>
          <div className={cn("mx-auto", view === "report" ? "max-w-read" : "max-w-none")}>{body}</div>
        </div>
      )}
      {printing && <PrintCopy facts={isReport ? facts : []} text={text} matrix={matrix} statuses={statuses} reading={reading} assetBase={assetBase} />}
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
function PrintCopy({ facts, text, matrix, statuses, reading, assetBase }: {
  facts: ReportFact[];
  text: string;
  matrix: ReturnType<typeof useClaimMatrix>["document"];
  statuses: Map<string, string>;
  reading: ClaimReading;
  assetBase?: { path: string; root?: FileRoot };
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
      <MarkdownViewer variant="document" claims={matrix?.claims} claimStatuses={statuses} reading={{ ...reading, print: true }} assetBase={assetBase}>{text}</MarkdownViewer>
    </div>,
    document.body,
  );
}
