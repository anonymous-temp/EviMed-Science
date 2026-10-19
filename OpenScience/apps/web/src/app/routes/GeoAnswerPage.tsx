import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useNavigationType, useParams } from "react-router";
import { ArrowLeft, ExternalLink, Image as ImageIcon, Radar } from "lucide-react";
import {
  geoScreenshotUrl,
  getGeoAnswer,
  getGeoProject,
  type GeoAction,
  type GeoAnswer,
  type GeoClaim,
  type GeoErrorRow,
} from "@/lib/geoClient";
import { safeWebHref } from "@/lib/readPages";
import { cn } from "@/lib/cn";
import { EmptyState } from "@/components/cards/EmptyState";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { iconButtonClasses } from "@/components/ui/IconButton";
import { navItemClasses } from "@/components/ui/NavItem";
import { Tag } from "@/components/ui/Tag";
import { Tooltip } from "@/components/ui/Tooltip";
import { AnswerChecks } from "@/components/geo/AnswerChecks";
import { useGeoFrame, useGeoToolbar } from "@/components/geo/geoFrame";
import { useGeoEvidence } from "@/components/geo/geoProjectData";
import { scrollBlockToTop } from "@/components/geo/geoScroll";
import { questionGroupIndex, clusterName } from "@/components/geo/spine/clusterModel";
import { ClusterDrawerHost } from "@/components/geo/spine/ClusterDrawerHost";
import { ClusterLink } from "@/components/geo/spine/ClusterLink";
import { useGeoDrawerAddress } from "@/components/geo/spine/drawerParams";
import { claimKeyOf, claimRows, correctionBrief } from "@/components/geo/spine/errorModel";
import { ErrorDrawer } from "@/components/geo/spine/ErrorDrawer";
import { useGeoActions, useGeoQuestionSet } from "@/components/geo/spine/spineData";
import { useOpenGeoConversation } from "@/components/geo/useOpenGeoConversation";
import { answerFindings, type AnswerFinding } from "@/components/geo/answerFindings";
import { markAnswer, type AnswerParagraph } from "@/components/geo/answerMarks";
import { engineName, GEO_ERROR_STATUS_WORDS, GEO_ERROR_TYPE_WORDS, GEO_POOL_KINDS, monthDay, zh } from "@/components/geo/geoText";
import { readableSourceRef } from "@/components/geo/tabs/EvidenceTab";
import { answerPath, MENTION_ONLY_WORD, mentionOnly, SNAPSHOT_STATUS_WORDS, tabPath } from "@/components/geo/tabs/geoTabText";
import { TabError, TabSkeleton, useGeoLoad } from "@/components/geo/tabs/geoTabKit";

/** The sentence a direct link lands on where the module is off (the shell's off page says the same). */
const GEO_OFF_SENTENCE = "循证 GEO 还没有在这个工作空间开放。";

/**
 * One question, one engine, one day's answer (plan §5.4, mockup g07): on the
 * left the engines asked the same question in the same round, on the right
 * what this one answered — our product's names in bold, each wrong sentence
 * about us underlined in wavy red, and under it what is right, which label
 * says so, which cited source the engine took it from, and what has been done
 * about it. The date switcher at the top right moves between the days this
 * question was asked of this engine; the screenshot is the proof of record.
 */
