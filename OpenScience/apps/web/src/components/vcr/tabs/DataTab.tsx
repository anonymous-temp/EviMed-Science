import { VcrRegistryCoverage } from "../VcrRegistryCoverage";
import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ExternalLink } from "lucide-react";
import {
  getVcrData,
  readVcrIntake,
  saveVcrAssumption,
  signVcrReview,
  type VcrAssumption,
  type VcrPrecedentCandidate,
  type VcrReviewKind,
  type VcrStudy,
} from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { safeLink } from "@/lib/frontierClient";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { FilterSelect } from "@/components/ui/FilterChips";
import { List, ListRow } from "@/components/ui/ListRow";
import { Input, Textarea } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Tag } from "@/components/ui/Tag";
import { IntakePanel } from "../data/IntakePanel";
import { VcrKnowledgeSection } from "../VcrKnowledge";
import { VcrNoDefinition } from "../VcrStates";
import { hasDefinition } from "../vcrTabs";
import { intendedUseLabel } from "../vcrText";
import { VcrForestPlot } from "../VcrDiagrams";
import { ReviewChip, SourceTag } from "../VcrMarks";
import { VcrValueText } from "../VcrNumber";
import { VcrPrecedentTable } from "../VcrPrecedentsPanel";
import { VcrStepPending, VcrTabSkeleton } from "../VcrStates";
import { useVcrLoad, VcrFacts, VcrHeadline, VcrSection, VcrTabError } from "../vcrTabKit";
import { intervalText, reviewKindLabel, valueText } from "../vcrText";
import { vcrTabPath } from "../vcrTabs";

type Filter = "all" | "key" | "ai_set" | "reviewed" | "changed";

const FILTER_LABELS: ReadonlyArray<{ value: Exclude<Filter, "all">; label: string }> = Object.freeze([
  { value: "key", label: "关键假设" },
  { value: "ai_set", label: "AI 设定" },
  { value: "reviewed", label: "已复核" },
  { value: "changed", label: "有变更" },
]);

function matches(assumption: VcrAssumption, filter: Filter): boolean {
  switch (filter) {
    case "key": return assumption.isKey === true;
    case "ai_set": return assumption.value.review === "ai_set";
    case "reviewed": return assumption.value.review === "reviewed";
    case "changed": return assumption.value.review === "changed_after_review";
    default: return true;
  }
}

/**
 * The review kinds this reader may countersign (`VCR_ROLE_ABILITIES`): a
 * clinical reviewer signs clinical reviews, a statistician statistical ones,
 * and the lead (`review_any`) either. The route checks for itself; this only
 * keeps a button off the page that would be refused.
 */
export function reviewKindsFor(abilities: readonly string[]): VcrReviewKind[] {
  const kinds: VcrReviewKind[] = [];
  if (abilities.includes("review_clinical") || abilities.includes("review_any")) kinds.push("clinical");
  if (abilities.includes("review_statistical") || abilities.includes("review_any")) kinds.push("statistical");
  return kinds;
}

/**
 * 定义与证据: what the study is about, and every parameter it rests on — the
 * definition, the disease pack it works from, each parameter as a card with the
 * sentence in the literature it was read out of, the trial precedents, and the
 * data intake. Where the study's tier allows real data the intake comes first,
 * because everything below it is read from what it holds.
 *
 * The forest plot here is the reason the tab exists. It draws the pooled
 * estimate **and the prediction interval** as separate marks, because the
 * design being built is the next study rather than the average of the past
 * ones; a sample size taken off a confidence interval alone is a sample size
 * computed against a precision nobody has.
 *
 * Every card carries its review state as a label on a live value: the number
 * is in use now, and 「AI 设定」 says who set it, not that it is pending
 * (plan §10). A card is one of the few things the page itself edits (plan
 * §9.5): 「改这张卡」 writes its next version, which is what marks the results
 * downstream of it stale, and 「签注复核」 countersigns the version on screen.
 *
 * The card on screen is the address's `?card=` (an id or a key), so a link
 * from a number's drill-down lands on the card it came from.
 */
