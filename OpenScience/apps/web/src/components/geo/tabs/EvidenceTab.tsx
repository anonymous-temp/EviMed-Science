import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import type { GeoClaim, GeoEvidence, GeoProject } from "@/lib/geoClient";
import type { FilterOption } from "@/components/ui/FilterChips";
import { Drawer } from "@/components/ui/Drawer";
import { FactList, type Fact } from "@/components/ui/FactList";
import { List, ListRow } from "@/components/ui/ListRow";
import { Section } from "@/components/ui/Section";
import { Tag } from "@/components/ui/Tag";
import { useGeoToolbar } from "../geoFrame";
import { useGeoEvidence } from "../geoProjectData";
import { geoEvidenceView, geoSectionId, GEO_VIEW_PARAM, type GeoEvidenceView } from "../geoTabs";
import { monthDay } from "../geoText";
import { claimSourceKindWord, CLAIM_SOURCE_KIND_WORDS } from "./geoTabText";
import { StepPending, TabError, TabSkeleton } from "./geoTabKit";
import { ShowMore, useShowMore } from "./showMore";
import { ValueAnalysis } from "./ValueSection";

/** Claims listed before 「显示更多」, and how many each press adds. */
const CLAIMS_SHOWN = 8;
const CLAIMS_STEP = 20;

type KindFilter = "all" | keyof typeof CLAIM_SOURCE_KIND_WORDS;

const VIEW_OPTIONS: ReadonlyArray<FilterOption<GeoEvidenceView>> = [
  { value: "claims", label: "结论库" },
  { value: "value", label: "药品价值" },
];

/**
 * 依据 (R19 audit C A.6; the home of step 1, 证据): what the product is and what may be said about it — who the product is, the
 * claims library, and the drug-value analysis. It is the one place the value analysis is drawn: it used to be a block in seven tabs,
 * each with a title of its own, and the other tabs link to it from the object it is about.
 *
 * The page has two views, a switch of the toolbar (`?view=claims|value`): the claim library — every fact that may be said about the
 * product, with its source, level, whether it is inside the label and when it was last checked — where a claim opens a drawer with
 * its verbatim quotation and what it stands on; and the analysis. A retired claim is not listed; an expired one is, marked, until it
 * is re-checked.
 */
