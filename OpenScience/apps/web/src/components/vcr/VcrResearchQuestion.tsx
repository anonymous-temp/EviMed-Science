import { useCallback, useEffect, useId, useRef, useState } from "react";
import { VCR_QUESTION_STRATEGIES, VCR_QUESTION_STRATEGY_LABELS_ZH } from "@evimed/domain";
import { getVcrResearchQuestion, saveVcrResearchQuestion, type VcrResearchQuestion } from "@/lib/vcrClient";
import type { VcrResearchQuestionBody } from "@/lib/vcrBodies";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { FactList, type Fact } from "@/components/ui/FactList";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { Note } from "@/components/ui/Note";
import { Section } from "@/components/ui/Section";
import { Tag } from "@/components/ui/Tag";

/**
 * 研究问题与假设: what this study asks, in the attributes of ICH E9(R1), written by the assistant a field at a time from the conversation
 * and edited here. Every field is optional: one nobody wrote is a default the results' premises name, so this card is a place to say
 * more, never a form to finish. What a person changes here is their own edit and stands over what the assistant writes later (the
 * assistant is told which field it could not change). Each event shows whether this simulation can represent it, in the words the
 * premises use; with no model to judge them against an event is shown with its strategy and no tag. Who wrote a field is never shown (it decides which
 * write wins, and is the assistant's to read, not the person's). The rest of the page does not depend on the question being readable.
 * Component: VcrResearchQuestion; owner: VCR; rules: optional fields, page edit is the strongest basis.
 * Anatomy: Section with a fact list, the events with their state, and one editor opened from 编辑.
 * Variants: Written, empty (a recipe and 编辑), editing.
 * States: Loading draws nothing; an unreadable question says so with a retry; a failed save keeps the form and says why; a half-written row is named before anything is sent.
 * Hit area: Shared Button, Input and Select sizing.
 * Keyboard: Native form controls; Enter saves from a single-line field.
 * Long content: Values wrap.
 * Theme: Shared sections, fact list and tags.
 * Responsive: One column.
 * Verification: VcrResearchQuestion.test.tsx.
 */
