import type { ReactNode } from "react";
import { Link } from "react-router";
import { BookOpen, ChartNoAxesCombined, FileText, FlaskConical, Github, PenLine, Puzzle, type LucideIcon } from "lucide-react";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { List, ListRow } from "@/components/ui/ListRow";
import { Tag } from "@/components/ui/Tag";
import { Section } from "@/components/ui/Section";
import { catalogueOrigins, type CatalogueOrigin } from "./catalogueModel";

export interface CatalogueEntry {
  id: string; title: string; description: string; publisher: string;
  type: "skills" | "plugins"; group: string; added: boolean;
  origin: CatalogueOrigin; repository?: string | null; icon?: LucideIcon;
  state?: string; action?: ReactNode; open: () => void;
  /** An in-app page the entry is (memory is its own page): its title is a link there, not a drawer. */
  to?: string;
}

function entryIcon(entry: CatalogueEntry): LucideIcon {
  if (entry.icon) return entry.icon;
  if (entry.type === "plugins") return Puzzle;
  if (/办公|文档/.test(entry.group)) return FileText;
  if (/数据|图表|分析/.test(entry.group)) return ChartNoAxesCombined;
  if (/写作|表达/.test(entry.group)) return PenLine;
  if (/研究|科研/.test(entry.group)) return FlaskConical;
  return BookOpen;
}

/** Source links have their own focus target, separate from opening or enabling an entry. */
export function RepositoryLink({ href, title }: { href?: string | null; title: string }) {
  return href ? <a href={href} target="_blank" rel="noopener noreferrer" aria-label={`${title} 的 GitHub`}
    className="inline-flex shrink-0 items-center gap-1.5 rounded text-caption text-text-2 transition-colors hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
    <Github size={16} aria-hidden />GitHub</a> : null;
}

/** Discovery explains a choice; the added list makes its scope and controls scannable. */
export function CatalogueView({ entries, view }: { entries: CatalogueEntry[]; view: "discover" | "installed" }) {
  return <div aria-label={view === "installed" ? "已添加的技能与插件" : "发现技能与插件"}>{catalogueOrigins.map(origin => {
    const rows = entries.filter(entry => entry.origin === origin.value);
    if (!rows.length) return null;
    return <Section key={origin.value} title={origin.label} count={`${rows.length} 项`} compact>
      {view === "installed" ? <List label={`${origin.label}已添加的技能与插件`} divided>{rows.map(entry => {
        const Icon = entryIcon(entry);
        return <ListRow key={entry.id} title={entry.title} {...entry.to ? { to: entry.to } : { onOpen: entry.open }} leading={<Icon size={20} aria-hidden className="text-text-3" />}
          meta={<span className="flex flex-wrap gap-x-3 gap-y-1"><span>{entry.publisher}</span>{entry.state && <span>{entry.state}</span>}</span>}
          actions={<div className="flex items-center gap-4"><RepositoryLink href={entry.repository} title={entry.title} />{entry.action}</div>} />;
      })}</List> : <ul aria-label={`${origin.label}技能与插件`} className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{rows.map(entry => {
    const Icon = entryIcon(entry);
    return <li key={entry.id} aria-label={entry.title} className="min-w-0">
      <Card className="flex h-full flex-col transition-colors hover:border-border-strong focus-within:border-accent [&>div]:flex [&>div]:flex-1 [&>div]:flex-col">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-surface-1"><Icon size={20} aria-hidden className="text-accent" /></div>
          <div className="min-w-0 flex-1">
            {entry.to
              ? <Link to={entry.to} className={buttonClasses({ variant: "text", className: "h-auto max-w-full whitespace-normal p-0 text-left font-semibold text-title-ink" })}>{entry.title}</Link>
              : <Button variant="text" className="h-auto max-w-full whitespace-normal p-0 text-left font-semibold text-title-ink" onClick={entry.open}>{entry.title}</Button>}
            <div className="mt-1 text-caption text-text-3">{entry.group === "插件" ? "对话扩展" : entry.group}</div>
          </div>
          <Tag>{entry.type === "skills" ? "技能" : "插件"}</Tag>
        </div>
        <p data-prose className="mb-5 mt-4 line-clamp-3 text-ui text-text-2">{entry.description}</p>
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 break-words text-caption text-text-3">{entry.publisher}</span>
          <div className="flex items-center gap-3"><RepositoryLink href={entry.repository} title={entry.title} />
            {entry.action ?? (entry.to ? null : <Button size="sm" variant="text" onClick={entry.open}>{entry.added ? "管理" : "查看"}</Button>)}</div>
        </div>
      </Card>
    </li>;
      })}</ul>}
    </Section>;
  })}</div>;
}
