import { List, ListRow } from "@/components/ui/ListRow";
import { TaskGroup } from "./TaskGroup";
import { RECOMMENDATIONS, type Recommendation } from "./taskPresentation";

/**
 * 「从示例开始」: what the list column holds while the project has no task. The examples are starting points and not tasks — a row fills
 * the new-task form beside the list (`/app/autopilot/new?example=<id>`) and creates nothing — so the column that will hold the researcher's
 * tasks says what a first one can be, in the rows it will later have: the name and a line of the instruction, the open one marked.
 *
 * `locked` is a form that is saving or has just made a task: nothing may replace it then, as in the dialog this column replaced.
 */
export function TaskExamples({ selectedId, locked = false, onChoose }: {
  /** The example the form was started from. */
  selectedId?: string | null;
  locked?: boolean;
  onChoose: (item: Recommendation) => void;
}) {
  return <TaskGroup label="从示例开始">
    <fieldset disabled={locked} className="min-w-0">
      <List>{RECOMMENDATIONS.map(item => <ListRow key={item.id} title={item.title} selected={item.id === selectedId}
        titleProps={{ "data-example-id": item.id, "aria-current": item.id === selectedId ? "page" : undefined }}
        meta={<span className="block line-clamp-2 break-words">{item.prompt}</span>} onOpen={() => onChoose(item)} />)}</List>
    </fieldset>
  </TaskGroup>;
}
