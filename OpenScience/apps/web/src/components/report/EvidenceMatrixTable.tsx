import { Link } from "react-router";
import { EVIDENCE_SOURCE_TYPE_LABELS_ZH } from "@evimed/domain";
import { ExternalLink } from "lucide-react";
import { CLAIM_STATUS_TEXT, claimSources, type ClaimEvidence } from "@/lib/claimCitations";
import { cn } from "@/lib/cn";
import { preservedSourceHref, type VerifiedClaim } from "@/components/markdown-viewer/ClaimCitation";

const TYPE_LABEL: Record<string, string> = { direct: "直接证据", synthesized: "综合结论", derived: "推导结果" };
const ACCESS_LABEL: Record<string, string> = {
  full_text: "全文", official_page: "官方页面", abstract: "仅摘要", structured_record: "结构化记录",
};
const STATUS_MARK: Record<string, { text: string; className: string }> = {
  verified: { text: "✓ 已核对", className: "text-verify-ok" },
  quote_not_found: { text: "⚠ 原文中未找到", className: "text-verify-pending" },
  source_unavailable: { text: "⚠ 原文未保存", className: "text-verify-pending" },
  no_quote: { text: "⚠ 无引文", className: "text-verify-pending" },
  derived: { text: "推导，无引文", className: "text-muted" },
};

/**
 * The evidence matrix as a table (appendix D §10.8): one row per claim, the
 * claim's id column frozen while the rest scrolls sideways, numbers
 * right-aligned in tabular figures, and each quotation a link to the place in
 * the preserved source where it should be — or, with no preserved copy, to
 * the source itself. The JSON it is read from stays one toggle away.
 *
 * A synthesized claim is one row with its sources stacked, each with its own
 * kind and its own check, because that is how the gate judges it.
 */
export function EvidenceMatrixTable({
  claims,
  verified,
  runId,
  className,
}: {
  claims: Map<string, ClaimEvidence>;
  verified?: Map<string, VerifiedClaim>;
  runId?: string | null;
  className?: string;
}) {
  const rows = [...claims.values()];
  if (rows.length === 0) {
    return <p className="p-4 text-ui text-muted">这个证据矩阵里没有可读的主张。</p>;
  }
  return (
    <div className={cn("overflow-x-auto rounded-card border border-border bg-surface", className)}>
      <table className="min-w-[64rem] border-collapse text-left text-ui tabular-nums">
        <caption className="sr-only">证据矩阵：{rows.length} 条主张</caption>
        <thead>
          <tr className="border-b border-strong bg-surface-2 text-caption text-muted">
            <th scope="col" className="sticky left-0 z-10 w-24 bg-surface-2 px-3 py-2 font-semibold">主张</th>
            <th scope="col" className="w-14 px-3 py-2 text-right font-semibold">文献号</th>
            <th scope="col" className="min-w-[16rem] px-3 py-2 font-semibold">内容</th>
            <th scope="col" className="w-20 px-3 py-2 font-semibold">类型</th>
            <th scope="col" className="min-w-[14rem] px-3 py-2 font-semibold">来源</th>
            <th scope="col" className="min-w-[18rem] px-3 py-2 font-semibold">引文</th>
            <th scope="col" className="w-28 px-3 py-2 font-semibold">核对</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((claim) => {
            const sources = claimSources(claim);
            const check = verified?.get(claim.claimId);
            const overall = check ? STATUS_MARK[check.status] : undefined;
            return (
              <tr key={claim.claimId} id={`matrix-${claim.claimId}`} className="border-b border-faint align-top">
                <th scope="row" className="sticky left-0 z-10 bg-surface px-3 py-2 font-mono text-caption font-medium text-text">
                  {claim.claimId}
                </th>
                <td className="px-3 py-2 text-right">{claim.referenceNumber ?? "—"}</td>
                <td className="px-3 py-2 text-text">
                  {claim.claim}
                  {claim.claimType === "derived" && claim.method && <p className="mt-1 text-caption text-muted">方法：{claim.method}</p>}
                </td>
                <td className="px-3 py-2 text-muted">
                  {TYPE_LABEL[claim.claimType] ?? "主张"}
                  {claim.confidence && <p className="text-caption">把握度{({ high: "高", moderate: "中", low: "低" } as Record<string, string>)[claim.confidence] ?? "未注明"}</p>}
                </td>
                <td className="px-3 py-2">
                  {sources.length === 0 && <span className="text-muted">—</span>}
                  <ol className="space-y-2">
                    {sources.map((source, index) => (
                      <li key={index}>
                        <span className="flex flex-wrap items-center gap-1">
                          {source.sourceType !== "other" && (
                            <span className="rounded-full border border-border bg-surface-2 px-1.5 text-caption">
                              {EVIDENCE_SOURCE_TYPE_LABELS_ZH[source.sourceType]}
                            </span>
                          )}
                          {source.accessLevel && <span className="text-caption text-muted">{ACCESS_LABEL[source.accessLevel] ?? "获取程度未注明"}</span>}
                        </span>
                        <span className="mt-0.5 block text-caption text-text">{source.sourceTitle ?? source.identifier ?? "来源未记录"}</span>
                        {source.identifier && source.sourceTitle && <span className="block text-caption text-muted">{source.identifier}</span>}
                      </li>
                    ))}
                  </ol>
                </td>
                <td className="px-3 py-2">
                  <ol className="space-y-2">
                    {sources.map((source, index) => (
                      <li key={index} className="text-caption">
                        {source.supportQuote ? (
                          <QuoteLink source={source} runId={runId} />
                        ) : (
                          <span className="text-muted">没有给出引文</span>
                        )}
                        {sources.length > 1 && check?.sources[index] && (
                          <span className={cn("ml-1", STATUS_MARK[check.sources[index].status]?.className ?? "text-muted")}>
                            {STATUS_MARK[check.sources[index].status]?.text ?? "未核对"}
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                </td>
                <td className={cn("px-3 py-2 text-caption", overall?.className ?? "text-muted")}>
                  {overall?.text ?? (check ? CLAIM_STATUS_TEXT[check.status]?.label ?? "未核对" : "未核对")}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A quotation, linked to where it should be in the preserved source, or to the source itself. */
function QuoteLink({ source, runId }: { source: ReturnType<typeof claimSources>[number]; runId?: string | null }) {
  const excerpt = `“${source.supportQuote}”`;
  if (runId && source.artifactPath) {
    return (
      <Link to={preservedSourceHref(runId, source.artifactPath, source.supportQuote)} className="line-clamp-4 text-text underline decoration-border underline-offset-2 hover:decoration-link" title="在保存的原文中定位这段引文">
        {excerpt}
      </Link>
    );
  }
  if (source.sourceUrl && /^https?:\/\//i.test(source.sourceUrl)) {
    return (
      <a href={source.sourceUrl} target="_blank" rel="noreferrer" className="line-clamp-4 text-text underline decoration-border underline-offset-2 hover:decoration-link" title="打开原始来源">
        {excerpt}
        <ExternalLink size={11} className="ml-0.5 inline" aria-hidden="true" />
      </a>
    );
  }
  return <span className="line-clamp-4 text-text">{excerpt}</span>;
}
