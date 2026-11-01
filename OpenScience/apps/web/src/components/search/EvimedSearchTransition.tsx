import { useId } from "react";
import { ArrowLeft, BookOpen, ClipboardList, FlaskConical, Pill } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ProgressRail } from "@/components/ui/ProgressRail";
import type { EvimedSearchCategory } from "@/lib/evimedSearchClient";
import "./evimedSearchTransition.css";

const CONTENT_NAMES: Record<EvimedSearchCategory, string> = {
  literature: "文献", guidelines: "指南", drugs: "药品", trials: "临床试验",
};

/** An optical illustration of discovery; these pages and signals represent no retrieved records. */
function DiscoveryField({ category }: { category: EvimedSearchCategory }) {
  const id = useId();
  const TopicIcon = { literature: BookOpen, guidelines: ClipboardList, drugs: Pill, trials: FlaskConical }[category];
  const papers = [
    { x: 178, y: 98, angle: -14, path: "M258 190C310 148 330 152 398 176" },
    { x: 745, y: 88, angle: 13, path: "M744 184C682 140 652 148 608 178" },
  ];
  return <div className="discovery-field" aria-hidden="true">
    <svg viewBox="0 0 1000 400" fill="none" focusable="false">
      <defs>
        <radialGradient id={`${id}-atmosphere`}>
          <stop stopColor="var(--info-soft)" />
          <stop offset="1" stopColor="var(--info-soft)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}-ground`}>
          <stop stopColor="var(--info)" stopOpacity="0.1" />
          <stop offset="1" stopColor="var(--info)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-paper`} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="var(--surface)" />
          <stop offset="1" stopColor="var(--surface-1)" />
        </linearGradient>
        <linearGradient id={`${id}-glass`} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="var(--surface)" />
          <stop offset="0.48" stopColor="var(--info-soft)" />
          <stop offset="1" stopColor="var(--surface)" />
        </linearGradient>
        <linearGradient id={`${id}-rim`} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="var(--surface)" />
          <stop offset="0.35" stopColor="var(--info)" stopOpacity="0.45" />
          <stop offset="0.7" stopColor="var(--surface)" />
          <stop offset="1" stopColor="var(--info)" stopOpacity="0.6" />
        </linearGradient>
        <pattern id={`${id}-dots`} width="24" height="24" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" fill="var(--info)" fillOpacity="0.12" />
        </pattern>
        <radialGradient id={`${id}-fade`}>
          <stop offset="0.25" stopColor="white" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <mask id={`${id}-mask`}><rect width="1000" height="400" fill={`url(#${id}-fade)`} /></mask>
        <clipPath id={`${id}-lens`}><circle cx="594" cy="224" r="77" /></clipPath>
      </defs>
      <ellipse cx="500" cy="204" rx="420" ry="184" fill={`url(#${id}-atmosphere)`} />
      <rect width="1000" height="400" fill={`url(#${id}-dots)`} mask={`url(#${id}-mask)`} />
      <path d="M80 260C220 354 766 366 930 238M126 130C300 24 720 42 884 146" stroke="var(--info)" strokeOpacity="0.08" />
      <ellipse cx="518" cy="344" rx="252" ry="28" fill={`url(#${id}-ground)`} />
      {papers.map((paper, index) => <g key={paper.path}>
        <path d={paper.path} stroke="var(--info)" strokeOpacity="0.15" strokeDasharray="3 8" />
        <path d={paper.path} pathLength="100" stroke="var(--info)" strokeOpacity="0.5" strokeWidth="2" strokeDasharray="8 92"
          className={`discovery-signal discovery-signal-${index}`} />
        <g transform={`translate(${paper.x} ${paper.y}) rotate(${paper.angle} 56 78)`}>
          <g className={`discovery-paper discovery-paper-${index}`}>
            <rect width="112" height="156" rx="12" fill={`url(#${id}-paper)`} stroke="var(--border)" />
            <path d="M21 27H65M21 49H91M21 62H84M21 75H91M21 108H61M21 121H78M21 134H55" stroke="var(--text-3)" strokeOpacity="0.55" strokeWidth="2" strokeLinecap="round" />
            <path d="M21 92H91" stroke="var(--info)" strokeOpacity="0.35" strokeWidth="3" strokeLinecap="round" />
          </g>
        </g>
      </g>)}
      <g transform="rotate(6 500 185)">
        <rect x="336" y="66" width="344" height="226" rx="16" fill="var(--surface-1)" stroke="var(--border)" />
      </g>
      <g className="discovery-document">
        <rect x="314" y="72" width="352" height="232" rx="16" fill={`url(#${id}-paper)`} stroke="var(--border-control)" strokeOpacity="0.6" />
        <path d="M314 132H666" stroke="var(--border)" />
        <TopicIcon x="342" y="96" size={20} className="text-info" />
        <path d="M378 105H488M342 158H463M342 176H544M342 194H512M342 212H534M342 230H444M342 272H407" stroke="var(--text-3)" strokeOpacity="0.55" strokeWidth="3" strokeLinecap="round" />
        <path d="M515 103H638M342 251H462" stroke="var(--info)" strokeOpacity="0.16" strokeWidth="3" strokeLinecap="round" />
        <rect x="583" y="97" width="55" height="14" rx="6" fill="var(--info-soft)" />
      </g>
      <g className="discovery-lens">
        <path d="M652 283L706 337" stroke="var(--border-control)" strokeWidth="22" strokeLinecap="round" />
        <path d="M652 283L706 337" stroke={`url(#${id}-rim)`} strokeWidth="18" strokeLinecap="round" />
        <circle cx="594" cy="224" r="89" fill={`url(#${id}-glass)`} stroke={`url(#${id}-rim)`} strokeWidth="12" />
        <circle cx="594" cy="224" r="77" stroke="var(--info)" strokeOpacity="0.2" />
        <g clipPath={`url(#${id}-lens)`}>
          <path d="M535 182H620M535 205H656M535 228H642M535 251H657M535 274H606" stroke="var(--info)" strokeOpacity="0.32" strokeWidth="4" strokeLinecap="round" />
          <rect x="528" y="216" width="130" height="24" rx="6" fill="var(--info)" fillOpacity="0.08" />
          <path d="M538 170C557 153 582 147 605 153" stroke="var(--surface)" strokeWidth="4" strokeLinecap="round" />
        </g>
        <circle cx="594" cy="224" r="103" stroke="var(--info)" strokeOpacity="0.1" />
        <circle cx="594" cy="224" r="103" stroke="var(--info)" strokeOpacity="0.65" strokeWidth="2" strokeDasharray="46 601" strokeLinecap="round" className="discovery-orbit" />
      </g>
    </svg>
  </div>;
}

