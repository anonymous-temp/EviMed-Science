import { useState } from "react";
import { CircleCheck, CircleHelp, CircleX, Clock, TriangleAlert } from "lucide-react";
import {
  contactVcrReferral,
  getVcrMatching,
  type VcrCandidate,
  type VcrCriterionState,
  type VcrMatchingTab as MatchingData,
  type VcrStudy,
} from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ChartCard } from "@/components/ui/ChartCard";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DataTable } from "@/components/ui/DataTable";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Tag } from "@/components/ui/Tag";
import { VcrCountsBand } from "../VcrCounts";
import { VcrForecastChart } from "../VcrCharts";
import { VcrFunnelBar } from "../VcrDiagrams";
import { SourceTag } from "../VcrMarks";
import { VcrStat, VcrStatNote } from "../VcrNumber";
import { VcrStepPending, VcrTabSkeleton } from "../VcrStates";
import { useVcrLoad, VcrHeadline, VcrSection, VcrTabError, VcrToolbar } from "../vcrTabKit";
import { criterionStateLabel, numberText, referralStateLabel } from "../vcrText";

type View = "matching" | "referral" | "sites" | "followup";

const VIEWS: ReadonlyArray<{ value: View; label: string }> = Object.freeze([
  { value: "matching", label: "匹配" },
  { value: "referral", label: "转诊" },
  { value: "sites", label: "中心" },
  { value: "followup", label: "随访" },
]);

const STATE_ICON: Record<VcrCriterionState, typeof CircleCheck> = {
  satisfied: CircleCheck,
  not_satisfied: CircleX,
  unknown: CircleHelp,
  pending_recheck: Clock,
};

/**
 * 匹配与招募: who might be eligible, what is still missing on each of them,
 * and what the sites have actually done.
 *
 * This is the one tab with a human stop in it (plan §10.1). 「确认后联系」 is
 * per person and is the coordinator's, because contacting a patient is an act
 * outside the platform that cannot be undone; the platform has the reason and
 * the missing evidence ready, and stops there.
 *
 * Eligibility is three-valued and stays three-valued: 未知 is never folded
 * into 不符合. A candidate the platform cannot judge is a request for one
 * piece of evidence, and the column that says which piece is what makes the
 * list actionable rather than a ranking.
 */
export function MatchingTab({ studyId, study }: { studyId: string; study: VcrStudy }) {
  const [view, setView] = useState<View>("matching");
  const { state, reload } = useVcrLoad(`${studyId}:matching:${view}`, () => getVcrMatching(studyId, { view }));
  const header = (
    <VcrToolbar>
      <SegmentedControl aria-label="匹配与招募的视图" value={view} onChange={setView} options={[...VIEWS]} />
    </VcrToolbar>
  );
  if (state.kind === "loading") return <div className="flex flex-col gap-6">{header}<VcrTabSkeleton /></div>;
  if (state.kind === "error") return <div className="flex flex-col gap-6">{header}<VcrTabError message={state.message} onRetry={reload} /></div>;
  const data = state.data;
  // Every sub-view counts: a referral ledger with no candidate list is a
  // study whose matching has already run, and offering 「让 AI 做」 there
  // would ask for work that is done.
  const nothing = data.candidates.length === 0 && !data.forecast
    && (data.ledger ?? []).length === 0 && (data.sites ?? []).length === 0 && (data.followup ?? []).length === 0;
  if (nothing) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <VcrStepPending studyId={studyId} study={study} step="matching" />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <VcrToolbar summary={partnerLine(data)}>
        <SegmentedControl aria-label="匹配与招募的视图" value={view} onChange={setView} options={[...VIEWS]} />
      </VcrToolbar>
      {data.headline && <VcrHeadline>{data.headline}</VcrHeadline>}
      {view === "matching" && <MatchingView studyId={studyId} data={data} onDone={reload} />}
      {view === "referral" && <ReferralView data={data} />}
      {view === "sites" && <SitesView data={data} />}
      {view === "followup" && <FollowupView data={data} />}
      <VcrCountsBand counts={data.counts} />
    </div>
  );
}

