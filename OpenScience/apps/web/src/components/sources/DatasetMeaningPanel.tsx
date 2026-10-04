import { useCallback, useEffect, useState } from "react";
import { semanticFacts } from "@evimed/domain";
import { getWebProjectId } from "@/lib/apiClient";
import { confirmDatasetMeaning, getDatasetMeaning, listDatasetMeanings, type DatasetMeaning, type DatasetMeaningAsset } from "@/lib/dataSemanticsClient";
import { basisLabel, facetLabel, factSource, factText, findingSubject, notCheckedLabel, outcomeLabel, type SemanticFactSummary } from "@/lib/dataSemanticsView";
import { productErrorMessage } from "@/lib/productClient";
import { formatClock, formatDay } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { Tag } from "@/components/ui/Tag";
import { LoadError } from "@/components/cards/LoadError";

/**
 * 数据含义: what this project knows about a data file, beside the file — which parts the researcher confirmed,
 * which a data dictionary states, which the assistant only inferred, and what the last check of a new delivery
 * found. The meaning is the one the next analysis of the same data starts from, so a wrong unit seen here is a
 * wrong unit everywhere; the correction is said in the conversation, where the researcher's words are kept, and
 * the one thing this page does is confirm what it shows.
 *
 * It renders nothing at all for a file no analysis has recorded a meaning for — there is no empty state to
 * explain: the knowledge base is not a dataset catalogue until a dataset analysis makes it one.
 */
export function DatasetMeaningPanel({ projectId, path, sha256 }: { projectId: string; path: string; sha256?: string | null }) {
  const [ids, setIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let disposed = false;
    setIds([]); setError(null);
    void listDatasetMeanings(projectId).then((page) => {
      if (disposed || getWebProjectId() !== projectId) return;
      // This file is a dataset when a recorded table was read from these bytes, or from this path (an earlier delivery of it).
      setIds(page.items.filter((item) => item.tables.some((table) => (sha256 && table.sha256 === sha256) || table.path === path)).map((item) => item.datasetId));
    }).catch((failure: unknown) => { if (!disposed) setError(`无法加载数据含义：${productErrorMessage(failure)}`); });
    return () => { disposed = true; };
  }, [projectId, path, sha256, attempt]);

  if (error) return <LoadError message={error} onRetry={() => setAttempt((value) => value + 1)} />;
  return <>{ids.map((datasetId) => <DatasetMeaningView key={datasetId} projectId={projectId} datasetId={datasetId} path={path} sha256={sha256 ?? null} />)}</>;
}

