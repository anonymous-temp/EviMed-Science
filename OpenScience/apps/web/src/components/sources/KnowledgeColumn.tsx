import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { listPath, stateForView, type KnowledgeListState, type KnowledgeView } from "@/lib/knowledgeNav";
import { buttonClasses } from "@/components/ui/Button";
import { List, ListRow } from "@/components/ui/ListRow";
import type { ProjectChoice, ProjectGroups } from "./useProjectGroups";

const VIEWS: ReadonlyArray<{ id: KnowledgeView; label: string }> = [
  { id: "documents", label: "资料" },
  { id: "pages", label: "知识页" },
  { id: "graph", label: "图谱" },
  { id: "outputs", label: "对话产出" },
];

/**
 * The four views of the knowledge base, as links at the head of the list column — 资料 · 知识页 · 图谱 · 对话产出 — and not as a tab list: the
 * page is a master-detail page, and which of the four it shows is part of its address, so each is a link to it. 资料 is every document of the
 * account; the other three are a project's, and in them the column lists the projects. The pages and the graph are offered where the
 * deployment compiles them (or a project has compiled files already); the delivered files are offered always, and say so when a project has none.
 */
export function KnowledgeViews({ view, state, pagesOffered }: { view: KnowledgeView; state: KnowledgeListState; pagesOffered: boolean }) {
  // The pages and the graph are one offer: where either is open, both are, so the two read as a pair wherever the deployment compiles nothing.
  const compiled = pagesOffered || view === "pages" || view === "graph";
  const shown = VIEWS.filter((entry) => compiled || (entry.id !== "pages" && entry.id !== "graph"));
  return (
    <nav aria-label="知识库的内容" data-knowledge-views="" className="flex shrink-0 flex-wrap items-center gap-1">
      {shown.map((entry) => (
        <Link
          key={entry.id}
          to={listPath(stateForView(state, entry.id))}
          aria-current={entry.id === view ? "page" : undefined}
          className={buttonClasses({ variant: "text", size: "sm", className: cn("px-2", entry.id === view ? "font-semibold text-text hover:text-text" : "") })}
        >
          {entry.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * The projects, as the column of the three project views: a project is chosen, and the pane shows its pages, graph or delivered files. The
 * ones the person works in come first, then the studies and the 循证 GEO projects, each under its own heading when there is more than one
 * kind. A row is a link to the same view of that project, so the choice is in the address.
 */
export function ProjectList({ groups, chosen, hrefFor }: { groups: ProjectGroups; chosen: string | null; hrefFor: (projectId: string) => string }) {
  const kinds = [
    { heading: "我的项目", choices: groups.own },
    { heading: "虚拟临床研究", choices: groups.studies },
    { heading: "循证 GEO", choices: groups.communication },
  ].filter((kind) => kind.choices.length > 0);
  const row = (choice: ProjectChoice) => (
    <ListRow key={choice.id} to={hrefFor(choice.id)} selected={choice.id === chosen} title={<span className="block truncate">{choice.label}</span>} />
  );
  return (
    <div data-project-list="">
      {kinds.map((kind) => (
        <section key={kind.heading} aria-label={kind.heading}>
          {kinds.length > 1 && <h3 className="px-2 pb-1 pt-3 text-caption text-text-3">{kind.heading}</h3>}
          <List label={kind.heading}>{kind.choices.map(row)}</List>
        </section>
      ))}
    </div>
  );
}
