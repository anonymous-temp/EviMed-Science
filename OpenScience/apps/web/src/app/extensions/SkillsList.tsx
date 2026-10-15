import { useState } from "react";
import { RESEARCH_TOOLS_NAME, searchMatches } from "@evimed/domain";
import { Button } from "@/components/ui/Button";
import { List, ListRow } from "@/components/ui/ListRow";
import { Note } from "@/components/ui/Note";
import { Section } from "@/components/ui/Section";
import { PendingSkillTransfers } from "./SkillImport";
import type { PendingSkillTransfer, PersonalSkill, PlatformSkill, PlatformSkillList } from "@/lib/skillLibraryClient";
import type { CapabilityUi } from "@/lib/researchAgentUi";
import { capabilityIcon } from "@/lib/capabilityIcons";
import { SKILL_GROUP_ICON, SKILL_LOOPX_ICON, SKILL_PACK_ICON } from "./extensionCopy";

/** Rows a group shows before 「展开其余 N 个」. */
const SHOWN = 4;
/** The reader's own skills, the first group. */
export const MINE_GROUP = "我的技能";
/** The group of the curated capability tools: the platform's own, the same ones 科研工具 lists, under the name of the page they live on. It follows the skills. */
export const TOOLS_GROUP = RESEARCH_TOOLS_NAME;

/** The set of open groups with one group toggled. */
const toggled = (current: ReadonlySet<string>, name: string): Set<string> => {
  const next = new Set(current);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return next;
};

/** One group of the list: its name and how many of its rows the search leaves. */
export interface SkillGroup { name: string; count: number }

/**
 * What the skills page lists, group by group, after the search: the reader's own first, the platform's by what they are for in
 * the order the server names them, and the research tools last. The toolbar's chips are this list's own groups with their counts,
 * so a chip is never one the list could not fill, and the tab's count is the sum of what is listed.
 */
export function skillGroups({ personal, platform, tools, query }: {
  personal: readonly PersonalSkill[];
  platform: PlatformSkillList | null;
  tools: readonly CapabilityUi[] | null;
  query: string;
}) {
  // A retired module name still finds the module's rows until 2027-01-07 (`searchMatches`).
  const matches = (...texts: string[]) => searchMatches(query, texts);
  const mine = personal.filter(skill => matches(skill.payload.title, skill.payload.description));
  const platformGroups = (platform?.groups ?? [])
    .map(name => ({ name, items: (platform?.items ?? []).filter(item => item.group === name && matches(item.title, item.use, item.group)) }))
    .filter(group => group.items.length > 0);
  const toolRows = (tools ?? []).filter(tool => matches(tool.title, tool.description));
  const list: SkillGroup[] = [
    ...(mine.length > 0 ? [{ name: MINE_GROUP, count: mine.length }] : []),
    ...platformGroups.map(group => ({ name: group.name, count: group.items.length })),
    ...(toolRows.length > 0 ? [{ name: TOOLS_GROUP, count: toolRows.length }] : []),
  ];
  return { mine, platformGroups, toolRows, list, total: list.reduce((sum, group) => sum + group.count, 0) };
}

/**
 * The skills page's one list, grouped by use: the reader's own skills first, then the platform's by what they are for, then the
 * curated research tools. A group shows four rows and offers the rest; one chosen on the toolbar, and a search, show every row,
 * because a match hidden behind 「展开」 is a miss. A row says nothing about where it comes from: the group heading already says
 * what it is for, and the drawer's description names the source.
 */