function DatasetMeaningView({ projectId, datasetId, path, sha256 }: { projectId: string; datasetId: string; path: string; sha256: string | null }) {
  const [meaning, setMeaning] = useState<DatasetMeaning | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let disposed = false;
    void getDatasetMeaning(projectId, datasetId).then((value) => { if (!disposed && getWebProjectId() === projectId) { setMeaning(value); setError(null); } })
      .catch((failure: unknown) => { if (!disposed) setError(`无法加载数据含义：${productErrorMessage(failure)}`); });
    return () => { disposed = true; };
  }, [projectId, datasetId, attempt]);

  const confirmInferred = useCallback(async (targets: string[]) => {
    setBusy(true);
    try { await confirmDatasetMeaning(projectId, datasetId, targets); setAttempt((value) => value + 1); }
    catch (failure) { setError(`没能确认：${productErrorMessage(failure)}`); }
    finally { setBusy(false); }
  }, [projectId, datasetId]);

  if (error) return <LoadError message={error} onRetry={() => setAttempt((value) => value + 1)} />;
  if (!meaning) return <div role="status" aria-label="正在加载数据含义" className="animate-pulse space-y-2"><div className="h-4 w-1/2 rounded bg-surface-2" /><div className="h-4 w-full rounded bg-surface-2" /></div>;
  const asset = meaning.asset;
  const inferred = semanticFacts(asset as Parameters<typeof semanticFacts>[0]).filter((item) => item.fact.basis === "model_inferred").map((item) => item.target);
  const binding = asset.bindings.find((candidate) => candidate.path === path) ?? asset.bindings.find((candidate) => sha256 && candidate.sha256 === sha256);
  const outdated = Boolean(binding && sha256 && binding.sha256 !== sha256);
  const { summary } = meaning;
  return (
    <section className="space-y-4 text-ui text-text" aria-label="数据含义">
      <div className="space-y-2">
        <h3 className="font-semibold">数据含义{asset.title ? ` · ${asset.title}` : ""}</h3>
        {outdated && <p className="max-w-measure font-medium">这份文件不是记录含义时读的那一版，下面的含义可能已不适用，先核对再用。</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Tag>{`你已确认 ${summary.researcherConfirmed}`}</Tag>
          {summary.dictionaryStated > 0 && <Tag>{`数据字典所述 ${summary.dictionaryStated}`}</Tag>}
          <Tag>{`模型推断 ${summary.modelInferred}`}</Tag>
          {inferred.length > 0 && <Button size="sm" variant="secondary" loading={busy} onClick={() => void confirmInferred(inferred)}>确认以上推断</Button>}
        </div>
        <DatasetFacts facts={asset.facts} />
      </div>
      {asset.tables.map((table) => (
        <Disclosure key={table.name} summary={`${table.name}（${table.variables.length} 个变量）`} summaryClassName="text-text" defaultOpen={asset.tables.length === 1}>
          <div className="space-y-4 pl-5">
            <DatasetFacts facts={table.facts} />
            {table.variables.map((variable) => (
              <div key={variable.name} className="space-y-1">
                <p className="font-medium">{variable.name}</p>
                <DatasetFacts facts={variable.facts} />
              </div>
            ))}
          </div>
        </Disclosure>
      ))}
      {asset.joins.length > 0 && (
        <div className="space-y-2">
          <h4 className="font-medium">表间关联</h4>
          {asset.joins.map((join) => (
            <div key={join.id} className="space-y-1">
              <p>{`${join.left.table}（${join.left.columns.join("、")}）→ ${join.right.table}（${join.right.columns.join("、")}）`}</p>
              <DatasetFacts facts={join.facts} />
            </div>
          ))}
        </div>
      )}
      <LastCheck asset={asset} />
    </section>
  );
}

function DatasetFacts({ facts }: { facts: Record<string, SemanticFactSummary> }) {
  const entries = Object.entries(facts);
  if (!entries.length) return null;
  return (
    <dl className="space-y-1">
      {entries.map(([facet, fact]) => {
        const source = factSource(fact);
        return (
          <div key={facet} className="max-w-measure">
            <div className="flex flex-wrap items-baseline gap-2">
              <dt className="text-text-3">{facetLabel(facet)}</dt>
              <dd className="min-w-0 break-words">{factText(facet, fact.value)}</dd>
              <Tag>{basisLabel(fact.basis)}</Tag>
            </div>
            {source && <p className="text-caption text-text-3">{source}</p>}
            {fact.contested?.map((other, index) => (
              <p key={index} className="text-caption text-text-3">{`${basisLabel(other.basis)}另有判断：${factText(facet, other.value)}，没有采用`}</p>
            ))}
          </div>
        );
      })}
    </dl>
  );
}

/** What the last check of a delivery found, in the words of its outcomes, and which checks did not run. */
function LastCheck({ asset }: { asset: DatasetMeaningAsset }) {
  const check = asset.lastCheck;
  if (!check) return null;
  const when = `${formatDay(check.checkedAt)} ${formatClock(check.checkedAt)}`.trim();
  return (
    <div className="space-y-2">
      <h4 className="font-medium">{`最近一次检查 · ${when}`}</h4>
      {check.findings.length === 0 && check.notChecked.length === 0 && <p className="text-text-3">没有发现需要处理的变化。</p>}
      {check.findings.length > 0 && (
        <ul className="max-w-measure space-y-1">
          {check.findings.map((finding, index) => (
            <li key={index}>
              {outcomeLabel(finding.outcome)}
              {findingSubject(finding.subject) ? ` · ${findingSubject(finding.subject)}` : ""}
              {finding.count != null ? ` · ${finding.count}` : ""}
              {finding.severity === "attention" ? <span className="ml-2 text-text-3">需要决定</span> : null}
            </li>
          ))}
        </ul>
      )}
      {check.notChecked.length > 0 && (
        <p className="max-w-measure text-text-3">
          {`${check.notChecked.length} 项检查没有运行：${[...new Set(check.notChecked.map((item) => notCheckedLabel(item.reason)))].join("；")}。没有运行不等于没有问题。`}
        </p>
      )}
    </div>
  );
}
