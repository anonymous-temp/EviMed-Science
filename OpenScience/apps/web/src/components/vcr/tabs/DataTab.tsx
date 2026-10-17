import { VcrRegistryCoverage } from "../VcrRegistryCoverage";
import { useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { ExternalLink } from "lucide-react";
import {
  getVcrData,
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
import { Button, buttonClasses } from "@/components/ui/Button";
import { DataTable } from "@/components/ui/DataTable";
import { FactList, type Fact } from "@/components/ui/FactList";
import { Headline } from "@/components/ui/Headline";
import type { NotePart } from "@/components/ui/Note";
import { Input, Textarea } from "@/components/ui/Input";
import { List, ListRow } from "@/components/ui/ListRow";
import { MasterDetail } from "@/components/ui/MasterDetail";
import { Section } from "@/components/ui/Section";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Tag } from "@/components/ui/Tag";
import type { ToolbarFilter } from "@/components/ui/Toolbar";
import { VcrKnowledgeSection } from "../VcrKnowledge";
import { VcrNoDefinition } from "../VcrStates";
import { hasDefinition } from "../vcrTabs";
import { intendedUseLabel, numberText } from "../vcrText";
import { VcrForestPlot } from "../VcrDiagrams";
import { SourceTag } from "../VcrMarks";
import { VcrValueText } from "../VcrNumber";
import { VcrPrecedentTable } from "../VcrPrecedentsPanel";
import { VcrStepPending, VcrTabSkeleton } from "../VcrStates";
import { useVcrToolbar } from "../studyFrameContext";
import { useVcrLoad, VcrTabError } from "../vcrTabKit";
import { intervalText, reviewKindLabel, valueText } from "../vcrText";
import { vcrTabPath } from "../vcrTabs";

type Filter = "all" | "key";

// Who set a card and whether a person has signed it are not ways to sort the list (owner ruling 2026-10-10): the one filter is the cards that matter most.
const CARDS = "[data-vcr-assumptions]";
const PRECEDENTS = "[data-vcr-precedents]";
const scrollTo = (selector: string) => () => document.querySelector(selector)?.scrollIntoView({ block: "start", behavior: "smooth" });

function matches(assumption: VcrAssumption, filter: Filter): boolean {
  switch (filter) {
    case "key": return assumption.isKey === true;
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
 * A card's number is in use now, whoever set it; the page does not label it with who did or whether anybody signed it (owner ruling 2026-10-10).
 * A card is one of the few things the page itself edits (plan
 * §9.5): 「改这张卡」 writes its next version, which is what marks the results
 * downstream of it stale, and 「签注复核」 countersigns the version on screen.
 *
 * The card on screen is the address's `?card=` (an id or a key), so a link
 * from a number's drill-down lands on the card it came from.
 */
export function DataTab({ studyId, study, onStudyChanged }: { studyId: string; study: VcrStudy; onStudyChanged?: () => void }) {
  const { state, reload } = useVcrLoad(`${studyId}:data`, () => getVcrData(studyId));
  if (state.kind === "loading") return <VcrTabSkeleton />;
  if (state.kind === "error") return <VcrTabError message={state.message} onRetry={reload} />;
  return <DataView studyId={studyId} study={study} data={state.data} reload={reload} onStudyChanged={onStudyChanged} />;
}

function DataView({ studyId, study, data, reload, onStudyChanged }: {
  studyId: string;
  study: VcrStudy;
  data: Awaited<ReturnType<typeof getVcrData>>;
  reload: () => void;
  onStudyChanged?: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [params, setParams] = useSearchParams();
  const defined = hasDefinition(study);
  const pack = (
    <VcrKnowledgeSection
      studyId={studyId}
      knowledge={study.knowledge}
      canWrite={study.abilities.includes("write")}
      onChanged={() => onStudyChanged?.()}
    />
  );
  const cards = data.assumptions.length > 0;
  const keyCards = data.assumptions.filter((assumption) => matches(assumption, "key")).length;
  // The filter only means something while some cards are key and some are not.
  const active: Filter = keyCards > 0 && keyCards < data.assumptions.length ? filter : "all";

  // --- the band's one row: the one filter a long list earns ------------------------------------------------------------------------
  // A filter earns its place with a list long enough to need one; with a single choice it is one chip that is pressed or not.
  const filters: ToolbarFilter[] = data.assumptions.length > 3 && keyCards > 0 && keyCards < data.assumptions.length
    ? [{ kind: "toggle", label: "关键假设", pressed: active === "key", onChange: (pressed) => setFilter(pressed ? "key" : "all") }]
    : [];
  useVcrToolbar(filters.length > 0 ? { label: "假设卡的筛选", filters } : null);

  // The headline is what the page rests on, in the two numbers it has; each opens the section it counts.
  const headline: NotePart[] = [
    ...(cards ? [{ n: numberText(data.assumptions.length, 0), onOpen: scrollTo(CARDS), label: "看假设卡" }, " 张假设卡"] : []),
    ...(cards && data.precedents.length > 0 ? [" · "] : []),
    ...(data.precedents.length > 0 ? [{ n: numberText(data.precedents.length, 0), onOpen: scrollTo(PRECEDENTS), label: "看试验先例" }, " 项试验先例"] : []),
  ];

  // The intake is not here: it is one entry of the header's 「⋯」 on every tier (`VcrIntakeDrawer`), where the study's data came from.
  if (!cards && data.precedents.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        {defined ? <DefinitionCard study={study} /> : null}
        {defined ? pack : null}
        <VcrRegistryCoverage sources={data.registryCoverage} />
        {defined ? <VcrStepPending studyId={studyId} study={study} step="evidence" blocked={data.evidenceNote} /> : <VcrNoDefinition study={study} />}
      </div>
    );
  }
  const asked = params.get("card");
  const shown = data.assumptions.filter((assumption) => matches(assumption, active));
  const selected = (asked ? data.assumptions.find((assumption) => assumption.id === asked || assumption.key === asked) : null)
    ?? data.assumptions.find((assumption) => assumption.id === data.selectedId)
    ?? shown[0] ?? data.assumptions[0] ?? null;
  const open = (assumption: VcrAssumption) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set("card", assumption.key || assumption.id);
      return next;
    }, { replace: true });
  };
  const close = () => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("card");
      return next;
    }, { replace: true });
  };
  const changed = () => { reload(); onStudyChanged?.(); };

  return (
    <div className="flex flex-col gap-6">
      {headline.length > 0 && <Headline parts={headline} />}
      <DefinitionCard study={study} />
      {pack}

      {cards && (
        <MasterDetail
          className="h-auto"
          // The card in view is the address's `?card=`: below the room for both the list is the page and a press opens the card in a
          // drawer over it, which is what the address says (page-structure rule 6).
          narrow="drawer"
          selected={asked !== null && selected !== null}
          listLabel="假设卡"
          detailLabel="假设卡的记录"
          detailTitle={selected?.name ?? "假设卡"}
          onCloseDetail={close}
          listAttributes={{ "data-vcr-assumptions": "" }}
          list={(
            <div className="pr-4 max-lg:pr-0">
              <Section title="假设卡" count={data.assumptions.length}>
                <List label="假设卡">
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
                          {assumption.summary && <span className="min-w-0 truncate text-caption text-text-3">{assumption.summary}</span>}
                        </span>
                      )}
                    />
                  ))}
                </List>
              </Section>
            </div>
          )}
          detail={({ split }) => {
            const card = split ? selected : asked !== null ? selected : null;
            return card ? (
              <div className="pl-6 max-lg:pl-0">
                <AssumptionDetail key={`${card.id}@${card.version ?? ""}`} studyId={studyId} study={study} assumption={card} onChanged={changed} />
              </div>
            ) : null;
          }}
        />
      )}

      {data.precedents.length > 0 && (
        <div data-vcr-precedents="">
          <Section title="试验先例" count={data.precedents.length}>
            <VcrPrecedentTable rows={data.precedents} withUse />
            <VcrRegistryCoverage sources={data.registryCoverage} />
          </Section>
        </div>
      )}

      {data.precedentCandidates && data.precedentCandidates.length > 0 && <PrecedentCandidates rows={data.precedentCandidates} />}
    </div>
  );
}

