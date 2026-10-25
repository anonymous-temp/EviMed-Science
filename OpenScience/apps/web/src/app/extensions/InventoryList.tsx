import { searchMatches } from "@evimed/domain";
import { List, ListRow } from "@/components/ui/ListRow";
import type { Inventory } from "@/lib/extensionsClient";
import { inventoryIcon } from "./inventoryIcons";

/** System-owned services have their existing task/account controls, not package install switches. */
export function InventoryList({ inventory, query, onOpen }: { inventory: Inventory; query: string; onOpen: (id: string) => void }) {
  const items = inventory.groups.flatMap(group => group.items).filter(item => searchMatches(query, [item.title, item.use, item.publisher ?? ""]));
  return <List label="系统提供的能力" divided>{items.map(item => {
    const Icon = inventoryIcon(item.icon);
    const leading = <Icon size={20} aria-hidden className="text-text-3" />;
    const meta = [item.publisher, item.use].filter(Boolean).join(" · ");
    return item.opens.kind === "page"
      ? <ListRow key={item.id} title={item.title} meta={meta} leading={leading} to={item.opens.to} />
      : <ListRow key={item.id} title={item.title} meta={meta} leading={leading} onOpen={() => onOpen(item.id)} />;
  })}</List>;
}
