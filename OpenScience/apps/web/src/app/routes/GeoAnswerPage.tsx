import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { Link, useNavigate, useNavigationType, useParams } from "react-router";
import { ArrowLeft, ExternalLink, Image as ImageIcon, Radar } from "lucide-react";
import {
  geoScreenshotUrl,
  getGeoAnswer,
  getGeoEvidence,
  getGeoProject,
  type GeoAnswer,
  type GeoClaim,
  type GeoErrorRow,
} from "@/lib/geoClient";
import { safeWebHref } from "@/lib/readPages";
import { cn } from "@/lib/cn";
import { EmptyState } from "@/components/cards/EmptyState";
import { PageTitle } from "@/components/layout/PageTitle";
import { PAGE_TITLE_CLASS } from "@/components/layout/PageHeader";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { FilterSelect } from "@/components/ui/FilterChips";
import { iconButtonClasses } from "@/components/ui/IconButton";
import { navItemClasses } from "@/components/ui/NavItem";
import { Tag } from "@/components/ui/Tag";
import { Tooltip } from "@/components/ui/Tooltip";
import { AnswerChecks } from "@/components/geo/AnswerChecks";
import { AskAi } from "@/components/geo/AskAi";
import { answerFindings, type AnswerFinding } from "@/components/geo/answerFindings";
import { markAnswer, type AnswerParagraph } from "@/components/geo/answerMarks";
import { engineName, GEO_ERROR_ACTION_WORDS, GEO_ERROR_STATUS_WORDS, GEO_ERROR_TYPE_WORDS, GEO_MONITORING_TITLE, GEO_POOL_KINDS, monthDay, zh } from "@/components/geo/geoText";
import { readableSourceRef } from "@/components/geo/tabs/EvidenceTab";
import { answerPath, CITED_ATTRIBUTE_WORDS, MENTION_ONLY_WORD, mentionOnly, SNAPSHOT_STATUS_WORDS, tabPath } from "@/components/geo/tabs/geoTabText";
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
  const project = useGeoLoad(`project:${geoId}`, () => getGeoProject(geoId));
  const evidence = useGeoLoad(`evidence:${geoId}`, () => getGeoEvidence(geoId));

  if (answer.state.kind === "error" && answer.state.off) {
    return <Shell title="循证 GEO" section="循证 GEO"><EmptyState icon={Radar} title={GEO_OFF_SENTENCE} /></Shell>;
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
  const loadedProject = project.state.kind === "ready" ? project.state.data : null;
  const claims = evidence.state.kind === "ready" && Array.isArray(evidence.state.data?.claims) ? evidence.state.data.claims : [];
  return <Answer geoId={geoId} data={data} project={loadedProject} claims={claims} />;
}