export function VcrResearchQuestionCard({ studyId, canWrite }: { studyId: string; canWrite: boolean }) {
  const [question, setQuestion] = useState<VcrResearchQuestion | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [unreadable, setUnreadable] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setLoaded(false);
    setUnreadable(null);
    void getVcrResearchQuestion(studyId).then((read) => { if (live) { setQuestion(read); setLoaded(true); } })
      .catch((error: unknown) => { if (live) { setUnreadable(webErrorMessage(error, { fallback: "研究问题暂时读不出来。" })); setLoaded(true); } });
    return () => { live = false; };
  }, [studyId, attempt]);

  // What cannot be read is not offered for writing (an editor over an unknown question could overwrite it), and it says so: the card is a place to
  // say more, so a silent gap would read as "nothing to say here".
  if (!loaded) return null;
  if (unreadable !== null) {
    return (
      <Section title="研究问题与假设">
        <Note tone="warn" action={<Button size="sm" variant="secondary" onClick={() => setAttempt((current) => current + 1)}>重试</Button>}>{unreadable}</Note>
      </Section>
    );
  }
  if (!question && !canWrite) return null;
  if (editing) {
    return (
      <Section title="研究问题与假设">
        <QuestionEditor
          studyId={studyId}
          question={question}
          onDone={(saved) => { if (saved) setQuestion(saved); setEditing(false); }}
        />
      </Section>
    );
  }
  if (!question) {
    return (
      <Section title="研究问题与假设">
        <Note action={<Button size="sm" variant="secondary" actionKind="set" onClick={() => setEditing(true)}>写下研究问题</Button>}>
          还没有写研究问题；在对话里说一句，或在这里直接写，结果会注明它回答的是哪个问题。
        </Note>
      </Section>
    );
  }
  const facts: Fact[] = [
    { label: "研究问题", value: <Written text={question.question} /> },
    { label: "人群", value: <Written text={question.population} /> },
    { label: "治疗条件", value: <Written text={question.treatment} /> },
    { label: "观察的变量", value: <Written text={[question.variable.endpoint, question.variable.scale, question.variable.timePoint].filter(Boolean).join("，")} /> },
    { label: "汇总方式", value: <Written text={question.summary} /> },
    { label: "要做的决定", value: <Written text={[question.decisionContext.decision, question.decisionContext.thresholds].filter(Boolean).join("；")} /> },
    { label: "假设", value: <Written text={question.assumptions.map((entry) => (entry.source ? `${entry.text}（${entry.source}）` : entry.text)).join("；")} /> },
  ].filter((row) => row.value.props.text);
  return (
    <Section
      title="研究问题与假设"
      count={`第 ${question.version} 版`}
      toolbar={canWrite ? <Button size="sm" variant="secondary" actionKind="set" onClick={() => setEditing(true)}>编辑</Button> : undefined}
    >
      <div data-vcr-research-question={question.id} className="flex flex-col gap-4">
        {facts.length > 0 && <FactList rows={facts} />}
        {question.events.length > 0 && (
          <ul aria-label="中途事件" className="flex flex-col gap-2">
            {question.events.map((event, at) => (
              <li key={`${at}-${event.event}`} data-vcr-question-event={event.state} className="flex flex-wrap items-center gap-2 text-ui text-text">
                <span>{event.event}</span>
                <span className="text-text-2">{event.strategyLabel ?? "处理方式还没有写"}</span>
                {event.mechanism && <span className="text-text-2">{event.mechanism}</span>}
                {event.stateLabel && <Tag tone={event.state === "not_representable" ? "warn" : "neutral"}>{event.stateLabel}</Tag>}
              </li>
            ))}
          </ul>
        )}
        {question.calibration?.differs && canWrite && (
          <Note tone="warn" action={<Button size="sm" variant="secondary" onClick={() => setEditing(true)}>改处理方式</Button>}>
            {question.calibration.sentence}；你写的处理方式与此不同。
          </Note>
        )}
      </div>
    </Section>
  );
}

/** A written value. */
function Written({ text }: { text: string }) {
  return <span className="whitespace-pre-wrap break-words">{text}</span>;
}

export interface Draft {
  question: string;
  population: string;
  treatment: string;
  endpoint: string;
  scale: string;
  timePoint: string;
  summary: string;
  decision: string;
  thresholds: string;
  events: Array<{ event: string; strategy: string; mechanism: string }>;
  assumptions: Array<{ text: string; source: string }>;
}

function draftOf(question: VcrResearchQuestion | null): Draft {
  return {
    question: question?.question ?? "", population: question?.population ?? "", treatment: question?.treatment ?? "",
    endpoint: question?.variable.endpoint ?? "", scale: question?.variable.scale ?? "", timePoint: question?.variable.timePoint ?? "",
    summary: question?.summary ?? "", decision: question?.decisionContext.decision ?? "", thresholds: question?.decisionContext.thresholds ?? "",
    events: (question?.events ?? []).map((event) => ({ event: event.event, strategy: event.strategy ?? "", mechanism: event.mechanism })),
    assumptions: (question?.assumptions ?? []).map((entry) => ({ ...entry })),
  };
}

/** The fields that differ from what was loaded, and only those: an untouched field is not re-stated as the person's edit. */
/**
 * The first row the person half-wrote, named in words (an event with a handling but no event text; an assumption with a source but no text), or null.
 * A row left wholly blank is no problem: it is dropped from what is sent.
 */
export function halfWrittenRow(draft: Draft): string | null {
  const event = draft.events.findIndex((entry) => !entry.event.trim() && (entry.strategy || entry.mechanism.trim()));
  if (event >= 0) return `第 ${event + 1} 个中途事件还没有写事件本身：写上，或删除这一行，再保存。`;
  const assumption = draft.assumptions.findIndex((entry) => !entry.text.trim() && entry.source.trim());
  if (assumption >= 0) return `第 ${assumption + 1} 条假设只写了来源：写上假设本身，或删除这一行，再保存。`;
  return null;
}

