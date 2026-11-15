import { EmptyState } from "@/components/cards/EmptyState";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { List, ListRow } from "@/components/ui/ListRow";
import type { ProjectChoice, ProjectGroups } from "./useProjectGroups";

/**
 * The projects, as the column of the three project views: a project is chosen, and the pane shows its pages, graph or delivered files. The
 * ones the person works in come first, then the studies and the 循证 GEO projects, each under its own heading when there is more than one
 * kind. A row is a link to the same view of that project, so the choice is in the address. The current project stays reachable while the
 * groups load, and an empty read says so rather than leaving a blank column.
 */
export function ProjectList({ groups, chosen, hrefFor, current = null, loading = false }: {
  groups: ProjectGroups;
  chosen: string | null;
  hrefFor: (projectId: string) => string;
  current?: ProjectChoice | null;
  loading?: boolean;
}) {
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
      {loading && <FilesSkeleton />}
      {kinds.length > 0 ? kinds.map((kind) => (
        <section key={kind.heading} aria-label={kind.heading}>
          {kinds.length > 1 && <h2 className="px-2 pb-1 pt-3 text-caption text-text-3">{kind.heading}</h2>}
          <List label={kind.heading}>{kind.choices.map(row)}</List>
        </section>
      )) : current ? (
        <List label="我的项目">{[current].map(row)}</List>
      ) : !loading && <EmptyState title="暂时没有可显示的项目" reason="项目读取后，会在这里列出。" />}
    </div>
  );
}
