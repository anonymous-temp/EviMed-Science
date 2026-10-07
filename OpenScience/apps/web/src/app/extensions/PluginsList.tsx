import { useState } from "react";
import { ChevronRight, Puzzle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { List, ListRow } from "@/components/ui/ListRow";
import { Switch } from "@/components/ui/Switch";
import type { CatalogueExtension, ExtensionInstallation, PluginInventory } from "@/lib/extensionsClient";
import { ENGINE_COPY, PLUGIN_COPY, type PluginCopyId } from "./extensionCopy";
import { extensionState } from "./ExtensionDrawer";
import type { useCitationPlugin } from "./useCitationPlugin";

/** What a row opens. The cite row opens the citation drawer, the others a drawer of their own kind. */
export type PluginTarget =
  | { kind: "cite" } | { kind: "tools" } | { kind: "info"; id: "web-read" | "dsh-annotation" | "dsh-mermaid" }
  | { kind: "engine"; id: string } | { kind: "extension"; id: string };

/** Engines a group shows before 「展开其余 N 个」. */
const ENGINES_SHOWN = 3;

/** The extensions the centre has: the ones the reader added, and the ones on offer that they have not. */
export interface ExtensionRows { installed: ExtensionInstallation[]; offered: CatalogueExtension[] }

/** The title an installed extension is listed under: its catalogue row's, or nothing until the catalogue is read. */
const installedTitle = (item: ExtensionInstallation, offered: readonly CatalogueExtension[], all: readonly CatalogueExtension[]) =>
  (all.find(entry => entry.id === item.catalogueId) ?? offered.find(entry => entry.id === item.catalogueId))?.title ?? "";

/** The rows the plugins list will draw, for the tab's count: the citation check and the tool set, whatever else is on, each engine, each extension. */
export function countPlugins(inventory: PluginInventory | null, extensions: ExtensionRows | null): number {
  if (!inventory) return 0;
  const on = inventory.items.filter(item => item.id !== "dsh-cite" && item.enabled !== false).length;
  return 2 + (inventory.webRead ? 1 : 0) + on + inventory.engines.length + (extensions ? extensions.installed.length + extensions.offered.length : 0);
}

function Group({ name, aside, children }: { name: string; aside?: string; children: React.ReactNode }) {
  return (
    <section aria-label={name} className="flex flex-col">
      <h2 className="flex items-baseline justify-between gap-2 px-2 pb-1 text-caption text-text-3"><span>{name}</span>{aside && <span>{aside}</span>}</h2>
      {children}
    </section>
  );
}

/**
 * The plugins page's one list, in two groups: what a conversation has to work with, and the calculation engines the research
 * tools call in the background — and, when the deployment offers any, the reader's own extensions and the ones they can add.
 *
 * Only what can really be switched has a switch (the citation check, per project); the rest says 「始终开启」 or its
 * readiness. Nothing says a state the page cannot know.
 */
export function PluginsList({ inventory, citation, extensions, allCatalogue, query, busyId, onOpen, onInstall }: {
  inventory: PluginInventory;
  citation: ReturnType<typeof useCitationPlugin>;
  extensions: ExtensionRows | null;
  allCatalogue: readonly CatalogueExtension[];
  query: string;
  busyId: string | null;
  onOpen: (target: PluginTarget) => void;
  onInstall: (entry: CatalogueExtension) => void;
}) {
  const [allEngines, setAllEngines] = useState(false);
  const needle = query.trim().toLowerCase();
  const show = (...texts: string[]) => !needle || texts.some(text => text.toLowerCase().includes(needle));
  const cite = PLUGIN_COPY["dsh-cite"];
  // What else is on: web reading where the deployment offers it, and the two browser-side packs unless it turned them off.
  const infoIds = [
    ...(inventory.webRead ? ["web-read" as const] : []),
    ...inventory.items.flatMap(item => (item.id === "dsh-annotation" || item.id === "dsh-mermaid") && item.enabled !== false ? [item.id] : []),
  ];
  const toolRows: Array<{ id: PluginCopyId; target: PluginTarget }> = [
    { id: "research-tools", target: { kind: "tools" } },
    ...infoIds.map(id => ({ id, target: { kind: "info", id } as PluginTarget })),
  ];
  const visibleTools = toolRows.filter(row => show(PLUGIN_COPY[row.id].title, PLUGIN_COPY[row.id].use));
  const citeShown = show(cite.title, cite.use);
  const engines = inventory.engines.flatMap(state => {
    const copy = ENGINE_COPY.find(engine => engine.id === state.id);
    return copy && show(copy.title, copy.use) ? [{ copy, available: state.available }] : [];
  });
  const foldedEngines = !needle && !allEngines && engines.length > ENGINES_SHOWN ? engines.slice(ENGINES_SHOWN) : [];
  const shownEngines = foldedEngines.length ? engines.slice(0, ENGINES_SHOWN) : engines;
  const installed = (extensions?.installed ?? []).filter(item => show(installedTitle(item, extensions?.offered ?? [], allCatalogue)));
  const offered = (extensions?.offered ?? []).filter(entry => show(entry.title));
  const nothing = !citeShown && visibleTools.length === 0 && engines.length === 0 && installed.length === 0 && offered.length === 0;
  const CiteIcon = cite.icon;
  return (
    <div className="flex flex-col gap-6">
      {(citeShown || visibleTools.length > 0) && (
        <Group name="对话里的工具">
          <List label="对话里的工具" divided>
            {citeShown && (
              <ListRow leading={<CiteIcon size={20} aria-hidden className="text-text-3" />} title={cite.title} meta={cite.use} onOpen={() => onOpen({ kind: "cite" })}
                trailing={<Switch label={`在当前项目里使用${cite.title}`} checked={citation.plugin?.desired?.enabled ?? inventory.items.find(item => item.id === "dsh-cite")?.enabled ?? false}
                  disabled={citation.busy || !citation.plugin?.desired} onChange={enabled => void citation.save({ enabled })} />} />
            )}
            {visibleTools.map(row => {
              const copy = PLUGIN_COPY[row.id], Icon = copy.icon;
              return <ListRow key={row.id} leading={<Icon size={20} aria-hidden className="text-text-3" />} title={copy.title}
                meta={row.id === "research-tools" ? `${copy.use}，共 ${inventory.researchTools.count} 个` : copy.use}
                trailing={<><span>始终开启</span><ChevronRight size={16} aria-hidden /></>} onOpen={() => onOpen(row.target)} />;
            })}
          </List>
          {citation.error && !citation.plugin && <p role="alert" className="px-2 pt-2 text-caption text-error">{citation.error}</p>}
        </Group>
      )}
      {engines.length > 0 && (
        <Group name="计算引擎" aside="科研工具在后台调用">
          <List label="计算引擎" divided>
            {shownEngines.map(({ copy, available }) => {
              const Icon = copy.icon;
              return <ListRow key={copy.id} leading={<Icon size={20} aria-hidden className="text-text-3" />} title={copy.title} meta={copy.use}
                trailing={<><span>{available ? "可用" : "暂不可用"}</span><ChevronRight size={16} aria-hidden /></>} onOpen={() => onOpen({ kind: "engine", id: copy.id })} />;
            })}
          </List>
          {!needle && engines.length > ENGINES_SHOWN && (
            <div className="px-2 pt-1">
              <Button variant="text" size="sm" aria-expanded={allEngines} onClick={() => setAllEngines(open => !open)}>
                {allEngines ? "收起" : `展开其余 ${foldedEngines.length} 个：${foldedEngines.map(item => item.copy.short).join("、")}`}
              </Button>
            </div>
          )}
        </Group>
      )}
      {installed.length > 0 && (
        <Group name="我的插件">
          <List label="我的插件" divided>
            {installed.map(item => <ListRow key={item.id} leading={<Puzzle size={20} aria-hidden className="text-text-3" />} title={installedTitle(item, extensions?.offered ?? [], allCatalogue) || "插件"}
              trailing={<><span>{extensionState(item)}</span><ChevronRight size={16} aria-hidden /></>} onOpen={() => onOpen({ kind: "extension", id: item.id })} />)}
          </List>
        </Group>
      )}
      {offered.length > 0 && (
        <Group name="可以添加">
          <List label="可以添加" divided>
            {offered.map(entry => <ListRow key={entry.id} leading={<Puzzle size={20} aria-hidden className="text-text-3" />} title={entry.title} onOpen={() => onOpen({ kind: "extension", id: entry.id })}
              actions={<Button variant="text" size="sm" disabled={busyId !== null} loading={busyId === entry.id} onClick={() => onInstall(entry)}>添加</Button>} />)}
          </List>
        </Group>
      )}
      {nothing && <p role="status" className="px-2 py-6 text-center text-ui text-text-3">没有找到插件</p>}
    </div>
  );
}