export function GeoAnswerPage() {
  const { geoId = "", snapshotId = "" } = useParams();
  const answer = useGeoLoad(`answer:${geoId}:${snapshotId}`, () => getGeoAnswer(geoId, snapshotId));
  // Both only enrich the page: the project names the conversation “问 AI”
  // opens and our product's names; the claims say what is right and where.
  // Inside a project's layout the project is the layout's, and the claims are the project's shared read.
  const frame = useGeoFrame();
  const fetched = useGeoLoad(`project:${geoId}`, () => (frame ? Promise.resolve(frame.project) : getGeoProject(geoId)));
  const evidence = useGeoEvidence(geoId);
  // The records a mark on the answer opens: the question's group, and the actions that correct a claim.
  const actions = useGeoActions(geoId);
  const questionSet = useGeoQuestionSet(geoId);

  if (answer.state.kind === "error" && answer.state.off) {
    return <Shell title="循证 GEO"><EmptyState icon={Radar} title={GEO_OFF_SENTENCE} /></Shell>;
  }
  if (answer.state.kind === "error" && answer.state.missing) {
    return (
      <Shell title="回答" back={<BackLink geoId={geoId} fallback="overview" />}>
        <EmptyState icon={Radar} title="这条回答不存在或已删除。" />
      </Shell>
    );
  }
  if (answer.state.kind !== "ready") {
    return (
      <Shell title="回答" back={<BackLink geoId={geoId} fallback="overview" />}>
        {answer.state.kind === "error" ? <TabError message={answer.state.message} onRetry={answer.reload} /> : <TabSkeleton rows={4} />}
      </Shell>
    );
  }

  const data = answer.state.data;
  const loadedProject = frame ? frame.project : fetched.state.kind === "ready" ? fetched.state.data : null;
  const claims = evidence.state.kind === "ready" && Array.isArray(evidence.state.data?.claims) ? evidence.state.data.claims : [];
  const everyAction = actions.state.kind === "ready" && Array.isArray(actions.state.data?.actions) ? actions.state.data.actions : [];
  const groups = questionSet.state.kind === "ready" ? questionSet.state.data?.groups : undefined;
  return <Answer geoId={geoId} data={data} project={loadedProject} claims={claims} actions={everyAction} groups={groups} />;
}

/**
 * The answer's place on the page. It is read inside the project's band (the layout draws the page, its scroll, its title and the
 * steps, and keeps 问题与回答 selected), so this is only the answer's own heading and body: a second `h1` and a second scroll
 * container here were the "page of its own" that took the band away.
 */
function Shell({ title, back, header, children }: { title: string; back?: ReactNode; header?: ReactNode; children: ReactNode }) {
  return (
    <div data-geo-answer-page="">
      {header ?? (
        <header className="flex min-h-8 items-center gap-2">
          {back}
          <h2 className="min-w-0 text-section font-semibold text-text">{title}</h2>
        </header>
      )}
      <div className="mt-6">{children}</div>
    </div>
  );
}

const BACK_NAMES = { accuracy: "准确与安全", questions: "问题与回答", overview: "总览" } as const;

/**
 * The way back. A reader who came from inside the app goes back to where they came from — the list as they left it, the filter in
 * its address included; one who opened the answer from a link has no such place, and is taken to the tab that holds it.
 */
function BackLink({ geoId, fallback }: { geoId: string; fallback: keyof typeof BACK_NAMES }) {
  const navigate = useNavigate();
  const arrived = useNavigationType();
  const fromInside = arrived !== "POP";
  const label = fromInside ? "返回" : `返回${BACK_NAMES[fallback]}`;
  return (
    <Tooltip content={label} kind="label">
      {fromInside ? (
        <button type="button" aria-label={label} onClick={() => navigate(-1)} className={iconButtonClasses()}>
          <ArrowLeft size={16} aria-hidden="true" />
        </button>
      ) : (
        <Link to={tabPath(geoId, fallback)} aria-label={label} className={iconButtonClasses()}>
          <ArrowLeft size={16} aria-hidden="true" />
        </Link>
      )}
    </Tooltip>
  );
}

type Project = Awaited<ReturnType<typeof getGeoProject>>;

