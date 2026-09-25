import { Fragment, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, ExternalLink, Image as ImageIcon, Radar } from "lucide-react";
import {
  geoScreenshotUrl,
  getGeoAnswer,
  getGeoEvidence,
  getGeoProject,
  type GeoAnswer,
  type GeoClaim,
  type GeoErrorRow,
  type GeoStatementFact,
} from "@/lib/geoClient";
import { safeWebHref } from "@/lib/readPages";
import { cn } from "@/lib/cn";
import { EmptyState } from "@/components/cards/EmptyState";
import { PageTitle } from "@/components/layout/PageTitle";
import { PAGE_TITLE_CLASS } from "@/components/layout/PageHeader";
import { FilterSelect } from "@/components/ui/FilterChips";
import { Tag } from "@/components/ui/Tag";
import { AskAi } from "@/components/geo/AskAi";
import { markAnswer, type AnswerParagraph } from "@/components/geo/answerMarks";
import { engineName, GEO_ERROR_ACTION_WORDS, GEO_ERROR_STATUS_WORDS, GEO_ERROR_TYPE_WORDS, GEO_POOL_KINDS, monthDay } from "@/components/geo/geoText";
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
  // Both only enrich the page: the project names the conversation 「问 AI」
  // opens and our product's names; the claims say what is right and where.
  const project = useGeoLoad(`project:${geoId}`, () => getGeoProject(geoId));
  const evidence = useGeoLoad(`evidence:${geoId}`, () => getGeoEvidence(geoId));

  if (answer.state.kind === "error" && answer.state.off) {
    return <Shell title="循证 GEO"><EmptyState icon={Radar} title={GEO_OFF_SENTENCE} /></Shell>;
  }
  if (answer.state.kind === "error" && answer.state.missing) {
    return (
      <Shell title="回答" back={tabPath(geoId, "diagnosis")}>
        <EmptyState icon={Radar} title="这条回答不存在或已删除。" />
      </Shell>
    );
  }
  if (answer.state.kind !== "ready") {
    return (
      <Shell title="回答" back={tabPath(geoId, "diagnosis")}>
        {answer.state.kind === "error" ? <TabError message={answer.state.message} onRetry={answer.reload} /> : <TabSkeleton rows={4} />}
      </Shell>
    );
  }

  const data = answer.state.data;
  const loadedProject = project.state.kind === "ready" ? project.state.data : null;
  const claims = evidence.state.kind === "ready" && Array.isArray(evidence.state.data?.claims) ? evidence.state.data.claims : [];
  return <Answer geoId={geoId} data={data} project={loadedProject} claims={claims} />;
}