/**
 * 研究定义: what the study is about, in the words it was described in — the question, the four lines of the PICO, what the result
 * is measured as and what it may be used for. It is the one thing every other tab reads, so it is the first block of the tab that is
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
    <Section title="研究定义">
      <div data-vcr-definition=""><FactList rows={rows} /></div>
    </Section>
  );
}

const CANDIDATE_EVENT_LABELS: Readonly<Record<VcrPrecedentCandidate["event"], string>> = Object.freeze({
  registration: "试验注册", results: "结果发布", label_change: "说明书变更",
});

/**
 * 待核对的先例: trial events the frontier feed reported for what the study is about. Each is marked 待核对 — a candidate is a pointer,
 * and a precedent is a registry record the evidence step fetched and checked against its own text — so the mark is in the row and
 * no sentence has to say it.
 */
function PrecedentCandidates({ rows }: { rows: readonly VcrPrecedentCandidate[] }) {
  return (
    <Section title="待核对的先例" count={`${rows.length} 项`}>
      <DataTable
        label="待核对的先例"
        minWidth="min-w-0"
        columns={[
          { key: "state", header: "状态", width: "w-24", cell: () => <Tag>待核对</Tag> },
          { key: "title", header: "试验", rowHeader: true, cell: (row) => <span className="text-text">{row.title}</span> },
          {
            key: "event",
            header: "事件",
            cell: (row) => (
              <span className="text-caption text-text-3">
                {[CANDIDATE_EVENT_LABELS[row.event], row.registryId ?? (row.doi ? `DOI ${row.doi}` : null)].filter(Boolean).join(" · ")}
              </span>
            ),
          },
        ]}
        rows={rows}
        rowKey={(row) => row.id}
        rowAttrs={(row) => ({ "data-vcr-precedent-candidate": row.id })}
      />
    </Section>
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
  const facts: Fact[] = [
    ...(detail?.subtitle ? [{ label: "终点与口径", value: detail.subtitle }] : []),
    ...(assumption.applicability ? [{ label: "适用人群", value: assumption.applicability }] : []),
    ...(assumption.sensitivity ? [{ label: "敏感性", value: assumption.sensitivity }] : []),
    ...(review ? [{
      label: "复核",
      value: [review.kind, review.by, review.at].filter(Boolean).join(" · "),
    }] : []),
    ...(detail?.distribution ? [{ label: "仿真用分布", value: [detail.distribution.family, detail.distribution.note].filter(Boolean).join(" · ") }] : []),
  ];

  return (
    <div data-vcr-assumption-detail={assumption.id} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="min-w-0 text-section font-semibold text-text">{assumption.name}</h2>
        <SourceTag source={assumption.value.source} />
        {assumption.sourceType && <Tag>{assumption.sourceType}</Tag>}
        {assumption.isKey && <Tag>关键假设</Tag>}
        {assumption.newEvidence && <Tag tone="accent">{assumption.newEvidence.label}</Tag>}
        <span className="flex-1" />
        {mode === "read" && mayEdit && <Button size="sm" variant="text" onClick={() => setMode("edit")}>改这张卡</Button>}
        {mode === "read" && maySign && <Button size="sm" variant="text" onClick={() => setMode("sign")}>签注复核</Button>}
      </div>

      {mode === "edit" && (
        <EditCard studyId={studyId} assumption={assumption} onClose={() => setMode("read")} onSaved={() => { setMode("read"); onChanged(); }} />
      )}
      {mode === "sign" && (
        <SignCard studyId={studyId} assumption={assumption} kinds={kinds} onClose={() => setMode("read")} onSigned={() => { setMode("read"); onChanged(); }} />
      )}

      <div>
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
      </div>

      {facts.length > 0 && <FactList rows={facts} />}

      {assumption.newEvidence && <NewEvidence news={assumption.newEvidence} />}

      {detail?.forest && detail.forest.length > 0 && (
        <div>
          <VcrForestPlot rows={detail.forest} unit={assumption.value.unit} />
          {detail.forestNote && <p className="mt-2 text-caption text-text-3">{detail.forestNote}</p>}
        </div>
      )}

      {detail?.quote && (
        <figure className="rounded-card border border-border bg-surface-1 p-3">
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
        <Section title="被这些结果使用" level="sub" count={detail.usedBy.length}>
          <List label="使用这张卡的结果">
            {detail.usedBy.map((user) => (
              <ListRow
                key={user.id}
                title={user.label}
                {...(user.tab ? { to: vcrTabPath(studyId, user.tab) } : {})}
                trailing={user.note ? <span className="text-caption text-text-3">{user.note}</span> : undefined}
              />
            ))}
          </List>
        </Section>
      )}

      {detail?.versions && detail.versions.length > 0 && (
        <Section title="改动记录" level="sub" count={detail.versions.length}>
          <DataTable
            label="改动记录"
            minWidth="min-w-0"
            columns={[
              { key: "at", header: "时间", rowHeader: true, width: "w-32", isEmpty: (version) => !version.at, cell: (version) => <span className="tabular-nums text-text-3">{version.at ?? ""}</span> },
              { key: "text", header: "改动", cell: (version) => <span className="text-text">{version.text}</span> },
              { key: "note", header: "说明", isEmpty: (version) => !version.note, cell: (version) => <span className="text-caption text-text-3">{version.note ?? ""}</span> },
            ]}
            rows={detail.versions}
            rowKey={(version) => String(version.version)}
          />
        </Section>
      )}
    </div>
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
        <p data-vcr-after-freeze="" className="mt-1.5"><Tag>{`冻结后新增 v${news.afterFreezeVersion}`}</Tag></p>
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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
