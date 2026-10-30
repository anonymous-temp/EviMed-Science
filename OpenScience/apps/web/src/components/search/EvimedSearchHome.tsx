import { useEffect, useRef, useState } from "react";
import { ArrowUpLeft, BookOpen, ClipboardList, FlaskConical, Pill } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { EmptyState } from "@/components/cards/EmptyState";
import { List, ListRow } from "@/components/ui/ListRow";
import { Note } from "@/components/ui/Note";
import { PendingFeedback } from "@/components/ui/PendingFeedback";
import { SearchComposer } from "@/components/ui/SearchComposer";
import { Tag } from "@/components/ui/Tag";
import { EVIMED_SEARCH_CATEGORIES, type EvimedSearchCategory } from "@/lib/evimedSearchClient";
import { formatClock, formatDate, formatNumber } from "@/lib/format";
import { useProjectStore } from "@/lib/projects";
import { useEvimedSearchTopics } from "@/lib/useEvimedSearchTopics";

const SEARCH_PROMPTS: Record<EvimedSearchCategory, string> = {
  literature: "输入疾病、干预措施或研究主题",
  guidelines: "输入疾病、专科或指南主题",
  drugs: "输入药品通用名或商品名",
  trials: "输入疾病、干预措施或试验名称",
};

function EvidenceBackdrop() {
  return <svg aria-hidden="true" viewBox="0 0 1000 420" preserveAspectRatio="xMaxYMin slice"
    className="pointer-events-none absolute inset-0 h-full w-full text-accent opacity-20 xl:opacity-10" fill="none" stroke="currentColor" strokeWidth="1">
    <path d="M640 420C640 290 880 330 880 200S960 90 1040 30M665 430C665 300 905 340 905 210S985 100 1065 40M690 440C690 310 930 350 930 220S1010 110 1090 50M715 450C715 320 955 360 955 230S1035 120 1115 60" />
    <g strokeWidth="1.5">
      <rect x="785" y="38" width="116" height="76" rx="8" fill="var(--surface)" />
      <path d="M803 58h46m-46 12h76m-76 12h62m-62 12h34M740 78h45m58 36v27h66" strokeDasharray="3 5" />
      <circle cx="733" cy="78" r="6" fill="var(--surface)" />
      <circle cx="916" cy="141" r="6" fill="var(--surface)" />
      <path d="M938 36v30m-15-15h30" />
    </g>
  </svg>;
}

/**
 * Component: EvimedSearchHome; owner: H; rules: DS21, DS22.
 * Anatomy: Category search composer followed by project-scoped topic choices and dated source previews.
 * Variants: Literature, guidelines, drugs and trials scope the next query.
 * States: Manual search remains available during topic loading, empty and retryable failure; refresh failures preserve topics; stale and example feeds are labelled.
 * Hit area: SearchComposer and full Button cards own their targets; source buttons are siblings, never nested controls.
 * Keyboard: Topic activation fills and focuses the textarea; Enter submits, Shift+Enter inserts a line, IME is preserved; source Drawer traps focus and Escape returns it.
 * Long content: Queries and descriptions wrap; at most three topics are requested.
 * Theme: Semantic paper/accent/text roles; placeholders use reduced-motion-safe pulse.
 * Responsive: Topic choices stack on narrow screens and use three columns from sm.
 * Verification: EvimedSearchHome.test.tsx and EvimedSearchPage.test.tsx cover reads, races, recovery and fill-only activation; browser/AT checks remain separate.
 */
