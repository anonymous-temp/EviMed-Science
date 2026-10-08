import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, X } from "lucide-react";
import { getGeoSource, type GeoProject, type GeoSourceAnswer, type GeoSourceDetail, type GeoSourcePage, type GeoSourceRow } from "@/lib/geoClient";
import { safeWebHref } from "@/lib/readPages";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { List, ListHeader, ListRow } from "@/components/ui/ListRow";
import { ScrollRegion } from "@/components/ui/ScrollRegion";
import { Tag } from "@/components/ui/Tag";
import { engineName, GEO_SOURCE_LAYER_WORDS, monthDay } from "../geoText";
import { useOpenGeoConversation } from "../useOpenGeoConversation";
import { answerPath, sourceDraft, sourceKindWord, yuan } from "./geoTabText";
import { TabError, useGeoLoad } from "./geoTabKit";
import { ShowMore, useShowMore } from "./showMore";
import { sourceHistoryModel } from "./sourceHistory";

/** Answers listed before 「显示更多」 in each of the drawer's two lists, and how many each press adds. */
const ANSWERS_SHOWN = 10;
const ANSWERS_STEP = 20;
/** Pages of the site listed before 「显示全部」. */
const PAGES_SHOWN = 8;

const CONDITION_WORDS: Array<{ key: keyof GeoSourceRow["conditions"]; label: string }> = [
  { key: "icp", label: "备案" },
  { key: "newsIndexed", label: "新闻源" },
  { key: "medical", label: "医疗" },
];

export function unverifiedConditions(conditions: GeoSourceRow["conditions"] | null | undefined): string[] {
  return CONDITION_WORDS.filter(({ key }) => conditions?.[key] == null).map(({ label }) => label);
}

/**
 * What a 信源 row stands for (plan R13 E-15, design reference §15.3): the answers of the latest round that cite the site — the
 * answers the row's three numbers count. The ones that misstate us come first, each as 「引擎 · 问题 · 日期」 with the wrong
 * sentence drawn the way the answer page draws it, and 「出自这个站」 on the sentence the engine's own marker puts on this site;
 * then the rest, the ones that name us marked. Every answer is the way into its page. A site nothing misstated still lists the
 * answers that cite it. After the answers: the specific pages of the site those answers cited (R14 N-11, outside links, the most cited
 * eight and then all of them), and the site's counts across the last few rounds — compared only where the rounds were measured over
 * the same thing, a rule drawn where the coverage changed (N-4). The last lines are the three conditions and the price of an article
 * there, and the one button hands a draft to the project's conversation — never sent.
 *
 * It is a record, so it is a drawer: the list stays where it was (page-structure rule 2).
 */
export function GeoSourceDrawer({
  geoId,
  project,
  source,
  engine,
  focus,
  onClose,
}: {
  geoId: string;
  project: GeoProject;
  source: GeoSourceRow;
  /** The engine the list was narrowed to, or `all`: the drawer lists the same answers the row counted. */
  engine: string;
  /** Opened from the red count: the drawer rests on the answers that misstated us. */
  focus: "wrong" | null;
  onClose: () => void;
}) {
  const narrowed = engine === "all" ? null : engine;
  const { state, reload } = useGeoLoad(`source:${geoId}:${source.id}:${engine}`, () => getGeoSource(geoId, source.id, narrowed));
  const kind = sourceKindWord(source.kind);
  return (
    <Drawer
      title={source.name || source.domain}
      description={(
        <>
          <a href={`https://${source.domain}`} target="_blank" rel="noopener noreferrer" data-geo-source-link="" className="text-accent hover:underline">
            {source.domain}
            <ArrowUpRight size={16} aria-hidden="true" className="inline align-text-bottom" />
            <span className="sr-only">（在新标签页打开）</span>
          </a>
          {kind && ` · ${kind}`}
          {narrowed && ` · 只看${engineName(narrowed)}`}
        </>
      )}
      onClose={onClose}
    >
      <div data-geo-source-drawer={source.domain} className="flex min-h-full flex-col">
        <div className="flex flex-1 flex-col gap-6">
          {state.kind === "loading" && <p role="status" className="text-ui text-text-3">正在读取引用它的回答</p>}
          {state.kind === "error" && <TabError message={state.message} onRetry={reload} />}
          {state.kind === "ready" && <Answers geoId={geoId} project={project} detail={state.data} focus={focus} />}
          {state.kind === "ready" && <Pages detail={state.data} />}
          {state.kind === "ready" && <History detail={state.data} />}
          <Conditions source={state.kind === "ready" ? state.data.source : source} />
        </div>
        <Footer project={project} source={source} detail={state.kind === "ready" ? state.data : null} />
      </div>
    </Drawer>
  );
}

