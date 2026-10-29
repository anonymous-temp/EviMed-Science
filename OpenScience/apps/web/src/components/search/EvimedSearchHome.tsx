import { useRef } from "react";
import { ArrowUpLeft, BookOpen, ClipboardList, FlaskConical, Pill } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SearchComposer } from "@/components/ui/SearchComposer";
import { EVIMED_SEARCH_CATEGORIES, type EvimedSearchCategory } from "@/lib/evimedSearchClient";

const SEARCH_PROMPTS: Record<EvimedSearchCategory, { placeholder: string; examples: { query: string; description: string }[] }> = {
  literature: { placeholder: "输入疾病、干预措施或研究主题", examples: [
    { query: "高血压", description: "血压管理与心血管风险" }, { query: "阿司匹林", description: "抗血小板治疗与用药证据" }, { query: "糖尿病", description: "血糖控制与并发症管理" },
  ] },
  guidelines: { placeholder: "输入疾病、专科或指南主题", examples: [
    { query: "高血压诊疗", description: "诊断标准与治疗推荐" }, { query: "糖尿病管理", description: "疾病管理与临床路径" }, { query: "心力衰竭", description: "指南共识与治疗策略" },
  ] },
  drugs: { placeholder: "输入药品通用名或商品名", examples: [
    { query: "阿司匹林", description: "适应证与用药注意事项" }, { query: "二甲双胍", description: "药品说明书与剂型信息" }, { query: "阿托伐他汀", description: "用法用量与药物相互作用" },
  ] },
  trials: { placeholder: "输入疾病、干预措施或试验名称", examples: [
    { query: "肺癌", description: "肿瘤治疗相关临床试验" }, { query: "糖尿病", description: "代谢疾病的干预研究" }, { query: "免疫治疗", description: "新治疗方案与试验进展" },
  ] },
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

/** The category selector scopes the next query; results and refinements appear only after submission. */
export function EvimedSearchHome({ category, draft, onDraftChange, onCategoryChange, onSubmit, onClear, onCompositionChange }: {
  category: EvimedSearchCategory;
  draft: string;
  onDraftChange(value: string): void;
  onCategoryChange(value: string): void;
  onSubmit(): void;
  onClear(): void;
  onCompositionChange(value: boolean): void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const prompt = SEARCH_PROMPTS[category];
  const TopicIcon = { literature: BookOpen, guidelines: ClipboardList, drugs: Pill, trials: FlaskConical }[category];
  return (
    <section aria-label="医学检索首页" className="w-full">
      <div className="relative isolate overflow-hidden rounded-panel bg-accent-soft px-5 py-8 md:px-10 md:py-10 xl:rounded-none xl:bg-transparent xl:px-0 xl:py-6">
        <EvidenceBackdrop />
        <div className="relative xl:mx-auto xl:max-w-read 2xl:max-w-none">
          <h2 className="max-w-measure text-title font-semibold text-text xl:mx-auto xl:text-center">从医学问题出发，<br className="xl:hidden" />找到有据可循的答案。</h2>
          <p className="mt-3 max-w-measure text-ui text-text-2 xl:mx-auto xl:text-center">检索文献、指南、药品与临床试验</p>
          <form role="search" aria-label="医学检索" className="mt-8 w-full" onSubmit={event => { event.preventDefault(); onSubmit(); }}>
            <SearchComposer ref={input} label="检索关键词" placeholder={prompt.placeholder} value={draft} maxLength={200}
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
        <h2 className="mb-3 text-ui font-semibold text-text">从一个主题开始</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {prompt.examples.map(example => <Button key={example.query} variant="secondary" aria-label={example.query}
            className="h-auto min-w-0 flex-col items-stretch gap-3 whitespace-normal rounded-card bg-surface p-4 text-left xl:gap-0 xl:bg-transparent xl:p-3"
            onClick={() => { onDraftChange(example.query); input.current?.focus(); }}>
            <span className="flex items-center justify-between xl:hidden"><TopicIcon size={20} className="text-accent" aria-hidden="true" /><ArrowUpLeft size={16} className="text-text-3" aria-hidden="true" /></span>
            <span className="block"><span className="block text-ui font-semibold">{example.query}</span><span className="mt-1 block text-ui text-text-2">{example.description}</span></span>
          </Button>)}
        </div>
      </div>
    </section>
  );
}
