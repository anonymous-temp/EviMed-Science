import { Puzzle } from "lucide-react";
import { searchMatches } from "@evimed/domain";
import { Button } from "@/components/ui/Button";
import { List, ListRow } from "@/components/ui/ListRow";
import { Section } from "@/components/ui/Section";
import { Switch } from "@/components/ui/Switch";
import type { CatalogueExtension, ExtensionInstallation, Inventory, InventoryItem } from "@/lib/extensionsClient";
import { extensionState } from "./ExtensionDrawer";
import { inventoryIcon } from "./inventoryIcons";
import type { useCitationPlugin } from "./useCitationPlugin";

/** What a row opens: one of the platform's items in a drawer, or an extension the reader has or may add. */
export type InventoryTarget = { kind: "item"; id: string } | { kind: "extension"; id: string };

/** The extensions the centre has: the ones the reader added, and the ones on offer that they have not. */
export interface ExtensionRows { installed: ExtensionInstallation[]; offered: CatalogueExtension[] }

/** The title an installed extension is listed under: its catalogue row's, or nothing until the catalogue is read. */
const installedTitle = (item: ExtensionInstallation, offered: readonly CatalogueExtension[], all: readonly CatalogueExtension[]) =>
  (all.find(entry => entry.id === item.catalogueId) ?? offered.find(entry => entry.id === item.catalogueId))?.title ?? "";

/** The rows the list draws, whatever the search says: the tab's count is this. */
export function countPlugins(inventory: Inventory | null, extensions: ExtensionRows | null): number {
  if (!inventory) return 0;
  const items = inventory.groups.reduce((sum, group) => sum + group.items.length, 0);
  return items + (extensions ? extensions.installed.length + extensions.offered.length : 0);
}

/**
 * The plugins page's one list: what a conversation in this project has to work with, in the platform's own words — which the
 * server hands over, generated from what the image carries — and, when the deployment offers any, the reader's own extensions
 * and the ones they can add.
 *
 * A row is something a person can use or open: a switch where there is one (the citation check, per project), a link where the
 * thing has a page of its own (memory), a drawer for the rest. Nothing says 「始终开启」, nothing lists an engine nobody can
 * choose, and nothing counts the tools: a state the person cannot change and a number they cannot act on are not rows' business.
 */
export function InventoryList({ inventory, citation, extensions, allCatalogue, query, busyId, onOpen, onInstall }: {
  inventory: Inventory;
  citation: ReturnType<typeof useCitationPlugin>;
  extensions: ExtensionRows | null;
  allCatalogue: readonly CatalogueExtension[];
  query: string;
  busyId: string | null;
  onOpen: (target: InventoryTarget) => void;
  onInstall: (entry: CatalogueExtension) => void;
}) {
  // A retired module name still finds the module's rows until 2027-01-07 (`searchMatches`).
  const show = (...texts: string[]) => searchMatches(query, texts);
  const groups = inventory.groups
    .map(group => ({ ...group, items: group.items.filter(item => show(item.title, item.use)) }))
    .filter(group => group.items.length > 0);
  const installed = (extensions?.installed ?? []).filter(item => show(installedTitle(item, extensions?.offered ?? [], allCatalogue)));
  const offered = (extensions?.offered ?? []).filter(entry => show(entry.title));
  const nothing = groups.length === 0 && installed.length === 0 && offered.length === 0;
  // The switch shows what was asked for; when that did not take (rolled back, runtime away, failed) the row says so, and the
  // drawer it opens has 重试 — never a saved setting standing in for a state that never arrived.
  const citeFailed = citation.plugin?.phase === "rolled_back" || citation.plugin?.phase === "unavailable" || citation.plugin?.phase === "failed";

  const row = (item: InventoryItem) => {
    const Icon = inventoryIcon(item.icon);
    const leading = <Icon size={20} aria-hidden className="text-text-3" />;
    const control = item.control;
    // Only a setting this page can reach is drawn as a switch: the citation check, whose state is the project's.
    const trailing = control.kind === "switch" && control.setting === "dsh-cite" ? (
      <Switch label={`在当前项目里使用${item.title}`} checked={citation.plugin?.desired?.enabled ?? item.state === "on"}
        disabled={citation.busy || !citation.plugin?.desired} onChange={enabled => void citation.save({ enabled })} />
    ) : undefined;
    const meta = control.kind === "switch" && citeFailed ? "这项设置没能生效，点开重试" : item.use;
    return item.opens.kind === "page"
      ? <ListRow key={item.id} leading={leading} title={item.title} meta={meta} to={item.opens.to} />
      : <ListRow key={item.id} leading={leading} title={item.title} meta={meta} trailing={trailing} onOpen={() => onOpen({ kind: "item", id: item.id })} />;
  };

  return (
    <div className="flex flex-col gap-6">
      {groups.map(group => (
        <Section key={group.id} title={group.title}>
          <List label={group.title} divided>{group.items.map(row)}</List>
          {citation.error && !citation.plugin && group.items.some(item => item.control.kind === "switch") && (
            <p role="alert" className="px-2 pt-2 text-caption text-error">{citation.error}</p>
          )}
        </Section>
      ))}
      {installed.length > 0 && (
        <Section title="我的插件">
          <List label="我的插件" divided>
            {installed.map(item => <ListRow key={item.id} leading={<Puzzle size={20} aria-hidden className="text-text-3" />} title={installedTitle(item, extensions?.offered ?? [], allCatalogue) || "插件"}
              trailing={<span>{extensionState(item)}</span>} onOpen={() => onOpen({ kind: "extension", id: item.id })} />)}
          </List>
        </Section>
      )}
      {offered.length > 0 && (
        <Section title="可以添加">
          <List label="可以添加" divided>
            {offered.map(entry => <ListRow key={entry.id} leading={<Puzzle size={20} aria-hidden className="text-text-3" />} title={entry.title} onOpen={() => onOpen({ kind: "extension", id: entry.id })}
              actions={<Button variant="text" size="sm" disabled={busyId !== null} loading={busyId === entry.id} onClick={() => onInstall(entry)}>添加</Button>} />)}
          </List>
        </Section>
      )}
      {nothing && <p role="status" className="px-2 py-6 text-center text-ui text-text-3">没有找到插件</p>}
    </div>
  );
}
