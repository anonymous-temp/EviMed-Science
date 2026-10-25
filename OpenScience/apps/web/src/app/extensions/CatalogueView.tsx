import type { ReactNode } from "react";
import { BookOpen, Puzzle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { List, ListRow } from "@/components/ui/ListRow";
import { Tag } from "@/components/ui/Tag";

export interface CatalogueEntry {
  id: string; title: string; description: string; publisher: string;
  type: "skills" | "plugins"; group: string; added: boolean;
  state?: string; action?: ReactNode; open: () => void;
}

/** Discovery explains a choice; the added list makes its scope and controls scannable. */
export function CatalogueView({ entries, view }: { entries: CatalogueEntry[]; view: "discover" | "installed" }) {
  if (view === "installed") return <List label="已添加的技能与插件" divided>{entries.map(entry => {
    const Icon = entry.type === "skills" ? BookOpen : Puzzle;
    return <ListRow key={entry.id} title={entry.title} onOpen={entry.open} leading={<Icon size={20} aria-hidden className="text-text-3" />}
      meta={<span className="flex flex-wrap gap-x-3"><span>{entry.publisher}</span>{entry.state && <span>{entry.state}</span>}</span>} actions={entry.action} />;
  })}</List>;
  return <ul aria-label="发现技能与插件" className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{entries.map(entry => {
    const Icon = entry.type === "skills" ? BookOpen : Puzzle;
    return <li key={entry.id} aria-label={entry.title} className="min-w-0">
      <Card className="flex h-full flex-col [&>div]:flex [&>div]:flex-1 [&>div]:flex-col">
        <div className="flex items-start gap-3">
          <Icon size={20} aria-hidden className="mt-1 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <Button variant="text" className="h-auto max-w-full whitespace-normal p-0 text-left font-semibold" onClick={entry.open}>{entry.title}</Button>
            <div className="mt-1 break-words text-caption text-text-3">{entry.publisher}</div>
          </div>
        </div>
        <p data-prose className="mb-5 mt-3 line-clamp-3 text-ui text-text-2">{entry.description}</p>
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
          <Tag>{entry.type === "skills" ? "技能" : "插件"}</Tag>
          {entry.action ?? <Button size="sm" variant="text" onClick={entry.open}>{entry.added ? "管理" : "查看"}</Button>}
        </div>
      </Card>
    </li>;
  })}</ul>;
}
