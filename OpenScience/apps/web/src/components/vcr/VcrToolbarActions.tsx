import { MoreHorizontal, type LucideIcon } from "lucide-react";
import { useNarrow } from "@/lib/useMediaQuery";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Menu, type MenuEntry } from "@/components/ui/Menu";

/**
 * The buttons at a toolbar's end: each its own button on a page, and one 「⋯」 menu under 640 px, where a row of four would run off
 * the edge (R19, plan §5.3: 「下载 · 重新生成 · 改设定」). An action that is not available is not given: a disabled button with no
 * stated reason does not exist on these pages, so the list is built from what the reader may do, and this only draws it.
 */
export interface VcrToolbarAction {
  key: string;
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  /** The work is going on: a spinner on the button, and the entry is disabled in the menu. */
  loading?: boolean;
  /** `text` for the quiet ones (a record's opener), `secondary` otherwise. */
  quiet?: boolean;
}

export function VcrToolbarActions({ actions, label = "更多操作", menu = false }: {
  actions: readonly VcrToolbarAction[];
  label?: string;
  /** All of them behind one 「⋯」, on every width: templates and imports, which a reader reaches for once in a while. */
  menu?: boolean;
}) {
  const narrow = useNarrow();
  if (actions.length === 0) return null;
  if (narrow || menu) {
    const items: MenuEntry[] = actions.map((action) => ({ label: action.label, icon: action.icon, disabled: action.loading, onSelect: action.onSelect }));
    return (
      <Menu label={label} items={items}>
        <IconButton icon={MoreHorizontal} label={label} size="sm" />
      </Menu>
    );
  }
  return (
    <>
      {actions.map((action) => (
        <Button key={action.key} size="sm" variant={action.quiet ? "text" : "secondary"} loading={action.loading} onClick={action.onSelect}>
          {action.icon && <action.icon size={16} aria-hidden="true" />}
          {action.label}
        </Button>
      ))}
    </>
  );
}
