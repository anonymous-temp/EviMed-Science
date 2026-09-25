import { useMemo, useState } from "react";
import { getGeoEvidence, type GeoClaim, type GeoEvidence, type GeoProject } from "@/lib/geoClient";
import { FilterChips, type FilterOption } from "@/components/ui/FilterChips";
import { List, ListRow } from "@/components/ui/ListRow";
import { Tag } from "@/components/ui/Tag";
import { monthDay } from "../geoText";
import { claimSourceKindWord, CLAIM_SOURCE_KIND_WORDS } from "./geoTabText";
import { FilterRow, StepPending, TabError, TabSkeleton, useGeoLoad } from "./geoTabKit";

type KindFilter = "all" | keyof typeof CLAIM_SOURCE_KIND_WORDS;

/**
 * 证据 (plan §3.1, mockup g03b): who the product is, and the claims library —
 * every fact that may be said about it, with its source, level, whether it is
 * inside the label and when it was last checked against the source.
 *
 * A claim opens in place to show the verbatim quote it rests on. A retired
 * claim is not listed; an expired one is, marked, until it is re-checked.
 */
export function EvidenceTab({ geoId, project }: { geoId: string; project: GeoProject }) {
  const { state, reload } = useGeoLoad(`evidence:${geoId}`, () => getGeoEvidence(geoId));
  if (state.kind === "loading") return <TabSkeleton />;
  if (state.kind === "error") return <TabError message={state.message} onRetry={reload} />;
  const evidence = state.data;
  const claims = (evidence?.claims ?? []).filter((claim) => claim && claim.status !== "retired");
  const identity = identityRows(evidence);
  if (claims.length === 0 && identity.length === 0) return <StepPending geoId={geoId} project={project} step="evidence" />;
  return (
    <div data-geo-tab="evidence">
      {identity.length > 0 && <Identity rows={identity} ambiguous={evidence.product?.identityStatus === "ambiguous"} />}
      {claims.length > 0 ? <Claims claims={claims} /> : <StepPending geoId={geoId} project={project} step="evidence" />}
    </div>
  );
}

interface IdentityRow {
  label: string;
  value: string;
  /** Long values (the indication, the competitors) take the whole row. */
  wide?: boolean;
}

function identityRows(evidence: GeoEvidence | null | undefined): IdentityRow[] {
  const product = evidence?.product ?? {};
  const competitors = (evidence?.competitors ?? [])
    .map((competitor) => competitor?.brandName || competitor?.genericName)
    .filter((name): name is string => !!name);
  const category = [product.rx === "rx" ? "处方药" : product.rx === "otc" ? "非处方药" : null, product.tcm ? "中药" : null]
    .filter(Boolean)
    .join(" · ");
  const rows: Array<IdentityRow | null> = [
    product.genericName ? { label: "通用名", value: product.genericName } : null,
    product.brandName ? { label: "商品名", value: product.brandName } : null,
    category ? { label: "类别", value: category } : null,
    product.holder ? { label: "持有人", value: product.holder } : null,
    product.approvalNo ? { label: "批准文号", value: product.approvalNo } : null,
    product.form || product.strength ? { label: "剂型规格", value: [product.form, product.strength].filter(Boolean).join(" · ") } : null,
    product.indication ? { label: "适应证", value: product.indication, wide: true } : null,
    competitors.length ? { label: "竞品", value: competitors.join("、"), wide: true } : null,
  ];
  return rows.filter((row): row is IdentityRow => row !== null);
}

function Identity({ rows, ambiguous }: { rows: IdentityRow[]; ambiguous: boolean }) {
  return (
    <section aria-label="产品身份" className="border-b border-border pb-6">
      {ambiguous && <p className="mb-3"><Tag>身份待确认</Tag></p>}
      <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className={row.wide ? "flex gap-4 sm:col-span-2" : "flex gap-4"}>
            <dt className="w-20 shrink-0 text-ui text-text-3">{row.label}</dt>
            <dd className="min-w-0 max-w-measure text-ui text-text">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Claims({ claims }: { claims: GeoClaim[] }) {
  const [kind, setKind] = useState<KindFilter>("all");
  const [open, setOpen] = useState<string | null>(null);
  const options = useMemo<FilterOption<KindFilter>[]>(() => {
    const present = new Set(claims.map((claim) => claim.sourceKind).filter(Boolean));
    return [
      { value: "all", label: "全部" },
      ...(Object.keys(CLAIM_SOURCE_KIND_WORDS) as Array<keyof typeof CLAIM_SOURCE_KIND_WORDS>)
        .filter((key) => present.has(key))
        .map((key) => ({ value: key, label: CLAIM_SOURCE_KIND_WORDS[key] })),
    ];
  }, [claims]);
  const shown = kind === "all" ? claims : claims.filter((claim) => claim.sourceKind === kind);

  return (
    <section aria-label="主张" className="mt-6">
      <FilterRow summary={`${claims.length} 条主张`}>
        <FilterChips label="出处类型" options={options} value={kind} onChange={setKind} />
      </FilterRow>
      <List divided className="mt-3">
        {shown.map((claim) => {
          const expanded = open === claim.id;
          return (
            <ListRow
              key={claim.id}
              title={claim.statement}
              onOpen={() => setOpen(expanded ? null : claim.id)}
              expanded={expanded}
              muted={claim.status === "expired"}
              meta={(
                <>
                  <ClaimMeta claim={claim} />
                  {expanded && claim.quote && (
                    <blockquote className="mt-2 max-w-measure border-l-2 border-border pl-3 text-ui text-text-2">
                      {claim.quote}
                    </blockquote>
                  )}
                </>
              )}
              trailing={(
                <>
                  {claim.status === "expired" && <Tag>已过期</Tag>}
                  {claim.inLabel === true && <Tag>说明书内</Tag>}
                  {claim.inLabel === false && <Tag>说明书外</Tag>}
                </>
              )}
            />
          );
        })}
      </List>
    </section>
  );
}

/** 「说明书 · 国家药监局 2025 · 证据等级 A · 成人 · 9月22日核验」 */
function ClaimMeta({ claim }: { claim: GeoClaim }) {
  const verified = monthDay(claim.verifiedAt);
  const parts = [
    claimSourceKindWord(claim.sourceKind),
    claim.sourceRef || null,
    claim.evidenceLevel ? `证据等级 ${claim.evidenceLevel}` : null,
    claim.population || null,
    verified ? `${verified}核验` : null,
  ].filter((part): part is string => !!part);
  return <span>{parts.join(" · ")}</span>;
}