function Answer({
  geoId,
  data,
  project,
  claims,
  actions,
  groups,
}: {
  geoId: string;
  data: GeoAnswer;
  project: Project | null;
  claims: GeoClaim[];
  actions: readonly GeoAction[];
  groups: Parameters<typeof questionGroupIndex>[0];
}) {
  const navigate = useNavigate();
  const drawer = useGeoDrawerAddress();
  const open = useOpenGeoConversation();
  const [asking, setAsking] = useState(false);
  const snapshot = data.snapshot;
  const question = data.question?.text || "回答";
  const date = monthDay(snapshot.askedAt);
  const pool = data.question?.pool && data.question.pool in GEO_POOL_KINDS ? GEO_POOL_KINDS[data.question.pool] : null;
  // What is marked in the answer is what the answer says; a row about an earlier answer is kept apart from its text.
  const found = answerFindings(data);
  const wrongSentences = found.findings.map((finding) => finding.sentence);
  const history = dedupeHistory(data.history, snapshot.id, snapshot.askedAt);
  const product = project?.product;
  const ours = [
    ...(Array.isArray(data.facts?.brands) ? data.facts.brands.filter((brand) => brand?.ours).map((brand) => brand.name) : []),
    product?.brandName, product?.genericName, ...(Array.isArray(product?.aliases) ? product.aliases : []),
  ].filter((name): name is string => typeof name === "string" && !!name);
  const marked = snapshot.answerText && snapshot.status !== "suspect" && snapshot.status !== "failed"
    ? markAnswer(snapshot.answerText, { wrong: wrongSentences, ours })
    : { paragraphs: [] as AnswerParagraph[], unplaced: [] as string[] };
  const placed = marked.paragraphs.reduce((sum, paragraph) => sum + paragraph.wrong.length, 0);
  const screenshot = snapshot.screenshot && snapshot.screenshotSha256 ? geoScreenshotUrl(geoId, snapshot.screenshotSha256) : null;
  const target = project ? { projectId: project.projectId, sessionId: project.sessionId } : null;
  const group = data.question?.id ? questionGroupIndex(groups).get(data.question.id) ?? null : null;
  const article = useRef<HTMLElement>(null);
  const firstWrong = () => {
    const span = article.current?.querySelector<HTMLElement>("[data-geo-wrong]");
    // The page's own ground moves to it, not the app shell (`scrollBlockToTop`).
    if (span) scrollBlockToTop(span);
  };
  // The page opens on the sentence it is about: the first wrong one is brought to the top of the page, once for each answer.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(firstWrong, [snapshot.id]);

  // The date switcher and the screenshot are the band's toolbar, above what they control (a day's answer, and the proof of it).
  useGeoToolbar(history.length > 1 || screenshot ? {
    filters: history.length > 1 ? [{
      kind: "select",
      label: "测量日期",
      options: history.map((entry) => ({ value: entry.snapshotId, label: monthDay(entry.sampleDate) ?? entry.sampleDate })),
      value: snapshot.id,
      // Another day's answer replaces this one in the history: the way back is still the list.
      onChange: (value) => { if (value && value !== snapshot.id) navigate(answerPath(geoId, value), { replace: true }); },
    }] : undefined,
    actions: screenshot ? (
      <a href={screenshot} target="_blank" rel="noreferrer" className={buttonClasses({ variant: "text", size: "sm" })}>
        <ImageIcon size={16} aria-hidden="true" />
        截图
      </a>
    ) : undefined,
  } : null);

  // The one action of the page: have the correction written where the answer is wrong, else talk the answer over.
  const claimOf = found.findings.find((finding) => finding.error)?.error ?? null;
  const productName = product?.brandName || product?.genericName || project?.name || "我们";
  const everyClaim = useMemo(() => claimRows(Array.isArray(data.errors) ? data.errors.filter((row) => row && row.id) : []), [data.errors]);
  const lead = claimOf ? everyClaim.find((claim) => claim.key === claimKeyOf(claimOf)) ?? null : null;
  const ask = () => {
    if (!target) return;
    setAsking(true);
    const draft = lead
      ? correctionBrief(lead, productName)
      : zh`${engineName(snapshot.engine)}对“${question}”的回答${date ? `（${date}）` : ""}，对我们意味着什么，接下来该做什么？`;
    // A request about one answer opens a fresh conversation: the project's latest may be a strategy run's own session.
    void open({ projectId: target.projectId, sessionId: null }, draft).finally(() => setAsking(false));
  };
  const groupMap = useMemo(() => questionGroupIndex(groups), [groups]);
  const opened = drawer.error ? everyClaim.find((claim) => claim.key === drawer.error) ?? null : null;
  const basisOf = (claim: (typeof everyClaim)[number]) => {
    // The judge's statement names the card's claim where the error row does not.
    const id = claim.claimId ?? found.findings.find((finding) => finding.error && claimKeyOf(finding.error) === claim.key)?.statement?.claimId ?? null;
    const row = id ? claims.find((entry) => entry.id === id) ?? null : null;
    return row ? row.sourceLabel || readableSourceRef(row.sourceRef) : null;
  };

  const header = (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2">
        <BackLink geoId={geoId} fallback={found.findings.length > 0 || found.elsewhere.length > 0 ? "accuracy" : "questions"} />
        <div className="min-w-0">
          <h2 className="min-w-0 text-section font-semibold text-text">{question}</h2>
          <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-caption text-text-3">
            <span>{engineName(snapshot.engine)}</span>
            {date && <span className="tabular-nums">{date}</span>}
            {pool && <span>{pool}</span>}
            {group && <ClusterLink groupId={group.id} className="text-link">{clusterName(group)}</ClusterLink>}
          </p>
        </div>
      </div>
      {target && (
        // The answer's own step, not the module's next one: a secondary button in the answer's heading row, as 确认后联系 is in its
        // person's row (T3: the one primary action of a module page is the band header's).
        <Button data-geo-answer-primary="" variant="secondary" loading={asking} onClick={ask}>{lead ? "写纠错稿" : "在对话中处理"}</Button>
      )}
    </header>
  );

  return (
    <Shell title={question} header={header}>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-8 md:grid-cols-[13rem_minmax(0,1fr)]">
        <Engines geoId={geoId} data={data} wrongCount={found.findings.length} />
        <article ref={article} data-geo-answer={snapshot.id} className="min-w-0">
          {placed > 0 && (
            <p data-geo-answer-note="" className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-ui text-text-2">
              <span>{zh`${engineName(snapshot.engine)}的原回答，标红处与说明书不一致。`}</span>
              <Button variant="text" size="sm" onClick={firstWrong}>看第 1 处</Button>
            </p>
          )}
          <AnswerBody data={data} marked={marked} findings={found.findings} claims={claims} onOpen={(key) => drawer.open({ error: key })} />
          <AnswerChecks facts={data.facts} />
          <Citations citations={snapshot.citations} />
          <Elsewhere geoId={geoId} current={snapshot.id} errors={found.elsewhere} unplaced={marked.unplaced} findings={found.findings} />
        </article>
      </div>
      {project && opened && (
        <ErrorDrawer geoId={geoId} project={project} claim={opened} actions={actions} groupOf={groupMap} basis={basisOf(opened)} onClose={drawer.close} />
      )}
      {project && <ClusterDrawerHost geoId={geoId} project={project} />}
    </Shell>
  );
}