export function changedFields(was: Draft, now: Draft): VcrResearchQuestionBody {
  const body: VcrResearchQuestionBody = {};
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const clean = (value: string) => value.trim();
  if (clean(was.question) !== clean(now.question)) body.question = now.question;
  if (clean(was.population) !== clean(now.population)) body.population = { text: now.population };
  if (clean(was.treatment) !== clean(now.treatment)) body.treatment = { text: now.treatment };
  const variable: NonNullable<VcrResearchQuestionBody["variable"]> = {};
  if (clean(was.endpoint) !== clean(now.endpoint)) variable.endpoint = now.endpoint;
  if (clean(was.scale) !== clean(now.scale)) variable.scale = now.scale;
  if (clean(was.timePoint) !== clean(now.timePoint)) variable.timePoint = now.timePoint;
  if (Object.keys(variable).length) body.variable = variable;
  if (clean(was.summary) !== clean(now.summary)) body.summary = now.summary;
  const decision: NonNullable<VcrResearchQuestionBody["decisionContext"]> = {};
  if (clean(was.decision) !== clean(now.decision)) decision.decision = now.decision;
  if (clean(was.thresholds) !== clean(now.thresholds)) decision.thresholds = now.thresholds;
  if (Object.keys(decision).length) body.decisionContext = decision;
  const trimmedEvents = (draft: Draft) => draft.events.map((entry) => ({ event: entry.event.trim(), strategy: entry.strategy, mechanism: entry.mechanism.trim() })).filter((entry) => entry.event);
  // a row nothing was written in is not part of the question: it is dropped here, never sent
  if (!same(trimmedEvents(was), trimmedEvents(now))) body.intercurrentEvents = now.events.filter((entry) => entry.event.trim() || entry.strategy || entry.mechanism.trim()).map((entry) => ({ event: entry.event, strategy: entry.strategy || null, mechanism: entry.mechanism }));
  const trimmedAssumptions = (draft: Draft) => draft.assumptions.map((entry) => ({ text: entry.text.trim(), source: entry.source.trim() })).filter((entry) => entry.text);
  if (!same(trimmedAssumptions(was), trimmedAssumptions(now))) body.assumptions = now.assumptions.filter((entry) => entry.text.trim() || entry.source.trim());
  return body;
}