export function DataTab({ studyId, study, onStudyChanged }: { studyId: string; study: VcrStudy; onStudyChanged?: () => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [params, setParams] = useSearchParams();
  const { state, reload } = useVcrLoad(`${studyId}:data`, () => getVcrData(studyId));
  if (state.kind === "loading") return <VcrTabSkeleton />;
  if (state.kind === "error") return <VcrTabError message={state.message} onRetry={reload} />;
  const data = state.data;
  const note = data.evidenceNote ? <p data-vcr-evidence-note="" className="text-caption text-text-3">{data.evidenceNote}</p> : null;
  // 数据接入 is the tab's own work, not an evidence card: it is there whenever the
  // plane is (or, above T0, whenever it should be), whatever the evidence side holds.
  const intake = readVcrIntake(data.intake);
  // A tier that allows real data puts the intake first: the definition below it is matched against what it holds.
  const realData = study.tier !== "T0";
  // Freezing a snapshot can move what the study's data support: the header re-reads, so its offer to move up appears with no further step.
  const changed = () => { reload(); onStudyChanged?.(); };
  // A study whose tier takes no real data has no use for the intake's form until somebody has data to bring: it is one folded line at the
  // end of the tab, open when a source is already registered. At a tier that takes real data it is the tab's first section.
  const intakePanel = intake.available || (data.intake != null && realData)
    ? (realData
      ? <IntakePanel studyId={studyId} intake={intake} onChanged={changed} />
      : (
        <Disclosure summary={intake.sources.length > 0 ? `数据接入 · ${intake.sources.length} 个数据源` : "数据接入"} defaultOpen={intake.sources.length > 0}>
          <IntakePanel bare studyId={studyId} intake={intake} onChanged={changed} />
        </Disclosure>
      ))
    : null;
  const defined = hasDefinition(study);
  const pack = (
    <VcrKnowledgeSection
      studyId={studyId}
      knowledge={study.knowledge}
      canWrite={study.abilities.includes("write")}
      onChanged={() => onStudyChanged?.()}
    />
  );
  if (data.assumptions.length === 0 && data.precedents.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        {realData && intakePanel}
        {defined ? <DefinitionCard study={study} /> : null}
        {defined ? pack : null}
        {note}
        <VcrRegistryCoverage sources={data.registryCoverage} />
        {defined ? <VcrStepPending studyId={studyId} study={study} step="evidence" /> : <VcrNoDefinition study={study} />}
        {!realData && intakePanel}
      </div>
    );
  }
  const asked = params.get("card");
  const shown = data.assumptions.filter((assumption) => matches(assumption, filter));
  const selected = (asked ? data.assumptions.find((assumption) => assumption.id === asked || assumption.key === asked) : null)
    ?? data.assumptions.find((assumption) => assumption.id === data.selectedId)
    ?? shown[0] ?? data.assumptions[0] ?? null;
  const open = (assumption: VcrAssumption) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set("card", assumption.key || assumption.id);
      return next;
    }, { replace: true });
    // Below the two-column layout the detail stacks under the list: a press must show its result where the reader is looking
    // (page-structure rule 6), so the detail is brought into view — a no-op beside the list, where it already is.
    requestAnimationFrame(() => {
      const detail = document.querySelector("[data-vcr-assumption-detail]");
      if (detail && typeof detail.scrollIntoView === "function") detail.scrollIntoView({ block: "nearest" });
    });
  };
  const count = (value: Filter) => data.assumptions.filter((assumption) => matches(assumption, value)).length;

  return (
    <div className="flex flex-col gap-6">
      {realData && intakePanel}
      <DefinitionCard study={study} />
      {pack}
      {note}
      {data.headline && <VcrHeadline>{data.headline}</VcrHeadline>}

      {data.assumptions.length > 0 && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <Card
            header={(
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-section font-semibold text-text">假设卡</h2>
                <span className="text-caption tabular-nums text-text-3">{data.assumptions.length}</span>
              </div>
            )}
          >
            {/* A filter earns its place with a list long enough to need one; it is one chip that opens a menu, not a row of five. */}
            {data.assumptions.length > 3 && (
              <FilterSelect
                label="筛选"
                allLabel="全部"
                options={FILTER_LABELS.map((option) => ({ ...option, label: `${option.label} ${count(option.value)}` }))}
                value={filter === "all" ? null : filter}
                onChange={(next) => setFilter(next ?? "all")}
              />
            )}
            <List label="假设卡" className={cn(data.assumptions.length > 3 && "mt-2")}>
              {shown.map((assumption) => (
                <ListRow
                  key={assumption.id}
                  title={assumption.name}
                  onOpen={() => open(assumption)}
                  selected={selected?.id === assumption.id}
                  titleProps={{ "data-vcr-assumption": assumption.id }}
                  trailing={(
                    <span className="text-ui font-medium tabular-nums text-text">
                      {valueText(assumption.value)}
                      {assumption.value.unit && <span className="ml-0.5 font-normal text-text-3">{assumption.value.unit}</span>}
                    </span>
                  )}
                  meta={(
                    <span className="flex flex-wrap items-center gap-1.5">
                      <SourceTag source={assumption.value.source} />
                      {assumption.newEvidence && <Tag tone="accent">{assumption.newEvidence.label}</Tag>}
                      <ReviewChip state={assumption.value.review} />
                      {assumption.summary && <span className="min-w-0 truncate text-caption text-text-3">{assumption.summary}</span>}
                    </span>
                  )}
                />
              ))}
            </List>
          </Card>

          {selected && (
            <AssumptionDetail key={`${selected.id}@${selected.version ?? ""}`} studyId={studyId} study={study} assumption={selected} onChanged={reload} />
          )}
        </div>
      )}

      {data.precedents.length > 0 && (
        <VcrSection title="试验先例">
          <VcrPrecedentTable
            rows={data.precedents}
            withUse
            footnote={data.precedentNote ?? "计划值取自登记记录的预计字段，只用于对照；历史基准只用实际值。"}
          />
          <VcrRegistryCoverage sources={data.registryCoverage} />
        </VcrSection>
      )}

      {data.precedentCandidates && data.precedentCandidates.length > 0 && <PrecedentCandidates rows={data.precedentCandidates} />}

      {!realData && intakePanel}
    </div>
  );
}

