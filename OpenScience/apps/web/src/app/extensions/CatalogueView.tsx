import type { ReactNode } from "react";
import { BookOpen, ChartNoAxesCombined, FileText, FlaskConical, Github, PenLine, Puzzle, type LucideIcon } from "lucide-react";
import { buttonClasses } from "@/components/ui/Button";
import { List, ListRow } from "@/components/ui/ListRow";
import { Section } from "@/components/ui/Section";
import { catalogueOrigins, type CatalogueOrigin } from "./catalogueModel";

export interface CatalogueEntry {
  id: string; title: string; description: string; publisher: string;
  type: "skills" | "plugins"; group: string;
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

/**
 * Source links have their own focus target, separate from opening or enabling an entry. The link is drawn as the quiet text action
 * beside it (查看, 管理, 开始使用): one look for one job, where a 12 px link of its own height was a kind of control of its own on every
 * page of the extension centre (release walk of evimed-b559d4b7ebd0-1).
 */
export function RepositoryLink({ href, title }: { href?: string | null; title: string }) {
  return href ? <a href={href} target="_blank" rel="noopener noreferrer" aria-label={`${title} 的 GitHub`}
    className={buttonClasses({ variant: "text", size: "sm", className: "gap-1.5" })}>
    <Github size={16} aria-hidden />GitHub</a> : null;
}

/** The added skills and plugins, by origin: each row says who published it, whether it is in force here, and holds the project's switch. */
export function CatalogueView({ entries }: { entries: CatalogueEntry[] }) {
  return <div aria-label="已添加的技能与插件">{catalogueOrigins.map(origin => {
    const rows = entries.filter(entry => entry.origin === origin.value);
    if (!rows.length) return null;
    return <Section key={origin.value} title={origin.label} count={`${rows.length} 项`} compact>
      <List label={`${origin.label}已添加的技能与插件`} divided>{rows.map(entry => {
        const Icon = entryIcon(entry);
        return <ListRow key={entry.id} title={entry.title} {...entry.to ? { to: entry.to } : { onOpen: entry.open }} leading={<Icon size={20} aria-hidden className="text-text-3" />}
          meta={<span className="flex flex-wrap gap-x-3 gap-y-1"><span>{entry.publisher}</span>{entry.state && <span>{entry.state}</span>}</span>}
          actions={<div className="flex items-center gap-4"><RepositoryLink href={entry.repository} title={entry.title} />{entry.action}</div>} />;
      })}</List>
    </Section>;
  })}</div>;
}