export function SkillsList({ personal, platform, tools, query, group, hasMore, loadingMore, onMore, onOpenPlatform, onOpenPersonal, onOpenTool, onResume, onCreate }: {
  personal: readonly PersonalSkill[];
  platform: PlatformSkillList | null;
  /** The curated research tools, already filtered as 科研工具 filters them; null until they are read. */
  tools: readonly CapabilityUi[] | null;
  query: string;
  /** The group the toolbar chose, or null for all of them. */
  group: string | null;
  hasMore: boolean; loadingMore: boolean; onMore: () => void;
  onOpenPlatform: (skill: PlatformSkill) => void;
  onOpenPersonal: (skill: PersonalSkill) => void;
  /** Opens the conversation a tool starts, as its 科研工具 card does. */
  onOpenTool: (tool: CapabilityUi) => void;
  onResume: (entry: PendingSkillTransfer) => void;
  /** Starts a new skill: what an empty library offers. */
  onCreate: () => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const needle = query.trim();
  const { mine, platformGroups, toolRows, total } = skillGroups({ personal, platform, tools, query });
  const shows = (name: string) => group === null || group === name;
  // A chosen group, like a search, is asked for whole.
  const unfolded = (name: string) => !!needle || group !== null || open.has(name);
  const fold = (name: string, count: number) => !needle && group === null && count > SHOWN && (
    <div className="px-2 pt-1">
      <Button variant="text" size="sm" aria-expanded={unfolded(name)} onClick={() => setOpen(current => toggled(current, name))}>
        {unfolded(name) ? "收起" : `展开其余 ${count - SHOWN} 个`}
      </Button>
    </div>
  );
  const emptyLibrary = !needle && group === null && personal.length === 0 && !hasMore;
  return (
    // The sections space themselves (`Section`'s top margin): a gap here would double it.
    <div>
      <PendingSkillTransfers onResume={onResume} />
      {shows(MINE_GROUP) && (mine.length > 0 || emptyLibrary) && (
        <Section title={MINE_GROUP} count={mine.length > 0 ? mine.length : undefined}>
          {mine.length > 0 ? (
            <List label={MINE_GROUP} divided>
              {mine.map(skill => {
                const Icon = SKILL_GROUP_ICON[MINE_GROUP];
                return <ListRow key={skill.id} leading={<Icon size={20} aria-hidden className="text-text-3" />} title={skill.payload.title} meta={skill.payload.description}
                  onOpen={() => onOpenPersonal(skill)} />;
              })}
            </List>
          ) : (
            <Note action={<Button size="sm" variant="secondary" onClick={onCreate}>写第一个技能</Button>}>
              还没有自己的技能：把一件做了几次的事写成技能，对话里会按需用到。也可以导入技能文件。
            </Note>
          )}
          {hasMore && <div className="px-2"><Button variant="text" size="sm" loading={loadingMore} onClick={onMore}>加载更多</Button></div>}
        </Section>
      )}
      {platformGroups.filter(item => shows(item.name)).map(item => {
        const rows = unfolded(item.name) ? item.items : item.items.slice(0, SHOWN);
        const Icon = item.name === platform?.geoGroup ? SKILL_PACK_ICON : item.name === platform?.loopxGroup ? SKILL_LOOPX_ICON : SKILL_GROUP_ICON[item.name] ?? SKILL_GROUP_ICON["科研分析"];
        return (
          <Section key={item.name} title={item.name} count={item.items.length}>
            <List label={item.name} divided>
              {rows.map(skill => (
                <ListRow key={skill.id} leading={<Icon size={20} aria-hidden className="text-text-3" />} title={skill.title} meta={skill.use}
                  onOpen={() => onOpenPlatform(skill)} />
              ))}
            </List>
            {fold(item.name, item.items.length)}
          </Section>
        );
      })}
      {shows(TOOLS_GROUP) && toolRows.length > 0 && (
        <Section title={TOOLS_GROUP} count={toolRows.length}>
          <List label={TOOLS_GROUP} divided>
            {(unfolded(TOOLS_GROUP) ? toolRows : toolRows.slice(0, SHOWN)).map(tool => {
              const Icon = capabilityIcon(tool.id);
              return <ListRow key={tool.id} leading={<Icon size={20} aria-hidden className="text-text-3" />} title={tool.title} meta={tool.description}
                onOpen={() => onOpenTool(tool)} />;
            })}
          </List>
          {fold(TOOLS_GROUP, toolRows.length)}
        </Section>
      )}
      {total === 0 && !!needle && <p role="status" className="px-2 py-6 text-center text-ui text-text-3">没有找到技能</p>}
    </div>
  );
}