/**
 * 研究定义: what the study is about, in the words it was described in — the question, the four lines of the PICO, what the result
 * is measured as and what it may be used for. It is the one thing every other tab reads, so it is the first card of the tab that is
 * about what the study rests on. Read-only: the definition is written in the conversation, and a change to it is a new one.
 */
export function DefinitionCard({ study }: { study: VcrStudy }) {
  const definition = study.definition;
  const rows = [
    { label: "研究问题", value: study.question },
    { label: "人群", value: definition?.population },
    { label: "干预", value: definition?.intervention },
    { label: "对照", value: definition?.comparator },
    { label: "结局", value: definition?.outcome },
    { label: "估计什么", value: definition?.estimand },
    { label: "终点类型", value: definition?.endpoint },
    { label: "预期用途", value: study.ceiling && !study.ceiling.withinCeiling
      ? `${intendedUseLabel(study.ceiling.requested)}（结果目前只够用于${intendedUseLabel(study.ceiling.ceiling)}）`
      : definition?.intendedUse ?? intendedUseLabel(study.intendedUse) },
  ].filter((row): row is { label: string; value: string } => typeof row.value === "string" && row.value.length > 0);
  if (rows.length === 0) return null;
  return (
    <Card title="研究定义">
      <div data-vcr-definition=""><VcrFacts rows={rows} /></div>
    </Card>
  );
}

const CANDIDATE_EVENT_LABELS: Readonly<Record<VcrPrecedentCandidate["event"], string>> = Object.freeze({
  registration: "试验注册", results: "结果发布", label_change: "说明书变更",
});

/**
 * 待核对的先例: trial events the frontier feed reported for what the study is about. Each is marked a candidate and says so in a sentence,
 * because a candidate is a pointer — a precedent is a registry record the evidence step fetched and checked against its own text.
 */
