import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { Drawer } from "@/components/ui/Drawer";
import { Input } from "@/components/ui/Input";
import { List, ListRow } from "@/components/ui/ListRow";
import { Switch } from "@/components/ui/Switch";
import { formatClock, formatDay } from "@/lib/format";
import type { WebPluginConfiguration } from "@/lib/apiClient";
import type { Inventory, InventoryItem } from "@/lib/extensionsClient";
import { DrawerSection } from "./PlatformSkillDrawer";
import type { useCitationPlugin } from "./useCitationPlugin";

type Citation = ReturnType<typeof useCitationPlugin>;

/** The tail of a configuration's line in the history: on or off, and the timeout where it is part of it. */
const configurationText = (config: WebPluginConfiguration) =>
  [config.enabled ? "已启用" : "已停用", typeof config.settings.timeoutMs === "number" ? `请求超时 ${Math.round(config.settings.timeoutMs / 1000)} 秒` : null].filter(Boolean).join(" · ");

/**
 * The citation check, opened from its row: the switch for this project, what it does and the tools it brings, and under
 * 「高级设置」 the request timeout and the earlier saved settings.
 *
 * A save is applied when the project is idle, so the drawer says so in one line while one is waiting — and says nothing
 * about versions, states or identifiers: the reader's questions are whether it is on and whether it took.
 */
export function CitationDrawer({ item, citation, projectName, groupTitle, onClose }: {
  /** The item the row is: its title, what it does and what each of its tools does, in the platform's words. */
  item: InventoryItem;
  citation: Citation;
  projectName: string | undefined;
  groupTitle: string;
  onClose: () => void;
}) {
  const { plugin, error, busy, save, retry, restore, history } = citation;
  const desired = plugin?.desired ?? null;
  // The field shows what was saved until the reader types; a save puts it back to what the server now holds.
  const [edit, setEdit] = useState<string | null>(null);
  const [saved, setSaved] = useState<WebPluginConfiguration[] | null>(null);
  const timeoutField = plugin?.settingsSchema.timeoutMs;
  const min = Math.ceil((plugin?.limits.minTimeoutMs ?? 2000) / 1000), max = Math.floor((plugin?.limits.maxTimeoutMs ?? 15000) / 1000);
  const savedSeconds = typeof desired?.settings.timeoutMs === "number" ? String(Math.round(desired.settings.timeoutMs / 1000)) : "";
  const seconds = edit ?? savedSeconds;
  useEffect(() => { setEdit(null); }, [savedSeconds]);
  const revision = desired?.revision ?? 0;
  useEffect(() => {
    if (!plugin || revision === 0) { setSaved([]); return; }
    let live = true;
    void history().then(items => { if (live) setSaved(items); }, () => { if (live) setSaved(null); });
    return () => { live = false; };
  }, [plugin, revision, history]);
  const value = Number(seconds);
  const invalid = !Number.isInteger(value) || value < min || value > max;
  const dirty = seconds !== savedSeconds;
  const waiting = plugin?.phase === "pending" || plugin?.phase === "applying" || plugin?.phase === "saved";
  const failed = plugin?.phase === "rolled_back" || plugin?.phase === "unavailable" || plugin?.phase === "failed";
  // A tool the item has no sentence for is not shown: a name is not a description.
  const tools = (plugin?.tools ?? []).map(name => item.toolSentences?.[name]).filter((sentence): sentence is string => Boolean(sentence));
  return (
    <Drawer title={item.title} description={groupTitle} onClose={onClose}>
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between gap-3">
          <Switch showLabel label={`在“${projectName ?? "当前项目"}”里使用`} checked={desired?.enabled ?? false} disabled={busy || !desired} onChange={enabled => void save({ enabled })} />
        </div>
        {waiting && <p role="status" className="text-ui text-text-2">保存后在下次对话生效</p>}
        {failed && <p role="status" className="flex items-center gap-2 text-ui text-text-2">这项设置没能生效。<Button size="sm" variant="text" disabled={busy} onClick={() => void retry()}>重试</Button></p>}
        {error && <p role="alert" className="text-ui text-error">{error}</p>}
        <DrawerSection title="它会做什么"><p className="text-ui text-text">{item.does}</p></DrawerSection>
        {tools.length > 0 && (
          <DrawerSection title="提供的工具"><ul className="list-disc pl-5 text-ui text-text">{tools.map(sentence => <li key={sentence}>{sentence}</li>)}</ul></DrawerSection>
        )}
        {plugin && (
          <Disclosure summary="高级设置">
            <div className="flex flex-col gap-5 pt-2">
              {timeoutField && (
                <form className="flex flex-col gap-2" noValidate onSubmit={event => { event.preventDefault(); if (!invalid && dirty) void save({ timeoutMs: value * 1000 }); }}>
                  <Input label="请求超时（秒）" type="number" min={min} max={max} step={1} value={seconds} disabled={busy} error={dirty && invalid ? `请输入 ${min}–${max} 之间的整数。` : undefined} onChange={event => setEdit(event.target.value)} />
                  <div><Button type="submit" size="sm" variant="secondary" loading={busy} disabled={!dirty || invalid}>保存</Button></div>
                </form>
              )}
              {saved && saved.length > 0 && (
                <DrawerSection title="配置历史">
                  <List label="配置历史" divided>
                    {saved.map(item => (
                      <ListRow key={item.revision} title={`${formatDay(item.recordedAt)} ${formatClock(item.recordedAt)}`} meta={configurationText(item)}
                        actions={item.revision !== desired?.revision ? <Button size="sm" variant="text" disabled={busy} onClick={() => void restore(item)}>恢复这一项</Button> : undefined} />
                    ))}
                  </List>
                </DrawerSection>
              )}
            </div>
          </Disclosure>
        )}
      </div>
    </Drawer>
  );
}

