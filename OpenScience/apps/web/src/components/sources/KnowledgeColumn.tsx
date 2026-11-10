import { List, ListRow } from "@/components/ui/ListRow";
import type { ProjectChoice, ProjectGroups } from "./useProjectGroups";

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
          {kinds.length > 1 && <h2 className="px-2 pb-1 pt-3 text-caption text-text-3">{kind.heading}</h2>}
          <List label={kind.heading}>{kind.choices.map(row)}</List>
        </section>
      ))}
    </div>
  );
}