function PrecedentCandidates({ rows }: { rows: readonly VcrPrecedentCandidate[] }) {
  return (
    <VcrSection title="待核对的先例" meta={`${rows.length} 项`}>
      <p className="mb-2 text-caption text-text-3">前沿动态里出现的、与本研究对象有关的试验事件，只是线索，不是先例：证据步骤取回登记记录并逐项核对之后，才会进入试验先例。</p>
      <ul className="divide-y divide-faint">
        {rows.map((row) => (
          <li key={row.id} data-vcr-precedent-candidate={row.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
            <Tag>待核对</Tag>
            <span className="min-w-0 flex-1 text-ui text-text">{row.title}</span>
            <span className="shrink-0 text-caption text-text-3">
              {[CANDIDATE_EVENT_LABELS[row.event], row.registryId ?? (row.doi ? `DOI ${row.doi}` : null)].filter(Boolean).join(" · ")}
            </span>
          </li>
        ))}
      </ul>
    </VcrSection>
  );
}

/** One assumption card, opened: where its number came from, what uses it, and the two things a person does to it. */
function AssumptionDetail({ studyId, study, assumption, onChanged }: {
  studyId: string;
  study: VcrStudy;
  assumption: VcrAssumption;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<"read" | "edit" | "sign">("read");
  const detail = assumption.detail;
  const kinds = reviewKindsFor(study.abilities);
  const mayEdit = study.abilities.includes("write");
  // 签注复核 is offered wherever the card is not yet countersigned: an AI
  // setting, or a version changed after its review.
  const maySign = kinds.length > 0 && assumption.version != null && assumption.value.review !== "reviewed";
  const quoteLink = safeLink(detail?.quoteLink);
  const review = assumption.review;
  const facts = [
    ...(detail?.subtitle ? [{ label: "终点与口径", value: detail.subtitle }] : []),
    ...(assumption.applicability ? [{ label: "适用人群", value: assumption.applicability }] : []),
    ...(assumption.sensitivity ? [{ label: "敏感性", value: assumption.sensitivity }] : []),
    ...(review ? [{
      label: "复核",
      value: [review.kind, review.by, review.at].filter(Boolean).join(" · "),
    }] : []),
  ];

  return (
    <Card
      header={(
        <div data-vcr-assumption-detail={assumption.id} className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 className="text-section font-semibold text-text">{assumption.name}</h2>
          <SourceTag source={assumption.value.source} />
          {assumption.sourceType && <Tag>{assumption.sourceType}</Tag>}
          <ReviewChip state={assumption.value.review} by={review?.by} at={review?.at} />
          {assumption.isKey && <Tag>关键假设</Tag>}
          {assumption.newEvidence && <Tag tone="accent">{assumption.newEvidence.label}</Tag>}
          <span className="flex-1" />
          {mode === "read" && mayEdit && <Button size="sm" variant="text" onClick={() => setMode("edit")}>改这张卡</Button>}
          {mode === "read" && maySign && <Button size="sm" variant="text" onClick={() => setMode("sign")}>签注复核</Button>}
        </div>
      )}
    >
      {mode === "edit" && (
        <EditCard studyId={studyId} assumption={assumption} onClose={() => setMode("read")} onSaved={() => { setMode("read"); onChanged(); }} />
      )}
      {mode === "sign" && (
        <SignCard studyId={studyId} assumption={assumption} kinds={kinds} onClose={() => setMode("read")} onSigned={() => { setMode("read"); onChanged(); }} />
      )}

      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-metric font-semibold tabular-nums text-text"><VcrValueText value={assumption.value} /></span>
        {assumption.value.interval && (
          <span className="text-ui tabular-nums text-text-2">{intervalText(assumption.value.interval, assumption.value.precision)}</span>
        )}
      </p>
      {detail?.stats && detail.stats.length > 0 && (
        <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-caption tabular-nums text-text-3">
          {detail.stats.map((stat) => <span key={stat.label}>{`${stat.label} ${stat.value}`}</span>)}
        </p>
      )}

      {facts.length > 0 && <VcrFacts rows={facts} className="mt-3" />}

      {assumption.newEvidence && <NewEvidence news={assumption.newEvidence} />}

      {detail?.forest && detail.forest.length > 0 && (
        <div className="mt-4">
          <VcrForestPlot rows={detail.forest} unit={assumption.value.unit} />
          {detail.forestNote && <p className="mt-2 text-caption text-text-3">{detail.forestNote}</p>}
        </div>
      )}

      {detail?.distribution && (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-caption text-text-3">
          <Tag>仿真用分布</Tag>
          {detail.distribution.family}
          {detail.distribution.note && <span>{detail.distribution.note}</span>}
        </p>
      )}

      {detail?.quote && (
        <figure className="mt-4 rounded-card border border-border bg-surface-1 p-3">
          <blockquote className="text-ui text-text">{`“${detail.quote}”`}</blockquote>
          <figcaption className="mt-2 flex flex-wrap items-center gap-2 text-caption text-text-3">
            {detail.quoteSource && <span>{`— ${detail.quoteSource}`}</span>}
            {/* Only an http(s) address becomes a link: the quote's source is
                data, and data is never trusted to be a safe href. */}
            {quoteLink && (
              <a href={quoteLink} target="_blank" rel="noreferrer" className={buttonClasses({ variant: "text", size: "sm", className: "text-link" })}>
                打开原文
                <ExternalLink size={16} aria-hidden="true" />
              </a>
            )}
          </figcaption>
        </figure>
      )}

      {detail?.usedBy && detail.usedBy.length > 0 && (
        <VcrSection title="被这些结果使用" className="mt-6" meta={`${detail.usedBy.length}`}>
          <ul className="divide-y divide-faint">
            {detail.usedBy.map((user) => (
              <li key={user.id} className="flex items-baseline justify-between gap-3 py-2">
                {user.tab
                  ? <Link to={vcrTabPath(studyId, user.tab)} className="min-w-0 truncate text-ui text-link hover:underline">{user.label}</Link>
                  : <span className="min-w-0 truncate text-ui text-text">{user.label}</span>}
                {user.note && <span className="shrink-0 text-caption text-text-3">{user.note}</span>}
              </li>
            ))}
          </ul>
        </VcrSection>
      )}

      {detail?.versions && detail.versions.length > 0 && (
        <VcrSection title="改动记录" className="mt-6">
          <ol className="divide-y divide-faint">
            {detail.versions.map((version) => (
              <li key={version.version} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                <span className="w-28 shrink-0 text-caption tabular-nums text-text-3">{version.at ?? ""}</span>
                <span className="min-w-0 flex-1 text-ui text-text">{version.text}</span>
                {version.note && <span className="shrink-0 text-caption text-text-3">{version.note}</span>}
              </li>
            ))}
          </ol>
        </VcrSection>
      )}
    </Card>
  );
}

const NEWS_CAUSE_LABELS: Readonly<Record<NonNullable<VcrAssumption["newEvidence"]>["open"][number]["cause"], string>> = Object.freeze({
  new_results: "新的结果", source_retracted: "来源已撤稿", source_corrected: "来源已更正", source_new_version: "来源有新版本",
});

/**
 * 有新证据: what bears on the card's sources, and where the new version is. Said in words and never decided here: the platform asks
 * for the version, the engine pools it, and a study whose analysis plan has frozen keeps the version it froze with.
 */
function NewEvidence({ news }: { news: NonNullable<VcrAssumption["newEvidence"]> }) {
  return (
    <div data-vcr-new-evidence="" role="status" className="mt-4 rounded-card border border-border bg-surface-1 p-3">
      <p className="text-ui font-medium text-text">{news.label}</p>
      {news.open.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-1">
          {news.open.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-baseline gap-x-2 text-caption text-text-2">
              <Tag>{NEWS_CAUSE_LABELS[entry.cause]}</Tag>
              <span className="min-w-0">{entry.title || entry.identifier}</span>
              <span className="tabular-nums text-text-3">{entry.identifier}</span>
            </li>
          ))}
        </ul>
      )}
      {news.afterFreezeVersion != null && (
        <p className="mt-1.5 text-caption text-text-3">分析计划已经冻结：新版本放在冻结的版本旁边，研究仍按冻结的版本计算。</p>
      )}
    </div>
  );
}