function Answers({ geoId, project, detail, focus }: { geoId: string; project: GeoProject; detail: GeoSourceDetail; focus: "wrong" | null }) {
  const answers = Array.isArray(detail.answers) ? detail.answers : [];
  const misstated = answers.filter((answer) => answer.misstated);
  const others = answers.filter((answer) => !answer.misstated);
  const product = project.product?.brandName || project.product?.genericName || project.name;
  const when = monthDay(detail.round?.sampleDate);
  // After the misstating answers the rest are 「其他」; a site nothing misstated has only the answers that cite it.
  const othersName = misstated.length > 0 ? "其他回答" : "引用它的回答";
  const shownWrong = useShowMore(misstated, { first: ANSWERS_SHOWN, step: ANSWERS_STEP, resetKey: detail.source.id });
  const shownOthers = useShowMore(others, { first: ANSWERS_SHOWN, step: ANSWERS_STEP, resetKey: detail.source.id });
  const wrongSection = useRef<HTMLElement>(null);
  // Pressed from the red count: the drawer rests on what that count counted.
  useEffect(() => {
    const node = wrongSection.current;
    if (focus === "wrong" && node && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "start" });
  }, [focus, detail.source.id]);

  if (!detail.round) return <p data-geo-source-none="" className="text-ui text-text-2">还没有完成的测量，这个站被引用的情况要等第一轮测量做完才有。</p>;
  if (answers.length === 0) {
    return <p data-geo-source-none="" className="text-ui text-text-2">{`最近一轮测量${when ? `（${when}）` : ""}里，没有回答引用这个站。`}</p>;
  }
  return (
    <>
      <p data-geo-source-counts="" className="text-caption text-text-3">
        {`最近一轮测量${when ? `（${when}）` : ""}：${detail.counts.cited.toLocaleString("zh-CN")} 个回答引用了这个站，其中 ${detail.counts.wrongOurs.toLocaleString("zh-CN")} 个讲错了${product}，${detail.counts.mentionsOurs.toLocaleString("zh-CN")} 个提到了${product}。`}
      </p>
      {misstated.length > 0 && (
        <section ref={wrongSection} aria-label="讲错的回答" data-geo-source-section="wrong">
          <h3 className="text-ui font-semibold text-text">
            讲错的回答<span data-geo-source-count="wrong" className="ml-1.5 font-normal tabular-nums text-text-3">{misstated.length.toLocaleString("zh-CN")}</span>
          </h3>
          <p className="mt-0.5 text-caption text-text-3">这些回答引用了这个站，并且讲错了{product}；讲错的那句话不一定出自这个站。</p>
          <List divided label="讲错的回答" className="mt-2">
            {shownWrong.visible.map((answer) => <AnswerRow key={answer.snapshotId} geoId={geoId} answer={answer} />)}
          </List>
          <ShowMore remaining={shownWrong.remaining} unit="个" onMore={shownWrong.more} />
        </section>
      )}
      {others.length > 0 && (
        <section aria-label={othersName} data-geo-source-section="others">
          <h3 className="text-ui font-semibold text-text">
            {othersName}
            <span data-geo-source-count="others" className="ml-1.5 font-normal tabular-nums text-text-3">{others.length.toLocaleString("zh-CN")}</span>
          </h3>
          <List divided label={othersName} className="mt-2">
            {shownOthers.visible.map((answer) => <AnswerRow key={answer.snapshotId} geoId={geoId} answer={answer} />)}
          </List>
          <ShowMore remaining={shownOthers.remaining} unit="个" onMore={shownOthers.more} />
        </section>
      )}
    </>
  );
}

/** The address as a reader wants it: no scheme, no leading www. */
function displayUrl(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "").replace(/^www\./u, "").replace(/\/$/u, "");
}

/**
 * 被引用的页面 (R14 N-11): the specific pages of this site that the latest round's answers cited — the page's title, its address
 * as an outside link, how many answers cited it and how many of those misstated us. The most cited eight, then all of them.
 */
