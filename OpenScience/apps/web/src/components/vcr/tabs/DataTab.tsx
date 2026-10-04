import { VcrRegistryCoverage } from "../VcrRegistryCoverage";
import { VcrReviews } from "../VcrReviews";
import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ExternalLink } from "lucide-react";
import {
  getVcrData,
  readVcrIntake,
  saveVcrAssumption,
  signVcrReview,
  type VcrAssumption,
  type VcrReviewKind,
  type VcrStudy,
} from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { safeLink } from "@/lib/frontierClient";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FilterChips } from "@/components/ui/FilterChips";
import { Input, Textarea } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Tag } from "@/components/ui/Tag";
import { IntakePanel } from "../data/IntakePanel";
import { VcrForestPlot } from "../VcrDiagrams";
import { ReviewChip, SourceTag } from "../VcrMarks";
import { VcrValueText } from "../VcrNumber";
import { VcrPrecedentTable } from "../VcrPrecedentsPanel";
import { VcrStepPending, VcrTabSkeleton } from "../VcrStates";
import { useVcrLoad, VcrFacts, VcrHeadline, VcrSection, VcrTabError, VcrToolbar } from "../vcrTabKit";
import { intervalText, reviewKindLabel, valueText } from "../vcrText";
import { vcrTabPath } from "../vcrTabs";

type Filter = "all" | "key" | "ai_set" | "reviewed" | "changed";

const FILTER_LABELS: ReadonlyArray<{ value: Filter; label: string }> = Object.freeze([
  { value: "all", label: "全部" },
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
 * 数据与证据: every parameter the study rests on, as a card, and the sentence
 * in the literature each one was read out of.
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
  const intakePanel = intake.available || (data.intake != null && study.tier !== "T0")
    // Freezing a snapshot can move what the study's data support: the header re-reads, so its offer to move up appears with no further step.
    ? <IntakePanel studyId={studyId} intake={intake} onChanged={() => { reload(); onStudyChanged?.(); }} />
    : null;
  if (data.assumptions.length === 0 && data.precedents.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        {note}
        <VcrRegistryCoverage sources={data.registryCoverage} />
        <VcrReviews reviews={data.reviews} />
        <VcrStepPending studyId={studyId} study={study} step="evidence" />
        {intakePanel}
      </div>
    );
  }
  const asked = params.get("card");
  const shown = data.assumptions.filter((assumption) => matches(assumption, filter));
  const selected = (asked ? data.assumptions.find((assumption) => assumption.id === asked || assumption.key === asked) : null)
    ?? data.assumptions.find((assumption) => assumption.id === data.selectedId)
    ?? shown[0] ?? data.assumptions[0] ?? null;
  const open = (assumption: VcrAssumption) => setParams((current) => {
    const next = new URLSearchParams(current);
    next.set("card", assumption.key || assumption.id);
    return next;
  }, { replace: true });
  const count = (value: Filter) => data.assumptions.filter((assumption) => matches(assumption, value)).length;

  return (
    <div className="flex flex-col gap-6">
      {data.status && data.status.length > 0 && (
        <VcrToolbar summary={data.status.map((item) => `${item.label} ${item.value}`).join(" · ")} />
      )}
      {note}
      <VcrRegistryCoverage sources={data.registryCoverage} />
      <VcrReviews reviews={data.reviews} />
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
            <FilterChips
              label="假设卡"
              options={FILTER_LABELS.map((option) => ({ ...option, ...(option.value === "all" ? {} : { count: count(option.value) }) }))}
              value={filter}
              onChange={setFilter}
              className="mb-3"
            />
            <ul className="flex flex-col gap-1">
              {shown.map((assumption) => (
                <li key={assumption.id}>
                  <button
                    type="button"
                    data-vcr-assumption={assumption.id}
                    aria-current={selected?.id === assumption.id ? "true" : undefined}
                    onClick={() => open(assumption)}
                    className={cn(
                      "w-full rounded px-2.5 py-2 text-left outline-none hover:bg-surface-1",
                      selected?.id === assumption.id && "bg-accent-soft",
                    )}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 truncate text-ui text-text">{assumption.name}</span>
                      <span className="shrink-0 text-ui font-medium tabular-nums text-text">
                        {valueText(assumption.value)}
                        {assumption.value.unit && <span className="ml-0.5 font-normal text-text-3">{assumption.value.unit}</span>}
                      </span>
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5">
                      <SourceTag source={assumption.value.source} />
                      {assumption.summary && <span className="min-w-0 truncate text-caption text-text-3">{assumption.summary}</span>}
                      <span className="flex-1" />
                      <ReviewChip state={assumption.value.review} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          {selected && (
            <AssumptionDetail key={`${selected.id}@${selected.version ?? ""}`} studyId={studyId} study={study} assumption={selected} onChanged={reload} />
          )}
        </div>
      )}

      {data.precedents.length > 0 && (
        <VcrSection title="试验先例" meta={data.precedentSources ?? `${data.precedents.length} 项`}>
          <VcrPrecedentTable
            rows={data.precedents}
            withUse
            footnote={data.precedentNote ?? "计划值取自登记记录的预计字段，只用于对照；历史基准只用实际值。"}
          />
        </VcrSection>
      )}

      {intakePanel}

      {data.decisions && data.decisions.length > 0 && (
        <VcrSection title="决策记录" meta={`${data.decisions.length}`}>
          <ol className="divide-y divide-faint">
            {data.decisions.map((decision) => (
              <li key={decision.id} data-vcr-decision={decision.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                <span className="w-28 shrink-0 text-caption tabular-nums text-text-3">{decision.at ?? ""}</span>
                <span className="min-w-0 flex-1 text-ui text-text">{decision.text}</span>
              </li>
            ))}
          </ol>
        </VcrSection>
      )}
    </div>
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
      value: [review.kind, review.by, review.at, review.version != null ? `针对版本 ${review.version}` : null].filter(Boolean).join(" · "),
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
          {assumption.version != null && <span className="text-caption tabular-nums text-text-3">{`版本 ${assumption.version}`}</span>}
          <span className="flex-1" />
          {mode === "read" && mayEdit && <Button size="sm" variant="secondary" onClick={() => setMode("edit")}>改这张卡</Button>}
          {mode === "read" && maySign && <Button size="sm" variant="secondary" onClick={() => setMode("sign")}>签注复核</Button>}
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
              <a href={quoteLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-link hover:underline">
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
        <VcrSection title="版本记录" className="mt-6">
          <ol className="divide-y divide-faint">
            {detail.versions.map((version) => (
              <li key={version.version} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                <span className="w-8 shrink-0 text-caption tabular-nums text-text-3">{`v${version.version}`}</span>
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
      .then((saved) => { toast.success(saved?.version ? `已保存为版本 ${saved.version}。` : "已保存。"); onSaved(); })
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
        <Button type="submit" loading={busy} disabled={busy}>{`签注版本 ${assumption.version ?? ""}`.trim()}</Button>
      </div>
    </form>
  );
}
