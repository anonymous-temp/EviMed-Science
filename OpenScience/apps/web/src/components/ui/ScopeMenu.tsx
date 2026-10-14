import { ChevronDown, FolderOpen, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { FilterChip } from "@/components/ui/FilterChips";
import { Menu, type MenuEntry } from "@/components/ui/Menu";

/**
 * Whose things a page shows (R19, plan §2.1, D §3.1): the project, or a kind of project, or everyone's. One menu for the three
 * shapes the product had — the knowledge base's `KnowledgeScopeMenu` in the header (a button, groups by kind of project, and an
 * entry that is not a project), the memory page's `ProjectScope` inside the page (a chip, groups with headings, a project always
 * chosen) and the memory map's project select among its filters (a chip that can be cleared to 「全部项目」).
 *
 * `PageShell`'s `scope` slot draws it after the title (`variant="button"`); inside a `Toolbar` it is the chip.
 *
 * Choosing here changes what the page lists and nothing else: it does not move the sidebar or the conversation to that
 * project.
 *
 * ```tsx
 * <PageShell title="知识库" scope={{
 *   label: "范围",
 *   groups: [{ heading: "我的项目", choices }, { choices: [{ id: "shared", label: "所有项目共享", icon: Library }] }],
 *   value: scopeId, onChange: setScope,
 * }} />
 * ```
 */
export interface ScopeChoice {
  id: string;
  label: string;
  /** Drawn on the trigger while this choice is the one chosen. */
  icon?: LucideIcon;
}

export interface ScopeGroup {
  /** A quiet label over the group (「虚拟临床研究」); a group without one is told from the last by its separator. */
  heading?: string;
  choices: readonly ScopeChoice[];
}

export interface ScopeMenuProps {
  /** The menu's name, and what the chip says while nothing is chosen (「范围」「项目」). */
  label: string;
  groups: readonly ScopeGroup[];
  /** The id chosen, or null for 「全部」. */
  value: string | null;
  onChange(id: string | null): void;
  /** The entry, listed first, that clears the choice (「全部项目」). Absent: one of the choices is always made. */
  allLabel?: string;
  /** `button`: a header's control with the choice's icon; `chip`: one filter among a toolbar's. */
  variant?: "button" | "chip";
}

export function ScopeMenu({ label, groups, value, onChange, allLabel, variant = "button" }: ScopeMenuProps) {
  const choices = groups.flatMap((group) => group.choices);
  const chosen = choices.find((choice) => choice.id === value) ?? null;
  const entries: MenuEntry[] = [];
  if (allLabel) entries.push({ label: allLabel, checked: chosen === null, onSelect: () => onChange(null) });
  groups.forEach((group, index) => {
    if (group.choices.length === 0) return;
    if (entries.length > 0 && (index > 0 || allLabel)) entries.push("separator");
    if (group.heading) entries.push({ heading: group.heading });
    for (const choice of group.choices) {
      entries.push({ label: choice.label, icon: choice.icon, checked: choice.id === value, onSelect: () => onChange(choice.id) });
    }
  });
  const name = chosen?.label ?? allLabel ?? label;
  const accessible = chosen ? `${label}：${chosen.label}` : label;
  const Icon = chosen?.icon ?? FolderOpen;
  return (
    <Menu label={label} align="start" items={entries} className="max-h-96 overflow-y-auto">
      {variant === "chip" ? (
        <FilterChip menu pressed={chosen !== null} aria-label={accessible}>{chosen?.label ?? label}</FilterChip>
      ) : (
        <Button variant="secondary" aria-label={accessible} className="max-w-56">
          <Icon size={16} aria-hidden="true" />
          <span className="min-w-0 truncate">{name}</span>
          <ChevronDown size={16} className="shrink-0 text-text-3" aria-hidden="true" />
        </Button>
      )}
    </Menu>
  );
}