function QuestionEditor({ studyId, question, onDone }: { studyId: string; question: VcrResearchQuestion | null; onDone: (saved: VcrResearchQuestion | null) => void }) {
  const initial = useRef(draftOf(question));
  const [draft, setDraft] = useState<Draft>(initial.current);
  const [busy, setBusy] = useState(false);
  const holding = useRef(false);
  const ids = useId();
  const set = useCallback(<K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value })), []);

  const save = () => {
    if (holding.current) return;
    const half = halfWrittenRow(draft);
    if (half) { toast.error(half); return; }
    const body = changedFields(initial.current, draft);
    if (Object.keys(body).length === 0) { onDone(null); return; }
    holding.current = true;
    setBusy(true);
    void saveVcrResearchQuestion(studyId, body)
      .then((saved) => { toast.success("研究问题已保存。"); onDone(saved); })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "研究问题暂时无法保存，请稍后重试。" })))
      .finally(() => { holding.current = false; setBusy(false); });
  };

  return (
    <form data-vcr-research-question-form="" className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); save(); }}>
      <Textarea id={`${ids}-q`} label="研究问题" value={draft.question} onChange={(event) => set("question", event.target.value)} rows={2} maxLength={1000} placeholder="用你自己的话写：这项研究想知道什么" />
      <Textarea id={`${ids}-p`} label="人群" value={draft.population} onChange={(event) => set("population", event.target.value)} rows={2} maxLength={300} />
      <Textarea id={`${ids}-t`} label="治疗条件" value={draft.treatment} onChange={(event) => set("treatment", event.target.value)} rows={2} maxLength={300} placeholder="药物、剂量、疗程，对照是什么" />
      <div className="grid gap-4 md:grid-cols-3">
        <Input id={`${ids}-e`} label="终点" value={draft.endpoint} onChange={(event) => set("endpoint", event.target.value)} maxLength={300} />
        <Input id={`${ids}-s`} label="量表" value={draft.scale} onChange={(event) => set("scale", event.target.value)} maxLength={300} />
        <Input id={`${ids}-w`} label="时间点" value={draft.timePoint} onChange={(event) => set("timePoint", event.target.value)} maxLength={300} />
      </div>
      <Input id={`${ids}-m`} label="汇总方式" value={draft.summary} onChange={(event) => set("summary", event.target.value)} maxLength={300} placeholder="例如：第 78 周平均变化的差" />
      <div className="grid gap-4 md:grid-cols-2">
        <Input id={`${ids}-d`} label="要做的决定" value={draft.decision} onChange={(event) => set("decision", event.target.value)} maxLength={300} />
        <Input id={`${ids}-h`} label="判断的界值" value={draft.thresholds} onChange={(event) => set("thresholds", event.target.value)} maxLength={300} />
      </div>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-ui text-text">中途事件及其处理</legend>
        {draft.events.map((entry, at) => (
          <div key={at} data-vcr-event-row="" className="grid items-end gap-3 md:grid-cols-[1fr_1fr_1fr_auto]">
            <Input id={`${ids}-ev${at}`} label="事件" value={entry.event} onChange={(event) => set("events", draft.events.map((row, index) => (index === at ? { ...row, event: event.target.value } : row)))} maxLength={300} placeholder="例如：因不良反应停药" />
            <Select id={`${ids}-st${at}`} label="处理方式" value={entry.strategy} onChange={(event) => set("events", draft.events.map((row, index) => (index === at ? { ...row, strategy: event.target.value } : row)))}>
              <option value="">先不写</option>
              {VCR_QUESTION_STRATEGIES.map((strategy) => <option key={strategy} value={strategy}>{VCR_QUESTION_STRATEGY_LABELS_ZH[strategy]}</option>)}
            </Select>
            <Input id={`${ids}-me${at}`} label="怎么发生的" value={entry.mechanism} onChange={(event) => set("events", draft.events.map((row, index) => (index === at ? { ...row, mechanism: event.target.value } : row)))} maxLength={300} />
            <Button size="sm" variant="text" onClick={() => set("events", draft.events.filter((_, index) => index !== at))}>删除</Button>
          </div>
        ))}
        {draft.events.length < 12 && <div><Button size="sm" variant="secondary" onClick={() => set("events", [...draft.events, { event: "", strategy: "", mechanism: "" }])}>添加事件</Button></div>}
      </fieldset>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-ui text-text">假设及其来源</legend>
        {draft.assumptions.map((entry, at) => (
          <div key={at} data-vcr-assumption-row="" className="grid items-end gap-3 md:grid-cols-[2fr_1fr_auto]">
            <Input id={`${ids}-as${at}`} label="假设" value={entry.text} onChange={(event) => set("assumptions", draft.assumptions.map((row, index) => (index === at ? { ...row, text: event.target.value } : row)))} maxLength={300} />
            <Input id={`${ids}-so${at}`} label="来源" value={entry.source} onChange={(event) => set("assumptions", draft.assumptions.map((row, index) => (index === at ? { ...row, source: event.target.value } : row)))} maxLength={300} />
            <Button size="sm" variant="text" onClick={() => set("assumptions", draft.assumptions.filter((_, index) => index !== at))}>删除</Button>
          </div>
        ))}
        {draft.assumptions.length < 20 && <div><Button size="sm" variant="secondary" onClick={() => set("assumptions", [...draft.assumptions, { text: "", source: "" }])}>添加假设</Button></div>}
      </fieldset>
      <div className="flex gap-3">
        <Button actionKind="set" type="submit" disabled={busy} loading={busy}>保存</Button>
        <Button variant="text" disabled={busy} onClick={() => onDone(null)}>取消</Button>
      </div>
    </form>
  );
}