function Shell({ title, back, header, children }: { title: string; back?: string; header?: ReactNode; children: ReactNode }) {
  return (
    <div className="h-full min-h-0 overflow-y-auto bg-bg">
      <div className="mx-auto w-full max-w-page px-6 py-6">
        <PageTitle page={title} section="循证 GEO" />
        {header ?? (
          <header className="flex min-h-8 items-center gap-2">
            {back && <BackLink to={back} />}
            <h1 className={PAGE_TITLE_CLASS}>{title}</h1>
          </header>
        )}
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

function BackLink({ to }: { to: string }) {
  return (
    <Link to={to} aria-label="返回诊断" title="返回诊断" className="inline-grid h-8 w-8 shrink-0 place-items-center rounded text-text-3 hover:bg-surface-2 hover:text-text">
      <ArrowLeft size={20} aria-hidden="true" />
    </Link>
  );
}

type Project = Awaited<ReturnType<typeof getGeoProject>>;

function Answer({ geoId, data, project, claims }: { geoId: string; data: GeoAnswer; project: Project | null; claims: GeoClaim[] }) {
  const navigate = useNavigate();
  const snapshot = data.snapshot;
  const question = data.question?.text || "回答";
  const date = monthDay(snapshot.askedAt);
  const pool = data.question?.pool && data.question.pool in GEO_POOL_KINDS ? GEO_POOL_KINDS[data.question.pool] : null;
  const errors = (Array.isArray(data.errors) ? data.errors : []).filter((error) => error && error.statement);
  const statements = (Array.isArray(data.facts?.statements) ? data.facts.statements : []).filter((statement) => statement && statement.verdict === "wrong" && statement.text);
  const wrongSentences = [...statements.map((statement) => statement.text), ...errors.map((error) => error.statement)];
  const history = dedupeHistory(data.history, snapshot.id, snapshot.askedAt);
  const product = project?.product;
  const ours = [
    ...(Array.isArray(data.facts?.brands) ? data.facts.brands.filter((brand) => brand?.ours).map((brand) => brand.name) : []),
    product?.brandName, product?.genericName, ...(Array.isArray(product?.aliases) ? product.aliases : []),
  ].filter((name): name is string => typeof name === "string" && !!name);
  const screenshot = snapshot.screenshot && snapshot.screenshotSha256 ? geoScreenshotUrl(geoId, snapshot.screenshotSha256) : null;
  const target = project ? { projectId: project.projectId, sessionId: project.sessionId } : null;

  const header = (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <BackLink to={tabPath(geoId, "diagnosis")} />
        <h1 className={cn(PAGE_TITLE_CLASS, "min-w-0")}>{question}</h1>
        {pool && <span className="shrink-0 text-caption text-text-3">{pool}</span>}
      </div>
      <div className="flex items-center gap-2">
        {history.length > 1 ? (
          <FilterSelect<string>
            label="测量日期"
            options={history.map((entry) => ({ value: entry.snapshotId, label: monthDay(entry.sampleDate) ?? entry.sampleDate }))}
            value={snapshot.id}
            onChange={(value) => { if (value && value !== snapshot.id) navigate(answerPath(geoId, value)); }}
          />
        ) : date && <span className="text-caption tabular-nums text-text-3">{date}</span>}
        {screenshot && (
          <a href={screenshot} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1 rounded px-2 text-ui text-text-2 hover:bg-surface-2 hover:text-text">
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
        <Engines geoId={geoId} data={data} errors={errors} statements={statements} />
        <article data-geo-answer={snapshot.id} className="min-w-0">
          <AnswerBody
            data={data}
            wrong={wrongSentences}
            ours={ours}
            errors={errors}
            statements={statements}
            claims={claims}
          />
          {target && (
            <div className="mt-4">
              <AskAi
                project={target}
                draft={wrongSentences.length
                  ? `${engineName(snapshot.engine)}回答「${question}」时说「${wrongSentences[0]}」${date ? `（${date}）` : ""}，和说明书不一致。它为什么这么说，怎么纠正？`
                  : `${engineName(snapshot.engine)}对「${question}」的回答${date ? `（${date}）` : ""}，对我们意味着什么，接下来该做什么？`}
              />
            </div>
          )}
          <Citations citations={snapshot.citations} />
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

/** What an engine's answer did for us, in a word: 「讲错 1 处」「提及 · 引用你」「未提及」「未测」. */
function engineWord(sibling: GeoAnswer["siblings"][number]): { text: string; wrong: boolean } {
  if (sibling.status === "absent" || !sibling.snapshotId) return { text: SNAPSHOT_STATUS_WORDS.absent, wrong: false };
  if (sibling.status !== "valid" && sibling.status !== "refusal") return { text: SNAPSHOT_STATUS_WORDS[sibling.status] ?? "—", wrong: false };
  if (typeof sibling.wrongOurs === "number" && sibling.wrongOurs > 0) return { text: `讲错 ${sibling.wrongOurs} 处`, wrong: true };
  if (sibling.status === "refusal") return { text: SNAPSHOT_STATUS_WORDS.refusal, wrong: false };
  if (sibling.mentionsOurs === true) return { text: sibling.citesOurs ? "提及 · 引用你" : "提及", wrong: false };
  if (sibling.mentionsOurs === false) return { text: "未提及", wrong: false };
  return { text: "", wrong: false };
}

function Engines({ geoId, data, errors, statements }: { geoId: string; data: GeoAnswer; errors: GeoErrorRow[]; statements: GeoStatementFact[] }) {
  const current = data.snapshot;
  const siblings = (Array.isArray(data.siblings) ? data.siblings : []).filter((sibling) => sibling && sibling.engine);
  if (!siblings.some((sibling) => sibling.engine === current.engine)) {
    siblings.unshift({ engine: current.engine, snapshotId: current.id, status: current.status });
  }
  // What this answer did is known from its own facts, whatever the sibling row says.
  const brands = Array.isArray(data.facts?.brands) ? data.facts.brands : [];
  const own = {
    wrongOurs: new Set([...errors.map((error) => error.statement.trim()), ...statements.map((statement) => statement.text.trim())]).size,
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
              <span className={cn("min-w-0 truncate", selected ? "font-medium text-text" : "text-text-2")}>{engineName(sibling.engine)}</span>
              {word.text && <span className={cn("shrink-0 text-caption", word.wrong ? "text-danger" : "text-text-3")}>{word.text}</span>}
            </>
          );
          const rowClass = cn("flex h-9 items-center justify-between gap-2 whitespace-nowrap rounded px-3 text-ui", selected ? "bg-surface-2" : "hover:bg-surface-1");
          return (
            <li key={sibling.engine} data-geo-sibling={sibling.engine}>
              {sibling.snapshotId && !selected ? (
                <Link to={answerPath(geoId, sibling.snapshotId)} className={rowClass}>{label}</Link>
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
  wrong,
  ours,
  errors,
  statements,
  claims,
}: {
  data: GeoAnswer;
  wrong: string[];
  ours: string[];
  errors: GeoErrorRow[];
  statements: GeoStatementFact[];
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
  const { paragraphs, unplaced } = markAnswer(snapshot.answerText, { wrong, ours });
  const citations = Array.isArray(snapshot.citations) ? snapshot.citations : [];
  const correction = (sentence: string, key: string) => (
    <Correction key={key} sentence={sentence} errors={errors} statements={statements} claims={claims} citations={citations} />
  );

  return (
    <div className="flex max-w-content flex-col gap-4 text-body text-text">
      {snapshot.status === "refusal" && <p><Tag>{SNAPSHOT_STATUS_WORDS.refusal}</Tag></p>}
      {paragraphs.map((paragraph, index) => (
        <Fragment key={index}>
          <Paragraph paragraph={paragraph} />
          {paragraph.wrong.map((sentence, wrongIndex) => correction(sentence, `${index}-${wrongIndex}`))}
        </Fragment>
      ))}
      {unplaced.length > 0 && unplaced.map((sentence, index) => (
        <div key={`unplaced-${index}`} className="flex flex-col gap-2">
          <p data-geo-wrong="" className="text-body text-text underline decoration-danger decoration-wavy underline-offset-4">{sentence}</p>
          {correction(sentence, `unplaced-${index}`)}
        </div>
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
  sentence,
  errors,
  statements,
  claims,
  citations,
}: {
  sentence: string;
  errors: GeoErrorRow[];
  statements: GeoStatementFact[];
  claims: GeoClaim[];
  citations: GeoAnswer["snapshot"]["citations"];
}) {
  const same = (text: string | null | undefined) => !!text && text.trim() === sentence.trim();
  const error = errors.find((row) => same(row.statement)) ?? null;
  const statement = statements.find((row) => same(row.text)) ?? null;
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

  return (
    <div data-geo-correction="" className="flex max-w-measure-body flex-col gap-1 border-l-2 border-danger pl-4 text-ui text-text-2">
      <p>
        <span className="text-danger">讲错我方</span>
        {right ? <>：对的是{right.endsWith("。") ? right : `${right}。`}</> : kind ? `：${GEO_ERROR_TYPE_WORDS[kind]}。` : null}
      </p>
      {claim?.sourceRef && <p>{`依据：${claim.sourceRef}`}</p>}
      {source && <p>{`出处：${source}`}</p>}
      {(action || status) && <p>{`处置：${[action, status].filter(Boolean).join(" · ")}`}</p>}
    </div>
  );
}

/** 「提到的药：司美格鲁肽（第 1 个，推荐）、玛仕度肽（第 2 个）」 */
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
          <span className={brand.ours ? "font-medium text-text-2" : undefined}>{brand.name}</span>
          {(brand.position || brand.inRecommendation) && `（${[brand.position ? `第 ${brand.position} 个` : null, brand.inRecommendation ? "推荐" : null].filter(Boolean).join("，")}）`}
        </Fragment>
      ))}
    </p>
  );
}

function Citations({ citations }: { citations: GeoAnswer["snapshot"]["citations"] | null | undefined }) {
  const list = (Array.isArray(citations) ? citations : []).filter((citation) => citation && citation.url);
  if (list.length === 0) return null;
  return (
    <section aria-label="引用的信源" className="mt-10">
      <h2 className="mb-3 text-ui font-medium text-text">引用的信源</h2>
      <ol className="flex flex-col divide-y divide-faint">
        {list.map((citation, index) => {
          const href = safeWebHref(citation.url);
          return (
            <li key={`${citation.url}-${index}`} className="flex items-center gap-3 py-2 text-ui">
              <span className="w-5 shrink-0 text-caption tabular-nums text-text-3">{index + 1}</span>
              <span className="w-24 shrink-0 truncate text-text-2 sm:w-32">{citation.domain || "—"}</span>
              <span className="min-w-0 flex-1 truncate text-text">{citation.title || citation.url}</span>
              {!citation.inBody && <span className="shrink-0 text-caption text-text-3">只列在参考资料</span>}
              {href && (
                <a href={href} target="_blank" rel="noreferrer" aria-label={`打开${citation.title || citation.domain || "信源"}`} className="inline-grid h-6 w-6 shrink-0 place-items-center rounded text-text-3 hover:bg-surface-2 hover:text-text">
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
