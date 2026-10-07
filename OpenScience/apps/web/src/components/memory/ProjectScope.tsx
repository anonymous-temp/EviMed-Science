import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { FilterChip } from "@/components/ui/FilterChips";
import { type ProjectChoice, type ProjectKind } from "./memoryItems";

/** The heading of each group the dropdown lists: the researcher's own projects need none. */
const GROUP_HEADINGS: Record<ProjectKind, string | null> = { own: null, vcr: "虚拟临研", geo: "循证 GEO" };

/**
 * The 项目 tab's one control: which project's facts the list shows
 * (2026-10-07 plan §3.2). The researcher's own projects come first; the studies
 * of 虚拟临研 and the projects of 循证 GEO — each an ordinary project underneath
 * — are listed in a group of their own, as the sidebar and the knowledge base
 * list them, so two studies with the same name are never mistaken for the
 * researcher's own projects.
 *
 * A group's heading is an item that cannot be chosen: the menu has no heading
 * entry, and a group of items with nothing to say what it is would be the
 * mistake this exists to end.
 */
export function ProjectScope({ choices, value, onChange }: {
  choices: readonly ProjectChoice[];
  /** The id of the project shown; it is one of `choices`. */
  value: string | null;
  onChange: (id: string) => void;
}) {
  const chosen = choices.find((choice) => choice.id === value) ?? null;
  const items: MenuEntry[] = [];
  let group: ProjectKind | null = null;
  for (const choice of choices) {
    if (choice.kind !== group) {
      const heading = GROUP_HEADINGS[choice.kind];
      if (items.length > 0) items.push("separator");
      if (heading) items.push({ label: heading, disabled: true, onSelect: () => undefined });
      group = choice.kind;
    }
    items.push({ label: choice.name, checked: choice.id === value, onSelect: () => onChange(choice.id as string) });
  }
  return (
    <Menu label="项目" align="start" items={items}>
      <FilterChip menu aria-label={chosen ? `项目：${chosen.name}` : "项目"}>{chosen?.name ?? "选择项目"}</FilterChip>
    </Menu>
  );
}