function Pages({ detail }: { detail: GeoSourceDetail }) {
  const pages = Array.isArray(detail.pages) ? detail.pages : [];
  const [all, setAll] = useState(false);
  if (pages.length === 0) return null;
  const total = typeof detail.pagesTotal === "number" ? detail.pagesTotal : pages.length;
  const shown = all ? pages : pages.slice(0, PAGES_SHOWN);
  return (
    <section aria-label="被引用的页面" data-geo-source-section="pages">
      <h3 className="text-ui font-semibold text-text">
        被引用的页面<span data-geo-source-count="pages" className="ml-1.5 font-normal tabular-nums text-text-3">{total.toLocaleString("zh-CN")}</span>
      </h3>
      <ListHeader label="页面的数字" columns={[{ key: "cited", label: "被引用" }, { key: "wrong", label: "讲错的回答" }]} className="mt-2 max-sm:hidden" />
      <List divided label="被引用的页面">
        {shown.map((page) => <PageRow key={page.url} page={page} />)}
      </List>
      {pages.length > PAGES_SHOWN && (
        <div className="mt-2 flex justify-center">
          <Button variant="text" size="sm" aria-expanded={all} onClick={() => setAll((value) => !value)}>
            {all ? "收起" : `显示全部 ${pages.length.toLocaleString("zh-CN")} 个`}
          </Button>
        </div>
      )}
      {total > pages.length && <p className="mt-2 text-caption text-text-3">{`只列出被引用最多的 ${pages.length.toLocaleString("zh-CN")} 个，共 ${total.toLocaleString("zh-CN")} 个页面。`}</p>}
    </section>
  );
}

function PageRow({ page }: { page: GeoSourcePage }) {
  const href = safeWebHref(page.url);
  const address = displayUrl(page.url);
  return (
    <ListRow
      title={<span className="line-clamp-2 break-words">{page.title ?? address}{href && <span className="sr-only">（在新标签页打开）</span>}</span>}
      titleProps={{ "data-geo-source-page": page.url }}
      href={href ?? undefined}
      meta={page.title ? <span className="block truncate">{address}</span> : undefined}
      columns={[
        { key: "cited", label: "被引用", value: page.cited.toLocaleString("zh-CN") },
        { key: "wrong", label: "讲错的回答", value: page.wrongOurs.toLocaleString("zh-CN"), ...(page.wrongOurs > 0 ? { tone: "danger" as const } : {}) },
      ]}
    />
  );
}

/**
 * The site's counts for the last few rounds (R14 N-11), one column per round, oldest first. A rule is drawn before a round that was
 * measured over something else than the one before it — other engines answered, other questions, another surface — and nothing is
 * compared across it: the sentence under the table compares the latest round with the previous one only where they share a
 * coverage, and otherwise says they are not compared (N-4). A site no round cited, or one round alone, draws no trend.
 */