export function EvidenceTab({ geoId, project }: { geoId: string; project: GeoProject }) {
  const { state, reload } = useGeoEvidence(geoId);
  const [params, setParams] = useSearchParams();
  const view = geoEvidenceView(params.get(GEO_VIEW_PARAM));
  const [kind, setKind] = useState<KindFilter>("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<GeoClaim | null>(null);

  const evidence = state.kind === "ready" ? state.data : null;
  const claims = useMemo(() => (evidence?.claims ?? []).filter((claim) => claim && claim.status !== "retired"), [evidence]);
  const options = useMemo<FilterOption<KindFilter>[]>(() => {
    const present = new Set(claims.map((claim) => claim.sourceKind).filter(Boolean));
    return [
      { value: "all", label: "全部" },
      ...(Object.keys(CLAIM_SOURCE_KIND_WORDS) as Array<keyof typeof CLAIM_SOURCE_KIND_WORDS>)
        .filter((key) => present.has(key))
        .map((key) => ({ value: key, label: CLAIM_SOURCE_KIND_WORDS[key] })),
    ];
  }, [claims]);
  const needle = query.trim().toLowerCase();
  const matching = useMemo(
    () => claims
      .filter((claim) => kind === "all" || claim.sourceKind === kind)
      .filter((claim) => !needle || `${claim.statement} ${claim.quote ?? ""}`.toLowerCase().includes(needle)),
    [claims, kind, needle],
  );
  const { visible, remaining, more } = useShowMore(matching, { first: CLAIMS_SHOWN, step: CLAIMS_STEP, resetKey: `${kind}|${needle}` });

  const setView = (next: string) => setParams((previous) => {
    const copy = new URLSearchParams(previous);
    if (next === "claims") copy.delete(GEO_VIEW_PARAM); else copy.set(GEO_VIEW_PARAM, next);
    return copy;
  }, { replace: true });
  const switcher = { kind: "chips" as const, label: "视图", options: VIEW_OPTIONS, value: view, onChange: setView };
  useGeoToolbar(view === "value" || claims.length === 0
    ? { filters: [switcher] }
    : {
      filters: [switcher, { kind: "chips", label: "出处类型", options, value: kind, onChange: (value) => setKind(value as KindFilter) }],
      search: { label: "搜索结论", value: query, maxLength: 80, onChange: setQuery, onClear: () => setQuery("") },
      summary: `${needle ? "匹配 " : ""}${matching.length} 条结论`,
    });

  if (state.kind === "loading") return <TabSkeleton />;
  if (state.kind === "error") return <TabError message={state.message} onRetry={reload} />;
  const identity = identityRows(evidence);

  return (
    <div data-geo-tab="evidence" className="flex flex-col gap-6">
      {identity.length > 0 && (
        <Section title="产品身份" className="mt-0">
          {evidence?.product?.identityStatus === "ambiguous" && <p className="mb-2"><Tag>身份待确认</Tag></p>}
          <FactList rows={identity} />
        </Section>
      )}
      {view === "value" ? (
        <section id={geoSectionId("value")} aria-label="药品价值分析">
          <ValueAnalysis geoId={geoId} project={project} />
        </section>
      ) : claims.length === 0 ? (
        <StepPending geoId={geoId} project={project} step="evidence" />
      ) : (
        <section id={geoSectionId("claims")} aria-label="结论库">
          {matching.length === 0 ? (
            <p className="py-10 text-center text-ui text-text-3">{needle ? `没有包含“${query.trim()}”的结论。` : "没有符合的结论。"}</p>
          ) : (
            <>
              <List divided>
                {visible.map((claim) => (
                  <ListRow
                    key={claim.id}
                    title={claim.statement}
                    // What a conclusion opens to is its quotation and what it stands on; both are in the drawer.
                    onOpen={() => setOpen(claim)}
                    muted={claim.status === "expired"}
                    meta={<ClaimMeta claim={claim} />}
                    trailing={(
                      <>
                        {claim.status === "expired" && <Tag>待重核</Tag>}
                        {claim.inLabel === true && <Tag>说明书内</Tag>}
                        {claim.inLabel === false && <Tag>说明书外</Tag>}
                      </>
                    )}
                  />
                ))}
              </List>
              <ShowMore remaining={remaining} unit="条" onMore={more} />
            </>
          )}
        </section>
      )}
      {open && <ClaimDrawer claim={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function identityRows(evidence: GeoEvidence | null | undefined): Fact[] {
  const product = evidence?.product ?? {};
  const competitors = (evidence?.competitors ?? [])
    .map((competitor) => competitor?.brandName || competitor?.genericName)
    .filter((name): name is string => !!name);
  const category = [product.rx === "rx" ? "处方药" : product.rx === "otc" ? "非处方药" : null, product.tcm ? "中药" : null]
    .filter(Boolean)
    .join(" · ");
  const rows: Array<Fact | null> = [
    product.genericName ? { label: "通用名", value: product.genericName } : null,
    product.brandName ? { label: "商品名", value: product.brandName } : null,
    category ? { label: "类别", value: category } : null,
    product.holder ? { label: "持有人", value: product.holder } : null,
    product.approvalNo ? { label: "批准文号", value: product.approvalNo } : null,
    product.form || product.strength ? { label: "剂型规格", value: [product.form, product.strength].filter(Boolean).join(" · ") } : null,
    product.indication ? { label: "适应证", value: product.indication } : null,
    competitors.length ? { label: "竞品", value: competitors.join("、") } : null,
  ];
  return rows.filter((row): row is Fact => row !== null);
}

/**
 * A source reference as a reader can use it: a PMID or DOI as written, a
 * preserved page or file by no name at all (its hash means nothing to a
 * reader; the kind before it already says what it is).
 */
export function readableSourceRef(ref: string | null | undefined): string | null {
  const value = (ref ?? "").trim();
  if (!value) return null;
  if (/^(pmid|doi|pmcid)\s*:\s*/i.test(value)) return value.replace(/^(pmid|doi|pmcid)\s*:\s*/i, (_match, kind: string) => `${kind.toUpperCase()} `);
  if (/^(web-page|file|source|label):/i.test(value) || /^(src_|\.evimed-sources)/i.test(value)) return null;
  return value;
}

/** “说明书 · 国家药监局 2025 · 证据等级 A · 成人 · 9月22日核对” */
function ClaimMeta({ claim }: { claim: GeoClaim }) {
  const verified = monthDay(claim.verifiedAt);
  const parts = [
    claimSourceKindWord(claim.sourceKind),
    claim.sourceLabel || readableSourceRef(claim.sourceRef),
    claim.evidenceLevel ? `证据等级 ${claim.evidenceLevel}` : null,
    claim.population || null,
    verified ? `${verified}核对` : null,
  ].filter((part): part is string => !!part);
  return <span>{parts.join(" · ")}</span>;
}

/** A claim in the drawer: the conclusion, its verbatim quotation where it has one, and what it stands on. */
function ClaimDrawer({ claim, onClose }: { claim: GeoClaim; onClose: () => void }) {
  const verified = monthDay(claim.verifiedAt);
  const until = monthDay(claim.validUntil);
  const rows: Fact[] = [
    { label: "出处类型", value: claimSourceKindWord(claim.sourceKind) ?? "" },
    { label: "来源", value: claim.sourceLabel || readableSourceRef(claim.sourceRef) || "" },
    { label: "证据等级", value: claim.evidenceLevel ?? "" },
    { label: "适用人群", value: claim.population ?? "" },
    { label: "说明书", value: claim.inLabel === true ? "在说明书内" : claim.inLabel === false ? "不在说明书内" : "" },
    { label: "核对", value: verified ? `${verified}核对` : "" },
    { label: "有效期", value: until ? `${until}前` : "" },
  ].filter((row) => row.value);
  return (
    <Drawer title="结论" onClose={onClose}>
      <div data-geo-claim={claim.id} className="flex flex-col gap-4">
        <p className="text-body text-text">{claim.statement}</p>
        {claim.quote && (
          <blockquote className="max-w-measure border-l-2 border-border pl-3 text-ui text-text-2">{claim.quote}</blockquote>
        )}
        {rows.length > 0 && <FactList rows={rows} />}
      </div>
    </Drawer>
  );
}