export function EvimedSearchHome({ category, draft, onDraftChange, onCategoryChange, onSubmit, onClear, onCompositionChange, focusQuery = false }: {
  category: EvimedSearchCategory;
  draft: string;
  onDraftChange(value: string): void;
  onCategoryChange(value: string): void;
  onSubmit(): void;
  onClear(): void;
  onCompositionChange(value: boolean): void;
  focusQuery?: boolean;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const projectId = useProjectStore(state => state.currentId);
  const { state: topics, retry, requestKey } = useEvimedSearchTopics(projectId || null, category);
  const [sourceSelection, setSourceSelection] = useState<{ key: string; id: string } | null>(null);
  useEffect(() => { if (focusQuery) input.current?.focus(); }, [focusQuery]);
  const prompt = SEARCH_PROMPTS[category];
  const TopicIcon = { literature: BookOpen, guidelines: ClipboardList, drugs: Pill, trials: FlaskConical }[category];
  const data = topics.status === "success" ? topics.data : null;
  const recommendation = data?.recommendation;
  const categoryDataThrough = data?.topics.reduce<string | null>((latest, topic) => {
    const value = topic.basis?.latestAt;
    return value && (!latest || Date.parse(value) > Date.parse(latest)) ? value : latest;
  }, null) ?? null;
  const selectedTopic = sourceSelection?.key === requestKey ? data?.topics.find(topic => topic.id === sourceSelection.id && topic.basis) : null;
  const refreshFailed = topics.status === "success" && !!topics.refreshError;
  const refreshing = topics.status === "success" && topics.refreshing;
  return (
    <section aria-label="医学检索首页" className="w-full">
      <div className="relative isolate overflow-hidden rounded-panel bg-accent-soft px-5 py-8 md:px-10 md:py-10 xl:rounded-none xl:bg-transparent xl:px-0 xl:py-6">
        <EvidenceBackdrop />
        <div className="relative xl:mx-auto xl:max-w-read 2xl:max-w-none">
          <h2 className="max-w-measure text-title font-semibold text-text xl:mx-auto xl:text-center">从医学问题出发，<br className="xl:hidden" />找到有据可循的答案。</h2>
          <p className="mt-3 max-w-measure text-ui text-text-2 xl:mx-auto xl:text-center">检索文献、指南、药品与临床试验</p>
          <form role="search" aria-label="医学检索" className="mt-8 w-full" onSubmit={event => { event.preventDefault(); onSubmit(); }}>
            <SearchComposer ref={input} label="检索关键词" placeholder={prompt} value={draft} maxLength={200}
              onChange={event => onDraftChange(event.target.value)} onClear={onClear} onSubmit={onSubmit}
              categories={{ label: "检索类别", items: EVIMED_SEARCH_CATEGORIES, value: category, onChange: onCategoryChange }}
              onCompositionStart={() => onCompositionChange(true)} onCompositionEnd={() => onCompositionChange(false)}
              onKeyDown={event => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) { event.preventDefault(); onSubmit(); }
              }} />
            <p className="mt-3 text-ui text-text-2 xl:sr-only">输入关键词，开始检索。</p>
          </form>
        </div>
      </div>
      <div className="mt-6 xl:mx-auto xl:mt-3 xl:max-w-read 2xl:max-w-none">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-ui font-semibold text-text">{recommendation ? "近期医学主题" : "从一个主题开始"}</h2>
          {projectId && topics.status === "success" && topics.data.source.isExample && <Tag>示例主题</Tag>}
        </div>
        {data && (recommendation || refreshFailed) && <div role="status" className="mb-3">
          <Note tone={recommendation?.stale || refreshFailed ? "warn" : "default"} action={<Button variant="text" size="sm" loading={refreshing} onClick={retry}>
            {refreshFailed || recommendation?.stale ? "重试更新主题" : "刷新主题"}
          </Button>}>
            {category === "trials" ? "近 30 天已采集的试验更新（非注册库总量）" : "近 30 天的医学进展"}
            {refreshFailed ? " · 更新暂时失败，保留上次主题。" : recommendation?.stale ? " · 暂未获取更新，显示上次主题。" : ""}
            {categoryDataThrough && <> · 进展截至 <time dateTime={categoryDataThrough}>{formatDate(categoryDataThrough)}{category !== "trials" && <> {formatClock(categoryDataThrough)}</>}</time></>}
          </Note>
        </div>}
        {!projectId ? <EmptyState icon={TopicIcon} title="选择项目后查看主题" reason="也可以直接输入关键词，开始检索。" className="py-4" />
          : topics.status === "loading" ? <div aria-busy="true" aria-label="正在读取检索主题">
            <PendingFeedback key={requestKey} stage="正在读取检索主题"><div className="grid gap-3 motion-safe:animate-pulse sm:grid-cols-3" aria-hidden="true">
              {[0, 1, 2].map(index => <div key={index} className="space-y-3 rounded-card p-4 xl:p-3">
                <div className="h-5 w-1/3 rounded bg-surface-2" /><div className="h-4 w-3/4 rounded bg-surface-2" />
              </div>)}
            </div></PendingFeedback>
          </div>
          : topics.status === "error" ? <EmptyState icon={TopicIcon} title="暂时无法读取主题" description={topics.message}
            action={<Button variant="secondary" size="sm" onClick={retry}>重试读取主题</Button>} className="py-4" />
          : topics.data.topics.length === 0 ? <EmptyState icon={TopicIcon} title="暂无可选主题" reason="直接输入关键词，即可开始检索。" className="py-4" />
          : <div className="grid gap-3 sm:grid-cols-3">
          {topics.data.topics.map(topic => <div key={topic.id} className="min-w-0">
          <Button variant="secondary" aria-label={topic.query}
            className="h-auto w-full min-w-0 flex-col items-stretch gap-3 whitespace-normal rounded-card bg-surface p-4 text-left xl:gap-0 xl:bg-transparent xl:p-3"
            onClick={() => { onDraftChange(topic.query); input.current?.focus(); }}>
            <span className="flex items-center justify-between xl:hidden"><TopicIcon size={20} className="text-accent" aria-hidden="true" /><ArrowUpLeft size={16} className="text-text-3" aria-hidden="true" /></span>
            <span className="block"><span className="block text-ui font-semibold">{topic.query}</span><span className="mt-1 block text-ui text-text-2">{topic.description}</span></span>
          </Button>
          {recommendation && topic.basis && <Button variant="text" size="sm" className="mx-1 mt-1 h-auto max-w-full whitespace-normal px-3 py-1 text-left"
            aria-label={`${topic.query}，查看近期进展来源`} onClick={() => setSourceSelection({ key: requestKey, id: topic.id })}>
            查看 {formatNumber(topic.basis.sources.length)} 条原文
          </Button>}
          </div>)}
        </div>}
      </div>
      {selectedTopic?.basis && <Drawer title={`${selectedTopic.query}的近期进展`} onClose={() => setSourceSelection(null)}>
        <p className="max-w-measure text-ui text-text">近 30 天采集到 {formatNumber(selectedTopic.basis.eventCount)} 条相关进展，来自 {formatNumber(selectedTopic.basis.sourceCount)} 个来源。以下展示其中 {formatNumber(selectedTopic.basis.sources.length)} 条原文。</p>
        <List label={`${selectedTopic.query}的进展来源`} divided className="mt-4">
          {selectedTopic.basis.sources.map(source => <ListRow key={source.id} title={source.title} href={source.url}
            meta={<span className="text-ui">{source.source} · {{ published: "发表于 ", observed: "收录于 ", updated: "更新于 " }[source.dateBasis]}<time dateTime={source.dateBasis === "published" ? source.publishedAt ?? source.timelineAt : source.timelineAt}>{formatDate(source.dateBasis === "published" ? source.publishedAt ?? source.timelineAt : source.timelineAt)}</time></span>} />)}
        </List>
      </Drawer>}
    </section>
  );
}