/**
 * One of the platform's items, opened from its row: what it does and how it is used, its parts one sentence each where it is
 * several abilities, and — for the research tool set — the tools by group, one sentence each, in the reader's words and never
 * a tool's name. Nothing says that it is always on, how many tools there are or what version it is.
 */
export function InventoryDrawer({ item, groupTitle, tools, onClose }: {
  item: InventoryItem;
  groupTitle: string;
  /** The account's research tool set, shown under the item that is the tool set. */
  tools: Inventory["researchTools"] | null;
  onClose: () => void;
}) {
  return (
    <Drawer title={item.title} description={groupTitle} onClose={onClose}>
      <div className="flex flex-col gap-6">
        <DrawerSection title="它会做什么"><p className="text-ui text-text">{item.does}</p></DrawerSection>
        <DrawerSection title="怎么用"><p className="text-ui text-text">{item.how}</p></DrawerSection>
        {item.parts && item.parts.length > 0 && (
          <DrawerSection title="包括">
            <dl className="flex flex-col gap-3">
              {item.parts.map(part => (
                <div key={part.title} className="flex flex-col gap-0.5">
                  <dt className="text-ui font-semibold text-text">{part.title}</dt>
                  <dd className="text-ui text-text-2">{part.does}</dd>
                </div>
              ))}
            </dl>
          </DrawerSection>
        )}
        {tools && tools.groups.length > 0 && (
          <DrawerSection title="提供的工具">
            <div className="flex flex-col gap-5">
              {tools.groups.map(group => (
                <section key={group.title} aria-label={group.title}>
                  <h4 className="mb-1 text-ui font-semibold text-text">{group.title}</h4>
                  <ul className="list-disc pl-5 text-ui text-text-2">{group.tools.map(sentence => <li key={sentence}>{sentence}</li>)}</ul>
                </section>
              ))}
            </div>
          </DrawerSection>
        )}
      </div>
    </Drawer>
  );
}