/**
 * 「改这张卡」: the value, its unit and a note, written as the card's next
 * version. A person writing a card is recorded as having reviewed it; the
 * results that used the old version go stale by lineage.
 */
function EditCard({ studyId, assumption, onClose, onSaved }: {
  studyId: string;
  assumption: VcrAssumption;
  onClose: () => void;
  onSaved: () => void;
}) {
  const start = assumption.edit ?? { pointValue: assumption.value.value, unit: assumption.value.unit ?? null, note: null };
  const [value, setValue] = useState(start.pointValue != null ? String(start.pointValue) : "");
  const [unit, setUnit] = useState(start.unit ?? "");
  const [note, setNote] = useState(start.note ?? "");
  const [busy, setBusy] = useState(false);
  const holding = useRef(false);
  const parsed = Number.parseFloat(value);
  const valid = value.trim() !== "" && Number.isFinite(parsed);

  const save = () => {
    if (!valid || holding.current) return;
    holding.current = true;
    setBusy(true);
    void saveVcrAssumption(studyId, {
      key: assumption.key,
      name: assumption.name,
      pointValue: parsed,
      unit: unit.trim() || undefined,
      note: note.trim() || undefined,
      // A value a person sets is an expert setting. It keeps the card's endpoint
      // and applicability, and drops the pooled evidence: the number no longer
      // rests on it, and a card must not cite what does not support it (AC-25).
      endpoint: assumption.edit?.endpoint ?? undefined,
      applicability: assumption.edit?.applicability,
      sourceKind: "expert_set",
      valueSource: "assumed",
    })
      .then(() => { toast.success("已保存。"); onSaved(); })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "这张卡暂时无法保存，请稍后重试。" })))
      .finally(() => { holding.current = false; setBusy(false); });
  };

  return (
    <form
      data-vcr-assumption-edit=""
      className="mb-4 flex flex-col gap-3 rounded-card border border-border bg-surface-1 p-3"
      onSubmit={(event) => { event.preventDefault(); save(); }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="取值" type="number" step="any" inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} />
        <Input label="单位" value={unit} onChange={(event) => setUnit(event.target.value)} />
      </div>
      <Textarea label="说明" rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>取消</Button>
        <Button type="submit" loading={busy} disabled={!valid || busy}>保存</Button>
      </div>
    </form>
  );
}