function dedupeHistory(history: GeoAnswer["history"] | null | undefined, currentId: string, askedAt: string): Array<{ sampleDate: string; snapshotId: string }> {
  const entries = (Array.isArray(history) ? history : []).filter((entry) => entry && entry.snapshotId && entry.sampleDate);
  if (!entries.some((entry) => entry.snapshotId === currentId)) entries.push({ sampleDate: askedAt, snapshotId: currentId });
  const seen = new Set<string>();
  return entries
    .sort((a, b) => (a.sampleDate < b.sampleDate ? 1 : a.sampleDate > b.sampleDate ? -1 : 0))
    .filter((entry) => (seen.has(entry.snapshotId) ? false : (seen.add(entry.snapshotId), true)));
}

/** What an engine's answer did for us, in a word: “讲错 1 处”“提及 · 引用你”“未提及”“未测”. */
function engineWord(sibling: GeoAnswer["siblings"][number]): { text: string; wrong: boolean } {
  if (sibling.status === "absent" || !sibling.snapshotId) return { text: SNAPSHOT_STATUS_WORDS.absent, wrong: false };
  if (sibling.status !== "valid" && sibling.status !== "refusal") return { text: SNAPSHOT_STATUS_WORDS[sibling.status] ?? "—", wrong: false };
  if (typeof sibling.wrongOurs === "number" && sibling.wrongOurs > 0) return { text: `讲错 ${sibling.wrongOurs} 处`, wrong: true };
  if (sibling.status === "refusal") return { text: SNAPSHOT_STATUS_WORDS.refusal, wrong: false };
  if (sibling.mentionsOurs === true) return { text: sibling.citesOurs ? "提及 · 引用你" : "提及", wrong: false };
  if (sibling.mentionsOurs === false) return { text: "未提及", wrong: false };
  return { text: "", wrong: false };
}