/** `section` is the browser tab's second part: the answer page is one of the module's measurement screens, 「AI 回答监测」. */
function Shell({ title, section = GEO_MONITORING_TITLE, back, header, children }: { title: string; section?: string; back?: ReactNode; header?: ReactNode; children: ReactNode }) {
  return (
    <div className="h-full min-h-0 overflow-y-auto bg-bg">
      <div className="mx-auto w-full max-w-page px-6 py-6">
        <PageTitle page={title} section={section} />
        {header ?? (
          <header className="flex min-h-8 items-center gap-2">
            {back}
            <h1 className={PAGE_TITLE_CLASS}>{title}</h1>
          </header>
        )}
        <div className="mt-6">{children}</div>
      </div>
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

function Answer({ geoId, data, project, claims }: { geoId: string; data: GeoAnswer; project: Project | null; claims: GeoClaim[] }) {
  const navigate = useNavigate();
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
  const article = useRef<HTMLElement>(null);
  const firstWrong = () => {
    const span = article.current?.querySelector<HTMLElement>("[data-geo-wrong]");
    if (!span || typeof span.scrollIntoView !== "function") return;
    const still = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    span.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
  };
  // The page opens on the sentence it is about: the first wrong one is brought to the middle, once for each answer.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(firstWrong, [snapshot.id]);

  const header = (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <BackLink geoId={geoId} fallback={found.findings.length > 0 || found.elsewhere.length > 0 ? "accuracy" : "questions"} />
        <h1 className={cn(PAGE_TITLE_CLASS, "min-w-0")}>{question}</h1>
        {pool && <span className="shrink-0 text-caption text-text-3">{pool}</span>}
      </div>
      <div className="flex items-center gap-2">
        {history.length > 1 ? (
          <FilterSelect<string>
            label="测量日期"
            options={history.map((entry) => ({ value: entry.snapshotId, label: monthDay(entry.sampleDate) ?? entry.sampleDate }))}
            value={snapshot.id}
            // Another day's answer replaces this one in the history: the way back is still the list.
            onChange={(value) => { if (value && value !== snapshot.id) navigate(answerPath(geoId, value), { replace: true }); }}
          />
        ) : date && <span className="text-caption tabular-nums text-text-3">{date}</span>}
        {screenshot && (
          <a href={screenshot} target="_blank" rel="noreferrer" className={buttonClasses({ variant: "text", size: "sm" })}>
            <ImageIcon size={16} aria-hidden="true" />
            截图
          </a>
        )}
      </div>
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
          <AnswerBody data={data} marked={marked} findings={found.findings} claims={claims} />
          {target && (
            <div className="mt-4">
              <AskAi
                project={target}
                draft={wrongSentences.length
                  ? zh`${engineName(snapshot.engine)}回答“${question}”时说“${wrongSentences[0]}”${date ? `（${date}）` : ""}，和说明书不一致。它为什么这么说，怎么纠正？`
                  : zh`${engineName(snapshot.engine)}对“${question}”的回答${date ? `（${date}）` : ""}，对我们意味着什么，接下来该做什么？`}
              />
            </div>
          )}
          <AnswerChecks facts={data.facts} />
          <Citations citations={snapshot.citations} />
          <Elsewhere geoId={geoId} current={snapshot.id} errors={found.elsewhere} unplaced={marked.unplaced} findings={found.findings} />
        </article>
      </div>
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
              {word.text && <span className={cn("shrink-0 text-caption", word.wrong ? "text-danger" : "text-text-3")}>{word.text}</span>}
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
}: {
  data: GeoAnswer;
  marked: { paragraphs: AnswerParagraph[]; unplaced: string[] };
  findings: AnswerFinding[];
  claims: GeoClaim[];
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
  const citations = Array.isArray(snapshot.citations) ? snapshot.citations : [];
  const bySentence = new Map(findings.map((finding) => [finding.sentence.trim(), finding]));
  const correction = (sentence: string, key: string) => {
    const finding = bySentence.get(sentence.trim());
    return finding ? <Correction key={key} finding={finding} claims={claims} citations={citations} /> : null;
  };

  return (
    <div className="flex max-w-read flex-col gap-4 text-body text-text">
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
        const body = segment.ours ? <strong className="font-semibold">{segment.text}</strong> : segment.text;
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
 * Under a wrong sentence: what is right, which label (or source) says so,
 * which cited source the engine took it from, and what has been done — the
 * error trace's columns in the reader's words. A part the record does not
 * have is left out rather than guessed.
 */
function Correction({
  finding,
  claims,
  citations,
}: {
  finding: AnswerFinding;
  claims: GeoClaim[];
  citations: GeoAnswer["snapshot"]["citations"];
}) {
  const { error, statement } = finding;
  const claimId = error?.claimId ?? statement?.claimId ?? null;
  const claim = claimId ? claims.find((row) => row.id === claimId) ?? null : null;
  const right = claim?.statement || statement?.evidence || error?.evidenceQuote || null;
  const kind = error?.errorType ?? statement?.errorType ?? null;
  const cited = error?.citedSource ?? null;
  const citationIndex = cited?.url ? citations.findIndex((citation) => citation.url === cited.url) : -1;
  const citation = citationIndex >= 0 ? citations[citationIndex] : null;
  const source = cited && (cited.domain || citation)
    ? [citationIndex >= 0 ? `[${citationIndex + 1}]` : null, citation?.title || cited.domain].filter(Boolean).join(" ")
      + (cited.attribute && CITED_ATTRIBUTE_WORDS[cited.attribute] ? `（${CITED_ATTRIBUTE_WORDS[cited.attribute]}）` : "")
    : cited?.attribute === "none" ? CITED_ATTRIBUTE_WORDS.none : null;
  const action = error?.action ? GEO_ERROR_ACTION_WORDS[error.action] : null;
  const status = error?.status ? GEO_ERROR_STATUS_WORDS[error.status] : null;
  // The reader's name for the source, never its internal address (G14:
  // “web-page:e1edc04a…” was printed here).
  const basis = claim ? claim.sourceLabel || readableSourceRef(claim.sourceRef) : null;

  return (
    <div data-geo-correction="" className="flex max-w-measure-body flex-col gap-1 border-l-2 border-danger pl-4 text-ui text-text-2">
      <p>
        {/* The platform's finding, not the engine's words: it is marked as such. */}
        <Tag className="mr-2 align-middle">核查</Tag>
        <span className="text-danger">讲错我方</span>
        {right ? <>：对的是{right.endsWith("。") ? right : `${right}。`}</> : kind ? `：${GEO_ERROR_TYPE_WORDS[kind]}。` : null}
      </p>
      {basis && <p>{`依据：${basis}`}</p>}
      {source && <p>{`出处：${source}`}</p>}
      {(action || status) && <p>{`处置：${[action, status].filter(Boolean).join(" · ")}`}</p>}
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
          <span className={brand.ours ? "font-semibold text-text-2" : undefined}>{brand.name}</span>
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
      <h2 className="mb-3 text-ui font-semibold text-text">引用的信源</h2>
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
