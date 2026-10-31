import { useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, ArrowUpRight, BookOpen, FileText, Pill, Search } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Button, buttonClasses } from "@/components/ui/Button";
import { FactList } from "@/components/ui/FactList";
import { Outline, useOutline } from "@/components/ui/Outline";
import { Section } from "@/components/ui/Section";
import { StateScreen } from "@/components/ui/StateScreen";
import { useWide } from "@/lib/useMediaQuery";
import { evimedSourceUrl, type EvimedSearchCategory, type EvimedSearchDetail } from "@/lib/evimedSearchClient";
import { EvimedSearchActions } from "./EvimedSearchActions";
import { EvimedReaderBack } from "./EvimedReaderBack";
import { searchDetailFacts, structuredAbstract } from "./evimedReaderContent";

const READER = {
  literature: { label: "文献详情", information: "文献信息", empty: "这篇文献暂无可阅读的摘要。", icon: FileText },
  guidelines: { label: "指南详情", information: "指南信息", empty: "这份指南暂无可阅读的正文或内容简介。", icon: BookOpen },
  drugs: { label: "药品说明书", information: "药品信息", empty: "这份说明书暂无可阅读的章节。", icon: Pill },
  trials: { label: "临床试验详情", information: "试验信息", empty: "这项试验暂无可阅读的详情。", icon: FileText },
} as const;

function ReaderText({ text }: { text: string }) {
  return <div className="max-w-measure space-y-3 text-ui leading-relaxed text-text">
    {text.split(/\n\s*\n/).filter(paragraph => paragraph.trim()).map((paragraph, index) =>
      <p key={index} className="whitespace-pre-wrap">{paragraph}</p>)}
  </div>;
}

/** Search readers share the page measure, source facts and navigation without changing retrieved content. */
export function EvimedSearchReader({ category, detail, backTo, onSearch, onCollectedChange }: {
  category: EvimedSearchCategory; detail: EvimedSearchDetail; backTo: string;
  onSearch(): void; onCollectedChange(actionRef: string, collected: boolean): void;
}) {
  const wide = useWide();
  const article = useRef<HTMLElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const [awayFromTop, setAwayFromTop] = useState(false);
  const [railLeft, setRailLeft] = useState<number>();
  const prefix = `search-reader-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const { entries, active, select } = useOutline(article, { idPrefix: prefix, refresh: [detail, wide] });
  const content = READER[category];
  const Icon = content.icon;
  const facts = searchDetailFacts(detail);
  const sections = detail.sections.filter(section => section.text.trim());
  const source = evimedSourceUrl(detail.url) ?? (detail.doi ? evimedSourceUrl(`https://doi.org/${encodeURIComponent(detail.doi)}`) : null);
  const outlined = entries.length > 1;
  useLayoutEffect(() => {
    const scroller = top.current?.closest<HTMLElement>(".overflow-y-auto");
    if (!scroller) return;
    const readScroll = () => setAwayFromTop(scroller.scrollTop > 0);
    const measure = () => {
      setRailLeft(wide ? rail.current?.getBoundingClientRect().left : undefined);
      readScroll();
    };
    measure();
    scroller.addEventListener("scroll", readScroll, { passive: true });
    // The reading column moves when the app sidebar changes width, even without a window resize.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(scroller);
    window.addEventListener("resize", measure);
    return () => {
      scroller.removeEventListener("scroll", readScroll);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [detail, wide, outlined]);
  const information = facts.length > 0 && <Section title={content.information} compact>
    <FactList rows={facts} max={6} ruled={false} layout={wide ? "stacked" : "rows"} />
  </Section>;
  const toTop = () => {
    top.current?.scrollIntoView?.({ block: "start" });
    top.current?.querySelector<HTMLAnchorElement>("a")?.focus({ preventScroll: true });
  };
  const jump = (id: string) => {
    select(id);
    const heading = document.getElementById(id);
    if (heading && article.current?.contains(heading)) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  };
  return <PageShell width="page" title={detail.title || content.label} titleVariant="document" actionPlan={{}}
    contentClassName="break-words pb-28 lg:pb-0" backPlacement="edge"
    back={<div ref={top} className="scroll-mt-6"><EvimedReaderBack fallback={backTo} /></div>}
    eyebrow={<div className="flex items-center gap-2 text-caption text-text-2"><Icon size={16} aria-hidden="true" />{content.label}</div>}
    underTitle={<div className="mt-4 space-y-4 border-b border-border pb-4">
      <div className="flex flex-wrap items-start gap-2">
        <EvimedSearchActions category={category} item={{ ...detail, id: detail.id ?? detail.actionRef ?? "" }} compact={false}
          onRefresh={onSearch} onCollectedChange={value => { if (detail.actionRef) onCollectedChange(detail.actionRef, value); }} />
        {source && <a href={source} target="_blank" rel="noopener noreferrer" className={buttonClasses({ variant: "text", size: "sm" })}>
          打开原文<ArrowUpRight size={16} aria-hidden="true" />
        </a>}
      </div>
      {!wide && information}
    </div>}
    aside={wide && (facts.length > 0 || outlined) ? <div className="max-h-[calc(100dvh-15rem)] overflow-y-auto border-l border-border pl-5">
      <div ref={rail} className="space-y-6">
        {information}
        {outlined && <Section title="本页目录" compact>
          <Outline layout="inline" entries={entries} active={active ?? entries[0]?.id ?? null} onSelect={jump} label="本页目录" />
        </Section>}
      </div>
    </div> : undefined}
    asideLabel="阅读辅助">
    {!wide && outlined && <Outline layout="folded" entries={entries} active={active ?? entries[0]?.id ?? null} onSelect={jump} label="本页目录" className="mb-6" />}
    <article ref={article} aria-label={content.label} data-prose="" className="min-w-0 space-y-6 break-words [&_h2]:scroll-mt-4 [&_h3]:scroll-mt-4">
      {sections.map((section, index) => {
        const parts = category === "literature" && /^(摘要|概要|abstract|summary)$/i.test(section.title.trim()) ? structuredAbstract(section.text) : null;
        return <Section key={`${index}-${section.title}`} title={section.title} compact className="border-b border-faint pb-6 last:border-b-0">
          {parts ? parts.map((part, partIndex) => <Section key={partIndex} title={part.title} level="sub"><ReaderText text={part.text} /></Section>)
            : <ReaderText text={section.text} />}
        </Section>;
      })}
      {sections.length === 0 && <StateScreen icon={Search} title={content.empty} />}
    </article>
    {sections.length > 0 && awayFromTop && <Button onClick={toTop}
      style={railLeft === undefined ? undefined : { left: railLeft, right: "auto" }}
      className="fixed bottom-[max(5rem,env(safe-area-inset-bottom))] right-4 z-sticky shadow-e2 md:right-6">
      <ArrowUp size={16} aria-hidden="true" />回到顶部
    </Button>}
  </PageShell>;
}