function Engines({ geoId, data, wrongCount }: { geoId: string; data: GeoAnswer; wrongCount: number }) {
  const current = data.snapshot;
  const siblings = (Array.isArray(data.siblings) ? data.siblings : []).filter((sibling) => sibling && sibling.engine);
  if (!siblings.some((sibling) => sibling.engine === current.engine)) {
    siblings.unshift({ engine: current.engine, snapshotId: current.id, status: current.status });
  }
  // What this answer did is known from its own facts, whatever the sibling row says.
  const brands = Array.isArray(data.facts?.brands) ? data.facts.brands : [];
  const own = {
    wrongOurs: wrongCount,
    mentionsOurs: data.facts ? brands.some((brand) => brand?.ours) : null,
  };
  return (
    <nav aria-label="AI 引擎" className="min-w-0 md:border-r md:border-border md:pr-4">
      <ul className="flex flex-row gap-1 overflow-x-auto md:flex-col">
        {siblings.map((sibling) => {
          const selected = sibling.engine === current.engine;
          const facts = selected ? { ...sibling, ...(sibling.wrongOurs == null ? { wrongOurs: own.wrongOurs } : {}), ...(sibling.mentionsOurs == null ? { mentionsOurs: own.mentionsOurs } : {}) } : sibling;
          const word = engineWord(facts);
          const label = (
            <>
              <span className={cn("min-w-0 truncate", selected ? "text-text" : "text-text-2")}>{engineName(sibling.engine)}</span>
              {word.text && <span className={cn("shrink-0 text-caption font-normal", word.wrong ? "text-danger" : "text-text-3")}>{word.text}</span>}
            </>
          );
          const rowClass = navItemClasses({ current: selected, className: "justify-between whitespace-nowrap" });
          return (
            <li key={sibling.engine} data-geo-sibling={sibling.engine}>
              {sibling.snapshotId && !selected ? (
                <Link to={answerPath(geoId, sibling.snapshotId)} replace className={rowClass}>{label}</Link>
              ) : (
                <span aria-current={selected ? "page" : undefined} className={rowClass}>{label}</span>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function AnswerBody({
  data,
  marked,
  findings,
  claims,
  onOpen,
}: {
  data: GeoAnswer;
  marked: { paragraphs: AnswerParagraph[]; unplaced: string[] };
  findings: AnswerFinding[];
  claims: GeoClaim[];
  /** Open the claim's record: the key of the claim a mark is about. */
  onOpen: (claimKey: string) => void;
}) {
  const snapshot = data.snapshot;
  const brands = Array.isArray(data.facts?.brands) ? data.facts.brands : [];
  if (snapshot.status === "suspect" || snapshot.status === "failed") {
    return <p className="text-ui text-text-3">{SNAPSHOT_STATUS_WORDS[snapshot.status]}</p>;
  }
  if (!snapshot.answerText) {
    // The inclusion channel (百度 today) returns only whether we are mentioned.
    const mentioned = brands.some((brand) => brand?.ours);
    return (
      <p className="text-ui text-text">
        {mentionOnly(snapshot.engine) || snapshot.surface?.mode === "inclusion" ? `${MENTION_ONLY_WORD}：` : ""}
        {data.facts ? (mentioned ? "回答里提到了我们的产品。" : "回答里没有提到我们的产品。") : "没有回答原文。"}
      </p>
    );
  }
  const bySentence = new Map(findings.map((finding) => [finding.sentence.trim(), finding]));
  const correction = (sentence: string, key: string) => {
    const finding = bySentence.get(sentence.trim());
    return finding ? <Correction key={key} finding={finding} claims={claims} onOpen={onOpen} /> : null;
  };

  // The engine's answer as it was given, and the drugs it named: the record's content (`data-prose`), not sentences of the page's.
  return (
    <div data-prose="" className="flex max-w-read flex-col gap-4 text-body text-text">
      {snapshot.status === "refusal" && <p><Tag>{SNAPSHOT_STATUS_WORDS.refusal}</Tag></p>}
      {marked.paragraphs.map((paragraph, index) => (
        <Fragment key={index}>
          <Paragraph paragraph={paragraph} />
          {paragraph.wrong.map((sentence, wrongIndex) => correction(sentence, `${index}-${wrongIndex}`))}
        </Fragment>
      ))}
      <Mentioned brands={brands} />
    </div>
  );
}

function Paragraph({ paragraph }: { paragraph: AnswerParagraph }) {
  return (
    <p className="max-w-measure-body whitespace-pre-wrap">
      {paragraph.segments.map((segment, index) => {
        // Our brand in the engine's prose is told by a ground, not a weight: a 600 inside 16 px prose was a sixth size × weight pair
        // on the page (owner, 2026-10-19: a data page uses at most five).
        const body = segment.ours ? <mark data-geo-ours="" className="rounded-tag bg-accent-soft px-0.5 text-text">{segment.text}</mark> : segment.text;
        if (segment.wrong === null) return <Fragment key={index}>{body}</Fragment>;
        return (
          <span key={index} data-geo-wrong="" className="underline decoration-danger decoration-wavy underline-offset-4">
            {body}
          </span>
        );
      })}
    </p>
  );
}

/**
 * Under a wrong sentence, one line: that the platform checked it, what is right, and where the handling stands. The line is the way
 * into the claim's record (a drawer): the label's words, what every engine said, where this one took it from and the correction
 * under way are there, not in a block of the answer's text. A finding with no error row behind it has nothing to open and says only
 * what is right. A part the record does not have is left out rather than guessed.
 */
function Correction({
  finding,
  claims,
  onOpen,
}: {
  finding: AnswerFinding;
  claims: GeoClaim[];
  onOpen: (claimKey: string) => void;
}) {
  const { error, statement } = finding;
  const claimId = error?.claimId ?? statement?.claimId ?? null;
  const claim = claimId ? claims.find((row) => row.id === claimId) ?? null : null;
  const right = claim?.statement || statement?.evidence || error?.evidenceQuote || null;
  const kind = error?.errorType ?? statement?.errorType ?? null;
  const status = error?.status ? GEO_ERROR_STATUS_WORDS[error.status] : null;
  const body = (
    <>
      <span className="text-danger">讲错我方</span>
      {right ? <>：对的是{right.endsWith("。") ? right : `${right}。`}</> : kind ? `：${GEO_ERROR_TYPE_WORDS[kind]}。` : null}
      {status && <span className="ml-2 text-caption text-text-3">{status}</span>}
    </>
  );
  return (
    <div data-geo-correction="" className="flex max-w-measure-body items-baseline gap-2 border-l-2 border-danger pl-4 text-ui text-text-2">
      {/* The platform's finding, not the engine's words: it is marked as such. The tag stands beside the control, never in it. */}
      <Tag className="shrink-0 self-start">核查</Tag>
      {error ? (
        <button
          type="button"
          data-geo-correction-open=""
          onClick={() => onOpen(claimKeyOf(error))}
          className="min-w-0 rounded text-left hover:text-text hover:underline hover:underline-offset-4"
        >
          {body}
        </button>
      ) : <p className="min-w-0">{body}</p>}
    </div>
  );
}

/**
 * Findings the answer's text does not hold: a record of an earlier answer that said the claim in other words, or a sentence of
 * this one the text no longer carries word for word. They are listed after the answer, never inside it — the page must not print
 * a sentence the engine did not say here — with where each was said, when there is such a place.
 */
function Elsewhere({
  geoId,
  current,
  errors,
  unplaced,
  findings,
}: {
  geoId: string;
  current: string;
  errors: GeoErrorRow[];
  unplaced: string[];
  findings: AnswerFinding[];
}) {
  const own = unplaced.map((sentence) => findings.find((finding) => finding.sentence.trim() === sentence.trim())).filter((finding): finding is AnswerFinding => !!finding);
  const count = errors.length + own.length;
  if (count === 0) return null;
  const summary = own.length === 0 ? `更早的回答里也出现过（${errors.length} 条）` : `另有 ${count} 条讲错记录，原句不在上面的回答里`;
  return (
    <Disclosure summary={summary} className="mt-8">
      <ul data-geo-elsewhere="" className="flex flex-col divide-y divide-faint">
        {own.map((finding) => (
          <li key={`own:${finding.sentence}`} className="py-2 text-ui text-text-2">
            <span>{`“${finding.sentence}”`}</span>
            <span className="ml-2 text-caption text-text-3">这条回答里的说法</span>
          </li>
        ))}
        {errors.map((error) => {
          const where = error.firstSnapshotId && error.firstSnapshotId !== current ? error.firstSnapshotId : error.snapshotId && error.snapshotId !== current ? error.snapshotId : null;
          const detail = [monthDay(error.createdAt), GEO_ERROR_STATUS_WORDS[error.status]].filter(Boolean).join(" · ");
          return (
            <li key={error.id} className="flex flex-wrap items-baseline gap-x-2 py-2 text-ui text-text-2">
              <span className="min-w-0">{`“${error.statement}”`}</span>
              {detail && <span className="text-caption text-text-3">{detail}</span>}
              {where && <Link to={answerPath(geoId, where)} replace className="text-caption text-link hover:underline">看那次回答</Link>}
            </li>
          );
        })}
      </ul>
    </Disclosure>
  );
}

/** “提到的药：司美格鲁肽（第 1 个，推荐）、玛仕度肽（第 2 个）” */
function Mentioned({ brands }: { brands: NonNullable<GeoAnswer["facts"]>["brands"] }) {
  const named = brands
    .filter((brand) => brand && brand.name)
    .sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER));
  if (named.length === 0) return null;
  return (
    <p className="text-caption text-text-3">
      {"提到的药："}
      {named.map((brand, index) => (
        <Fragment key={`${brand.name}-${index}`}>
          {index > 0 && "、"}
          <span className={brand.ours ? "text-text" : undefined}>{brand.name}</span>
          {(brand.position || brand.inRecommendation) && `（${[brand.position ? `第 ${brand.position} 个` : null, brand.inRecommendation ? "推荐" : null].filter(Boolean).join("，")}）`}
        </Fragment>
      ))}
    </p>
  );
}

/**
 * What the answer cited. A citation that came back as a title without a link
 * (千问 on 2026-09-25, every one of them) is listed as what it is, not
 * dropped: the reader sees the engine did cite, and that whether it cited us
 * cannot be told (G8).
 */
function Citations({ citations }: { citations: GeoAnswer["snapshot"]["citations"] | null | undefined }) {
  const list = (Array.isArray(citations) ? citations : []).filter((citation) => citation && (citation.url || citation.title));
  if (list.length === 0) return null;
  return (
    <section aria-label="引用的信源" className="mt-10">
      <h2 className="mb-3 text-section font-semibold text-text">引用的信源</h2>
      <ol className="flex flex-col divide-y divide-faint">
        {list.map((citation, index) => {
          const href = safeWebHref(citation.url);
          return (
            <li key={`${citation.url}-${index}`} className="flex items-center gap-3 py-2 text-ui">
              <span className="w-5 shrink-0 text-caption tabular-nums text-text-3">{index + 1}</span>
              <span className="w-24 shrink-0 truncate text-text-2 sm:w-32">{citation.domain || "—"}</span>
              <span className="min-w-0 flex-1 truncate text-text">{citation.title || citation.url}</span>
              {!citation.url && <span data-geo-linkless="" className="shrink-0 text-caption text-text-3">没有链接</span>}
              {citation.url && !citation.inBody && <span className="shrink-0 text-caption text-text-3">只列在参考资料</span>}
              {href && (
                <a href={href} target="_blank" rel="noreferrer" aria-label={`打开${citation.title || citation.domain || "信源"}`} className={iconButtonClasses({ size: "sm" })}>
                  <ExternalLink size={16} aria-hidden="true" />
                </a>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