/** Only the actual request controls completion; the illustration is an indeterminate waiting state. */
export function EvimedSearchTransition({ category, query, onEdit }: {
  category: EvimedSearchCategory;
  query: string;
  onEdit(): void;
}) {
  const heading = useId();
  return <section aria-labelledby={heading} aria-busy="true" className="discovery-transition fade-in">
    <div role="status" className="relative w-full text-center">
      <h2 id={heading} className="text-title font-semibold text-text">正在检索{CONTENT_NAMES[category]}</h2>
      <p className="mx-auto mt-3 line-clamp-3 max-w-measure break-words text-body text-text-2">“{query}”</p>
    </div>
    <DiscoveryField category={category} />
    <div className="w-full max-w-read px-2 md:px-8">
      <ProgressRail label="查找流程" className="grid-cols-3 gap-x-3 rounded-none border-0 bg-transparent p-0 sm:grid-cols-3 lg:grid-cols-3 lg:gap-x-3" steps={[
        { key: "query", name: "确认关键词", state: "done", note: "已确认" },
        { key: "search", name: "执行检索", state: "active", note: "正在查找" },
        { key: "results", name: "展示结果", state: "todo", note: "等待返回" },
      ]} />
    </div>
    <div className="mt-6 flex flex-col items-center gap-3 sm:flex-row sm:gap-5">
      <span className="flex items-center gap-2 text-caption text-text-3"><span className="discovery-running h-1.5 w-1.5 rounded-full bg-info" aria-hidden="true" />结果返回后自动展示</span>
      <Button variant="text" onClick={onEdit}><ArrowLeft size={16} aria-hidden="true" />返回修改</Button>
    </div>
  </section>;
}
