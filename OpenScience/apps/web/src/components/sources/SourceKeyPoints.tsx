import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { sourcePageForOffset } from "@evimed/domain";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { Tooltip } from "@/components/ui/Tooltip";
import { LoadError } from "@/components/cards/LoadError";
import { formatDay } from "@/lib/format";
import { productErrorMessage } from "@/lib/productClient";
import {
  getSourceFamily, getSourceMaterials, getSourceUnderstanding, sourceFailureMessage,
  type SourceAnchor, type SourceFamily, type SourceRecord, type SourceUnderstanding, type SourceUnderstandingResult,
} from "@/lib/sourceClient";
import { coverageGap, materialEntries, type MaterialEntry, type SourceMaterialsStructure } from "@/lib/sourceMaterials";
import { labelFor } from "@/lib/statusLabel";
import { DatasetMeaningPanel } from "./DatasetMeaningPanel";
import { isReading } from "./sourceView";

/** The most key points a document page lists: what the document says, not everything it says. */
const KEY_POINTS = 8;
/** How many tables and figures are listed before 「显示全部」. */
const MATERIALS_SHOWN = 6;

/** The study slots of a paper, as a researcher names them. Only a paper has them, and only the ones it states are shown. */
const SLOT_LABELS: Record<string, string> = {
  design: "研究设计", population: "研究人群", interventionExposure: "干预或暴露", outcomes: "研究终点",
  effectEstimates: "效应估计", doi: "DOI", limitations: "局限",
};
const PAPER_SLOTS = ["design", "population", "interventionExposure", "outcomes", "effectEstimates", "doi"];