/** 「签注复核」: a countersignature on the version on screen, never a gate (plan §10.2). */
function SignCard({ studyId, assumption, kinds, onClose, onSigned }: {
  studyId: string;
  assumption: VcrAssumption;
  kinds: readonly VcrReviewKind[];
  onClose: () => void;
  onSigned: () => void;
}) {
  const [kind, setKind] = useState<VcrReviewKind>(kinds[0] ?? "clinical");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const holding = useRef(false);

  const sign = () => {
    if (holding.current || assumption.version == null) return;
    holding.current = true;
    setBusy(true);
    void signVcrReview(studyId, {
      kind,
      nodes: [`assumption:${assumption.key}@${assumption.version}`],
      note: note.trim() || undefined,
    })
      .then(() => { toast.success(`已签注${reviewKindLabel(kind)}。`); onSigned(); })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "复核暂时无法签注，请稍后重试。" })))
      .finally(() => { holding.current = false; setBusy(false); });
  };

  return (
    <form
      data-vcr-assumption-sign=""
      className="mb-4 flex flex-col gap-3 rounded-card border border-border bg-surface-1 p-3"
      onSubmit={(event) => { event.preventDefault(); sign(); }}
    >
      {kinds.length > 1 && (
        <SegmentedControl
          aria-label="复核类型"
          value={kind}
          onChange={setKind}
          options={kinds.map((value) => ({ value, label: reviewKindLabel(value) }))}
          className="self-start"
        />
      )}
      <Input label="备注" value={note} onChange={(event) => setNote(event.target.value)} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>取消</Button>
        <Button type="submit" loading={busy} disabled={busy}>签注</Button>
      </div>
    </form>
  );
}