function History({ detail }: { detail: GeoSourceDetail }) {
  const model = sourceHistoryModel(detail.history);
  if (!model) return null;
  const cell = (broken: boolean) => cn("px-3 py-1 text-right", broken && "border-l border-border-control");
  return (
    <section aria-label="近几轮" data-geo-source-section="history">
      <h3 className="text-ui font-semibold text-text">近几轮</h3>
      <ScrollRegion label="近几轮的被引用和讲错的回答" className="mt-2">
        <table data-geo-source-history="" className="w-full min-w-max text-ui tabular-nums">
          <caption className="sr-only">这个站在最近几轮里被引用的回答数，和其中讲错的回答数</caption>
          <thead>
            <tr>
              <td />
              {model.columns.map((column) => (
                <th key={column.roundId} scope="col" data-geo-history-round={column.roundId} className={cn(cell(column.breakBefore), "pb-1 text-caption font-normal text-text-3")}>
                  {column.label}
                  {column.breakBefore && <span className="sr-only">（测量范围有变化，不与前一轮比较）</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" className="py-1 pr-3 text-left font-normal text-text-2">被引用</th>
              {model.columns.map((column) => <td key={column.roundId} data-geo-history="cited" className={cn(cell(column.breakBefore), "text-text")}>{column.cited.toLocaleString("zh-CN")}</td>)}
            </tr>
            <tr>
              <th scope="row" className="py-1 pr-3 text-left font-normal text-text-2">讲错的回答</th>
              {model.columns.map((column) => (
                <td key={column.roundId} data-geo-history="wrong" className={cn(cell(column.breakBefore), column.wrongOurs > 0 ? "text-danger" : "text-text")}>{column.wrongOurs.toLocaleString("zh-CN")}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </ScrollRegion>
      {model.sentence && <p data-geo-history-note="" className="mt-2 text-caption text-text-3">{model.sentence}</p>}
      {model.broken && <p data-geo-history-break="" className="mt-1 text-caption text-text-3">竖线两侧的轮次测量范围不同，不互相比较。</p>}
    </section>
  );
}

/** 「引擎 · 问题 · 日期」, the wrong sentences under it as the answer page draws them; the row opens the answer. */
function AnswerRow({ geoId, answer }: { geoId: string; answer: GeoSourceAnswer }) {
  const line = [engineName(answer.engine), answer.question, monthDay(answer.askedAt)].filter(Boolean).join(" · ");
  const wrong = Array.isArray(answer.wrong) ? answer.wrong : [];
  return (
    <ListRow
      title={<span className="line-clamp-2">{line}</span>}
      titleProps={{ "data-geo-source-answer": answer.snapshotId }}
      to={answerPath(geoId, answer.snapshotId)}
      meta={wrong.length > 0 ? (
        <span className="mt-1 flex flex-col gap-1.5">
          {wrong.map((sentence) => (
            <span key={sentence.text} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-ui text-text">
              <span data-geo-source-wrong="" className="min-w-0 underline decoration-danger decoration-wavy underline-offset-4">{sentence.text}</span>
              {sentence.fromThisSite && <Tag>出自这个站</Tag>}
            </span>
          ))}
        </span>
      ) : undefined}
      trailing={answer.mentionsOurs ? <Tag>提到你</Tag> : undefined}
    />
  );
}

/** The three conditions, said as words, and what an article there costs: the last thing the drawer says about the site. */
function Conditions({ source }: { source: Pick<GeoSourceRow, "conditions" | "layer" | "market"> }) {
  const missing = unverifiedConditions(source.conditions);
  const known = CONDITION_WORDS.filter(({ key }) => source.conditions?.[key] != null);
  const price = source.market && typeof source.market.price === "number" ? yuan(source.market.price) : null;
  const layer = source.layer ? GEO_SOURCE_LAYER_WORDS[source.layer] ?? null : null;
  return (
    <section aria-label="投放条件" data-geo-source-detail="" className="text-ui text-text-2">
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {layer && <span data-geo-source-tier="">{`层级 ${layer}`}</span>}
        {known.map(({ key, label }) => {
          const yes = source.conditions[key] === true;
          const Icon = yes ? Check : X;
          return (
            <span key={key} data-geo-condition={`${key}:${yes ? "yes" : "no"}`} className="inline-flex items-center gap-1">
              {label}
              <Icon size={16} aria-hidden="true" className={yes ? "text-accent" : "text-text-3"} />
              <span className="sr-only">{yes ? "满足" : "不满足"}</span>
            </span>
          );
        })}
        {missing.length > 0 && (
          <span data-geo-condition-unverified={missing.length === CONDITION_WORDS.length ? "all" : "some"}>
            {missing.length === CONDITION_WORDS.length ? "三项都未核实" : `${missing.join("、")}未核实`}
          </span>
        )}
        {price && <span>{`单篇价格 ${price}`}</span>}
      </p>
      {missing.length > 0 && <p className="mt-1 text-caption text-text-3">“未核实”是平台还没核对这一项，不等于不满足。</p>}
    </section>
  );
}

/** One primary button, pinned under the content: the draft goes to the project's conversation and waits there to be sent. */
function Footer({ project, source, detail }: { project: GeoProject; source: GeoSourceRow; detail: GeoSourceDetail | null }) {
  const open = useOpenGeoConversation();
  const [busy, setBusy] = useState(false);
  const product = project.product?.brandName || project.product?.genericName || project.name;
  const handoff = () => {
    const wrong = (detail?.answers ?? []).filter((answer) => answer.misstated);
    const draft = sourceDraft({
      product,
      name: source.name,
      domain: source.domain,
      cited: detail?.counts.cited ?? 0,
      wrong: detail?.counts.wrongOurs ?? 0,
      mentions: detail?.counts.mentionsOurs ?? 0,
      sentences: wrong.flatMap((answer) => answer.wrong ?? []),
    });
    setBusy(true);
    void open({ projectId: project.projectId, sessionId: project.sessionId }, draft).catch(() => undefined).finally(() => setBusy(false));
  };
  return (
    <footer className="sticky -bottom-6 z-sticky -mx-6 -mb-6 mt-6 border-t border-border bg-surface px-6 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <Button data-geo-source-handoff="" loading={busy} onClick={handoff}>在对话中处理</Button>
    </footer>
  );
}