/** The pages a claim rests on, in order, from where its anchors fall in the text. */
function pagesOf(anchors: readonly SourceAnchor[], pageMap: SourceUnderstandingResult["pageMap"]): number[] {
  const pages = anchors.map((anchor) => sourcePageForOffset(pageMap, anchor.start)).filter((page): page is number => page != null);
  return [...new Set(pages)].sort((left, right) => left - right).slice(0, 2);
}

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The right column of a document's page: what the document says, in the order a researcher asks for it (design
 * reference §13.1, 「要点栏的顺序」), and only from what the control plane already holds:
 *
 *  1. the one-line gist — the same sentence the list row has (the summary's first);
 *  2. for a paper, what it is (who wrote it, where, and the study's design, people, intervention, endpoints, effect, DOI) —
 *     only what it states;
 *  3. up to eight key points, each with the page it rests on — a page of a PDF opens that page of the original;
 *  4. one sentence on what was not read, only when something was not (`coverageGap`); a document is never said to be
 *     understood because its file is there;
 *  5. its tables and figures, with their pages;
 *  6. under folds: the whole summary, and the versions before this one.
 *
 * A table has its data's meaning (`DatasetMeaningPanel`) where the key points would be. There is no 「包含什么」 or
 * 「局限」 and no 「用过它的对话」: the reading has no fields for the first two and nothing records the third, and a sentence
 * cut out of the summary to fill a slot is not a field.
 */
export function SourceKeyPoints({ source, busy, versionPath, onShowPage, onRetry }: {
  source: SourceRecord;
  busy: boolean;
  /** The address of the page of another version of this document. */
  versionPath: (sourceId: string) => string;
  onShowPage: (page: number) => void;
  onRetry: () => void;
}) {
  const [detail, setDetail] = useState<SourceUnderstandingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { generation, currentUnderstandingId, status, familyId } = source.payload;
  useEffect(() => {
    let active = true;
    setError(null);
    getSourceUnderstanding(source.id).then(
      (value) => { if (active) setDetail(value); },
      (failure) => { if (active) setError(`无法加载内容：${productErrorMessage(failure)}`); },
    );
    return () => { active = false; };
  }, [source.id, generation, currentUnderstandingId, status, attempt]);

  // The tables and figures are asked for only where the ledger says there are some. They are an addition: a read that
  // fails leaves the rest of the column as it is.
  const table = source.display.kind === "table";
  const ledger = source.payload.coverage?.materials;
  const wantsMaterials = !table && !!ledger && !ledger.unavailable && (ledger.tables?.total ?? 0) + (ledger.figures?.total ?? 0) > 0;
  const [structure, setStructure] = useState<SourceMaterialsStructure | null>(null);
  useEffect(() => {
    setStructure(null);
    if (!wantsMaterials) return undefined;
    let active = true;
    getSourceMaterials(source.id).then(
      (result) => { if (active) setStructure(result.materials?.structure ?? null); },
      () => { /* the list of tables and figures is left out; nothing else depends on it */ },
    );
    return () => { active = false; };
  }, [source.id, generation, wantsMaterials]);

  const [family, setFamily] = useState<SourceFamily | null>(null);
  useEffect(() => {
    setFamily(null);
    if (!familyId) return undefined;
    let active = true;
    getSourceFamily(source.id).then(
      (value) => { if (active) setFamily(value); },
      () => { /* the earlier versions are left out */ },
    );
    return () => { active = false; };
  }, [source.id, familyId, currentUnderstandingId]);

  const meaning = table ? (
    <DatasetMeaningPanel projectId={source.projectId} path={source.payload.paths[0] ?? ""} sha256={source.payload.fingerprint?.sha256 ?? null} />
  ) : null;
  if (error) return <LoadError message={error} onRetry={() => setAttempt((value) => value + 1)} />;
  if (!detail) {
    return <div role="status" aria-label="正在加载内容" className="animate-pulse space-y-2"><div className="h-4 w-2/3 rounded bg-surface-2" /><div className="h-4 w-full rounded bg-surface-2" /><div className="h-4 w-1/2 rounded bg-surface-2" /></div>;
  }
  const current = detail.current;
  const versions = <Versions source={source} family={family} versionPath={versionPath} />;
  if (!current) {
    if (isReading(source)) return <div className="space-y-6"><p className="text-ui text-text-3">正在读取</p>{meaning}</div>;
    if (status === "failed" || status === "needs_attention") {
      return (
        <div className="space-y-6">
          <div className="space-y-3">
            <p className="max-w-measure text-ui text-text-2">{sourceFailureMessage(source.payload.error) ?? "这份资料没能读取。"}</p>
            <Button variant="secondary" disabled={busy} onClick={onRetry}>重新读取</Button>
          </div>
          {meaning}
          {versions}
        </div>
      );
    }
    const gap = coverageGap(source.payload.coverage);
    return (
      <div className="space-y-6">
        {meaning ?? <p className="text-ui text-text-3">没有可以显示的内容。</p>}
        {gap && <Gap>{gap}</Gap>}
        {versions}
      </div>
    );
  }
  return (
    <Understood source={source} understanding={current} pageMap={detail.pageMap ?? null} meaning={meaning}
      entries={materialEntries(structure)} versions={versions} onShowPage={onShowPage} />
  );
}

function Understood({ source, understanding, pageMap, meaning, entries, versions, onShowPage }: {
  source: SourceRecord; understanding: SourceUnderstanding; pageMap: SourceUnderstandingResult["pageMap"]; meaning: ReactNode;
  entries: MaterialEntry[]; versions: ReactNode; onShowPage: (page: number) => void;
}) {
  const metadata = source.payload.metadata;
  const literature = source.display.kind === "literature";
  const table = source.display.kind === "table";
  const rows: Array<[string, string]> = [];
  if (literature) {
    const authors = metadata?.authors?.filter(Boolean) ?? [];
    if (authors.length > 0) rows.push(["作者", `${authors.slice(0, 3).join("、")}${authors.length > 3 ? " 等" : ""}`]);
    const year = metadata?.publicationDate?.match(/\d{4}/)?.[0] ?? "";
    const published = [metadata?.source?.trim(), year].filter(Boolean).join(" ");
    if (published) rows.push(["发表", published]);
  }
  for (const key of PAPER_SLOTS) {
    const slot = understanding.slots[key];
    if (slot?.state === "known") rows.push([labelFor(SLOT_LABELS, key, "其他"), slot.value]);
  }
  const openable = source.display.format === "pdf";
  const gist = source.display.gist;
  const summary = understanding.summary.trim();
  const gap = coverageGap(source.payload.coverage);
  return (
    <div className="space-y-6 text-ui text-text">
      {gist ? <Section title="讲了什么"><p className="max-w-measure-body">{gist}</p></Section>
        : summary ? <Section title="讲了什么"><p className="max-w-measure-body whitespace-pre-wrap">{summary}</p></Section> : null}
      {table && gap && <Gap>{gap}</Gap>}
      {rows.length > 0 && (
        <Section title="研究信息">
          <dl className="space-y-2">
            {rows.map(([name, value]) => (
              <div key={name} className="flex gap-3">
                <dt className="w-24 shrink-0 text-text-3">{name}</dt>
                <dd className="min-w-0 max-w-measure whitespace-pre-wrap">{value}</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}
      {table ? meaning : (
        understanding.claims.length > 0 && (
          <Section title="要点">
            <ol className="space-y-3">
              {understanding.claims.slice(0, KEY_POINTS).map((claim, index) => (
                <li key={claim.id} className="flex gap-2">
                  <span className="w-5 shrink-0 text-text-3 tabular-nums">{index + 1}.</span>
                  <span className="min-w-0 max-w-measure">
                    {claim.statement}
                    <PageRefs pages={pagesOf(claim.evidence, pageMap)} openable={openable} onShowPage={onShowPage} />
                  </span>
                </li>
              ))}
            </ol>
          </Section>
        )
      )}
      {!table && gap && <Gap>{gap}</Gap>}
      {entries.length > 0 && <MaterialList entries={entries} openable={openable} onShowPage={onShowPage} />}
      {gist && summary && flat(summary) !== flat(gist) && (
        <Disclosure summary="完整摘要"><p className="max-w-measure-body whitespace-pre-wrap text-text-2">{summary}</p></Disclosure>
      )}
      {versions}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-caption text-text-3">{title}</h3>
      {children}
    </section>
  );
}

/** What was not read, in one sentence; it is there only when something was not. */
function Gap({ children }: { children: string }) {
  return <p data-reader-gap="" className="max-w-measure-body text-text-2">{children}</p>;
}

/** The pages an entry rests on: a link that opens that page of a PDF original, or the page in plain words where there is no page to open on. */
function PageRefs({ pages, openable, onShowPage }: { pages: readonly number[]; openable: boolean; onShowPage: (page: number) => void }) {
  return (
    <>
      {pages.map((page) => openable
        ? <Button key={page} variant="text" size="sm" className="ml-1 px-1 text-accent" onClick={() => onShowPage(page)}>第 {page} 页</Button>
        : <span key={page} className="ml-2 text-text-3">第 {page} 页</span>)}
    </>
  );
}

/** 「表格与图」: each with the page the page job placed it on; the first few, and the rest on request. */
function MaterialList({ entries, openable, onShowPage }: { entries: MaterialEntry[]; openable: boolean; onShowPage: (page: number) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? entries : entries.slice(0, MATERIALS_SHOWN);
  return (
    <Section title="表格与图">
      <ul className="space-y-2">
        {shown.map((entry) => (
          <li key={entry.key} className="flex items-baseline gap-1">
            <Tooltip content={entry.label} kind="label" whenTruncated><span className="min-w-0 truncate">{entry.label}</span></Tooltip>
            <span className="shrink-0"><PageRefs pages={entry.pages.slice(0, 2)} openable={openable} onShowPage={onShowPage} /></span>
          </li>
        ))}
      </ul>
      {entries.length > shown.length && <Button variant="text" size="sm" onClick={() => setAll(true)}>显示全部 {entries.length} 项</Button>}
    </Section>
  );
}

/** The versions before this one, folded; and, for an old version, the way to the newest. */
function Versions({ source, family, versionPath }: { source: SourceRecord; family: SourceFamily | null; versionPath: (sourceId: string) => string }) {
  if (!family || family.items.length < 2) return null;
  const mine = Number(source.payload.version) || 0;
  const versionOf = (item: SourceRecord) => Number(item.payload.version) || 0;
  const older = family.items.filter((item) => item.id !== source.id && versionOf(item) < mine);
  const newest = family.items.find((item) => versionOf(item) > mine);
  if (!newest && older.length === 0) return null;
  return (
    <div className="space-y-3">
      {newest && (
        <p className="text-caption text-text-3">
          这不是最新的版本。<Link to={versionPath(newest.id)} className="text-link hover:underline">打开最新版本</Link>
        </p>
      )}
      {older.length > 0 && (
        <Disclosure summary={`以前的版本（${older.length}）`}>
          <ul className="space-y-1">
            {older.map((item) => (
              <li key={item.id}>
                <Link to={versionPath(item.id)} className="text-link hover:underline">第 {versionOf(item)} 版 · {formatDay(item.createdAt)}</Link>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}