function partnerLine(data: MatchingData): string {
  return [
    data.partner?.name ? `合作方：${data.partner.name}` : null,
    data.partner?.candidates != null ? `${referralStateLabel("candidate")} ${numberText(data.partner.candidates, 0)} 名` : null,
    data.partner?.snapshotAt ? `数据快照 ${data.partner.snapshotAt}` : null,
  ].filter(Boolean).join(" · ");
}

function MatchingView({ studyId, data, onDone }: { studyId: string; data: MatchingData; onDone: () => void }) {
  const [confirming, setConfirming] = useState<VcrCandidate | null>(null);
  const [busy, setBusy] = useState(false);
  const selected = data.selected;

  const contact = () => {
    if (!confirming) return;
    setBusy(true);
    void contactVcrReferral(studyId, confirming.id)
      .then(() => { toast.success("已记录联系确认。"); onDone(); })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "联系确认暂时无法记录，请稍后重试。" })))
      .finally(() => { setBusy(false); setConfirming(null); });
  };

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-4">
        {data.funnel.map((step) => (
          <div key={step.key} className="rounded-card border border-border bg-surface p-4">
            <p className="truncate text-caption text-text-3">{step.label}</p>
            <p className={cn("mt-1 text-metric font-semibold tabular-nums",
              step.tone === "attention" ? "text-warn-strong" : step.tone === "accent" ? "text-accent" : "text-text")}
            >
              {numberText(step.count, 0)}
            </p>
            {step.note && <p className="mt-0.5 truncate text-caption text-text-3">{step.note}</p>}
          </div>
        ))}
      </div>
      <VcrFunnelBar
        eligible={data.funnel.find((step) => step.key === "eligible")?.count ?? null}
        insufficient={data.funnel.find((step) => step.key === "insufficient")?.count ?? null}
        ineligible={data.funnel.find((step) => step.key === "ineligible")?.count ?? null}
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <Card title={referralStateLabel("candidate")}>
            <ul className="flex flex-col gap-1">
              {data.candidates.map((candidate) => (
                <li
                  key={candidate.id}
                  data-vcr-candidate={candidate.id}
                  className={cn("rounded px-2.5 py-2", selected?.candidate.id === candidate.id && "bg-accent-soft")}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-ui font-medium text-text">{candidate.id}</span>
                    {candidate.site && <span className="shrink-0 text-caption text-text-3">{candidate.site}</span>}
                  </div>
                  <p className="truncate text-caption text-text-2">{candidate.summary}</p>
                  {candidate.open.length > 0 && (
                    <p className="mt-1 flex flex-wrap gap-1">
                      {candidate.open.map((open) => (
                        <Tag key={open.code} tone="warn">
                          {`${open.code} ${criterionStateLabel(open.state)}${open.note ? ` ${open.note}` : ""}`}
                        </Tag>
                      ))}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </Card>

          {data.gaps.length > 0 && (
            <Card title="待补证的主要缺口">
              <ul className="flex flex-col gap-2.5">
                {data.gaps.map((gap) => (
                  <li key={gap.code} className="flex items-baseline gap-3">
                    <span className="w-8 shrink-0 text-caption tabular-nums text-text-3">{gap.code}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ui text-text">{gap.label}</span>
                      {gap.detail && <span className="block truncate text-caption text-text-3">{gap.detail}</span>}
                    </span>
                    <span className="shrink-0 text-ui tabular-nums text-text">{numberText(gap.count, 0)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        {selected && (
          <Card
            header={(
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="text-section font-semibold text-text">{selected.candidate.id}</h2>
                <span className="min-w-0 flex-1 text-ui text-text-2">{selected.candidate.summary}</span>
              </div>
            )}
          >
            {selected.facts && selected.facts.length > 0 && (
              <dl className="mb-4 grid gap-px overflow-hidden rounded-card border border-border bg-border sm:grid-cols-3 lg:grid-cols-5 [&>div]:bg-surface">
                {selected.facts.map((fact) => (
                  <div key={fact.label} className="p-3">
                    <dt className="truncate text-caption text-text-3">{fact.label}</dt>
                    <dd className={cn("mt-0.5 truncate text-ui font-medium", fact.tone === "attention" ? "text-warn-strong" : "text-text")}>{fact.value}</dd>
                  </div>
                ))}
              </dl>
            )}

            <DataTable
              label={`${selected.candidate.id} 的逐条判定`}
              minWidth="min-w-[44rem]"
              columns={[
                { key: "code", header: "编号", rowHeader: true, width: "w-16", cell: (row) => <span className="tabular-nums text-text-3">{row.code}</span> },
                { key: "text", header: "方案原文", cell: (row) => <span className="text-text">{row.text}</span> },
                {
                  key: "state",
                  header: "状态",
                  width: "w-24",
                  cell: (row) => {
                    const Icon = STATE_ICON[row.state];
                    return (
                      <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap",
                        row.state === "satisfied" ? "text-ok" : row.state === "not_satisfied" ? "text-danger-strong" : "text-warn-strong")}
                      >
                        <Icon size={16} aria-hidden="true" />
                        {criterionStateLabel(row.state)}
                      </span>
                    );
                  },
                },
                {
                  key: "evidence",
                  header: "患者证据",
                  isEmpty: (row) => !row.evidence,
                  cell: (row) => row.evidence ? (
                    <span className="block">
                      <span className="block text-text">{`“${row.evidence.quote}”`}</span>
                      <span className="block text-caption text-text-3">{[row.evidence.source, row.evidence.at].filter(Boolean).join(" · ")}</span>
                    </span>
                  ) : null,
                },
                {
                  key: "request",
                  header: "补证建议",
                  isEmpty: (row) => !row.request,
                  cell: (row) => row.request ? (
                    <span className="block">
                      <span className="block text-link">{row.request}</span>
                      {row.requestNote && <span className="block text-caption text-text-3">{row.requestNote}</span>}
                    </span>
                  ) : <span className="text-text-3">—</span>,
                },
              ]}
              rows={selected.criteria}
              rowKey={(row) => row.code}
              rowAttrs={(row) => ({ "data-vcr-criterion": row.code, "data-vcr-criterion-state": row.state })}
            />

            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-3">
              {selected.verdict && (
                <p data-vcr-eligibility="" className="flex min-w-0 flex-1 items-center gap-2 text-ui text-warn-strong">
                  <TriangleAlert size={16} aria-hidden="true" className="shrink-0" />
                  <span className="font-medium">{selected.verdict.text}</span>
                  {selected.verdict.note && <span className="text-text-3">{selected.verdict.note}</span>}
                </p>
              )}
              <Button variant="secondary">请求补证</Button>
              {/* The one human stop: contacting a person is outside the
                  platform and cannot be undone (plan §10.1). */}
              <Button disabled={selected.canContact === false} onClick={() => setConfirming(selected.candidate)}>确认后联系</Button>
            </div>
          </Card>
        )}
      </div>

      {confirming && (
        <ConfirmDialog
          title={`确认联系 ${confirming.id}？`}
          body="联系真实患者是平台之外、不可撤回的动作。确认后会记录是谁在什么时候确认的，并把联系理由和待补证据交给协调员。"
          confirmLabel={busy ? "正在确认" : "确认联系"}
          onConfirm={contact}
          onCancel={() => setConfirming(null)}
        />
      )}
    </>
  );
}

function ReferralView({ data }: { data: MatchingData }) {
  return (
    <>
      {data.ledger && data.ledger.length > 0 && (
        <VcrSection title="转诊进度">
          <ol className="grid gap-px overflow-hidden rounded-card border border-border bg-border sm:grid-cols-3 lg:grid-cols-6 [&>li]:bg-surface">
            {data.ledger.map((entry) => (
              <li key={entry.state} data-vcr-referral-state={entry.state} className={cn("p-4", entry.waiting && "bg-accent-soft")}>
                <p className="truncate text-caption text-text-3">{referralStateLabel(entry.state)}</p>
                <p className={cn("mt-1 text-heading font-semibold tabular-nums", entry.waiting ? "text-accent" : "text-text")}>
                  {numberText(entry.count, 0)}
                </p>
                {entry.note && <p className="mt-0.5 truncate text-caption text-text-3">{entry.note}</p>}
              </li>
            ))}
          </ol>
        </VcrSection>
      )}

      {data.forecast && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <ChartCard
            title="入组预测与实际"
            legend={(
              <>
                <SourceTag source="observed" />
                <span className="text-caption text-text-3">实际入组</span>
                <SourceTag source="predicted" />
                <span className="text-caption text-text-3">预测中位与 80% 预测区间</span>
              </>
            )}
            footnote="实际入组是观察值，预测中位与区间是模型输出，两者是不同种类的数。"
          >
            <VcrForecastChart
              target={data.forecast.target}
              actual={data.forecast.actual}
              median={data.forecast.median}
              band={data.forecast.band}
              markers={data.forecast.markers}
              xLabels={data.forecast.xLabels}
            />
          </ChartCard>
          <div className="flex flex-col gap-4">
            {(data.forecast.rows ?? []).map((metric) => (
              <VcrStat
                key={metric.key}
                label={metric.label}
                value={metric.value}
                note={<VcrStatNote value={metric.value} basis={metric.note} />}
                className="rounded-card border border-border bg-surface"
              />
            ))}
            {data.forecast.basis && data.forecast.basis.length > 0 && (
              <Card title="预测依据">
                <ul className="flex flex-col gap-1 text-caption text-text-2">
                  {data.forecast.basis.map((line) => <li key={line}>{line}</li>)}
                </ul>
              </Card>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function SitesView({ data }: { data: MatchingData }) {
  const sites = data.sites ?? [];
  return (
    <VcrSection title="中心" meta={`${sites.length} 个`}>
      <DataTable
        label="中心"
        minWidth="min-w-[48rem]"
        columns={[
          {
            key: "name",
            header: "中心",
            rowHeader: true,
            cell: (site) => (
              <span className="block">
                <span className="block text-text">{site.name}</span>
                {site.place && <span className="block text-caption text-text-3">{site.place}</span>}
              </span>
            ),
          },
          {
            key: "state",
            header: "状态",
            cell: (site) => (
              <span className="whitespace-nowrap">
                {site.state}
                {site.stateNote && <span className="ml-1.5 text-caption text-text-3">{site.stateNote}</span>}
              </span>
            ),
          },
          { key: "capacity", header: "容量", isEmpty: (site) => !site.capacity, cell: (site) => site.capacity ?? "—" },
          { key: "competing", header: "在研竞争研究", isEmpty: (site) => !site.competing, cell: (site) => site.competing ?? "—" },
          { key: "referred", header: "已转诊", align: "right", cell: (site) => numberText(site.referred, 0) },
          { key: "waiting", header: "待响应", align: "right", cell: (site) => numberText(site.waiting, 0) },
          { key: "enrolled", header: "已入组", align: "right", cell: (site) => numberText(site.enrolled, 0) },
          {
            key: "checked",
            header: "最后核实",
            align: "right",
            cell: (site) => (
              <span className={cn("whitespace-nowrap", site.alert && "font-medium text-warn-strong")}>
                {site.checkedAt ?? "—"}
                {site.alert && <span className="ml-1.5">{site.alert}</span>}
              </span>
            ),
          },
        ]}
        rows={sites}
        rowKey={(site) => site.id}
        rowAttrs={(site) => ({ "data-vcr-site": site.id })}
      />
    </VcrSection>
  );
}

function FollowupView({ data }: { data: MatchingData }) {
  const episodes = data.followup ?? [];
  if (episodes.length === 0) return <p className="py-12 text-center text-ui text-text-3">还没有随访记录。</p>;
  return (
    <VcrSection title="随访" meta={`${episodes.length} 条`}>
      <ul className="divide-y divide-faint">
        {episodes.map((episode) => (
          <li key={episode.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5">
            <span className="w-28 shrink-0 text-caption tabular-nums text-text-3">{episode.at ?? ""}</span>
            <span className="min-w-0 flex-1 text-ui text-text">{episode.label}</span>
            <Tag>{episode.kind}</Tag>
            {episode.detail && <span className="w-full text-caption text-text-3">{episode.detail}</span>}
          </li>
        ))}
      </ul>
    </VcrSection>
  );
}
