import { useState } from "react";
import { searchMatches } from "@evimed/domain";
import { Button } from "@/components/ui/Button";
import { List, ListRow } from "@/components/ui/ListRow";
import { PendingSkillTransfers } from "./SkillImport";
import type { PendingSkillTransfer, PersonalSkill, PlatformSkill, PlatformSkillList } from "@/lib/skillLibraryClient";
import { SKILL_GROUP_ICON, SKILL_PACK_ICON } from "./extensionCopy";

/** Rows a group shows before 「展开其余 N 个」. */
const SHOWN = 4;

/** One group of rows: its name and count over the rows, four of them until the rest is asked for. */
function Group({ name, count, children }: { name: string; count: number; children: React.ReactNode }) {
  return (
    <section aria-label={name} className="flex flex-col">
      <h2 className="flex items-baseline gap-2 px-2 pb-1 text-caption text-text-3"><span>{name}</span><span className="tabular-nums">{count}</span></h2>
      {children}
    </section>
  );
}

/**
 * The skills page's one list, grouped by use: the reader's own skills first, then the platform's by what they are for. A
 * group shows four rows and offers the rest; a search shows every match, because a match hidden behind 「展开」 is a miss.
 * A row says nothing about where it comes from: the group heading already does (科研分析, 社区, …), and the drawer's
 * description names the source.
 */
export function SkillsList({ personal, platform, query, hasMore, loadingMore, onMore, onOpenPlatform, onOpenPersonal, onResume }: {
  personal: readonly PersonalSkill[];
  platform: PlatformSkillList | null;
  query: string;
  hasMore: boolean; loadingMore: boolean; onMore: () => void;
  onOpenPlatform: (skill: PlatformSkill) => void;
  onOpenPersonal: (skill: PersonalSkill) => void;
  onResume: (entry: PendingSkillTransfer) => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const needle = query.trim().toLowerCase();
  // A retired module name still finds the module's rows until 2027-01-07 (`searchMatches`).
  const matches = (...texts: string[]) => searchMatches(query, texts);
  const mine = personal.filter(skill => matches(skill.payload.title, skill.payload.description));
  const groups = (platform?.groups ?? [])
    .map(name => ({ name, items: (platform?.items ?? []).filter(item => item.group === name && matches(item.title, item.use, item.group)) }))
    .filter(group => group.items.length > 0);
  const nothing = !!needle && mine.length === 0 && groups.length === 0;
  return (
    <div className="flex flex-col gap-6">
      <PendingSkillTransfers onResume={onResume} />
      {(!needle || mine.length > 0) && (
        <Group name="我的技能" count={mine.length}>
          {mine.length > 0 ? (
            <List label="我的技能" divided>
              {mine.map(skill => {
                const Icon = SKILL_GROUP_ICON["我的技能"];
                return <ListRow key={skill.id} leading={<Icon size={20} aria-hidden className="text-text-3" />} title={skill.payload.title} meta={skill.payload.description}
                  onOpen={() => onOpenPersonal(skill)} />;
              })}
            </List>
          ) : <p className="px-2 py-2 text-ui text-text-3">还没有自己的技能，可以新建一个，或导入技能文件。</p>}
          {hasMore && <div className="px-2"><Button variant="text" size="sm" loading={loadingMore} onClick={onMore}>加载更多</Button></div>}
        </Group>
      )}
      {groups.map(group => {
        const unfolded = !!needle || open.has(group.name);
        const rows = unfolded ? group.items : group.items.slice(0, SHOWN);
        const Icon = group.name === platform?.geoGroup ? SKILL_PACK_ICON : SKILL_GROUP_ICON[group.name] ?? SKILL_GROUP_ICON["科研分析"];
        const rest = group.items.length - rows.length;
        return (
          <Group key={group.name} name={group.name} count={group.items.length}>
            <List label={group.name} divided>
              {rows.map(item => (
                <ListRow key={item.id} leading={<Icon size={20} aria-hidden className="text-text-3" />} title={item.title} meta={item.use}
                  onOpen={() => onOpenPlatform(item)} />
              ))}
            </List>
            {!needle && group.items.length > SHOWN && (
              <div className="px-2 pt-1">
                <Button variant="text" size="sm" aria-expanded={unfolded}
                  onClick={() => setOpen(current => { const next = new Set(current); if (next.has(group.name)) next.delete(group.name); else next.add(group.name); return next; })}>
                  {unfolded ? "收起" : `展开其余 ${rest} 个`}
                </Button>
              </div>
            )}
          </Group>
        );
      })}
      {nothing && <p role="status" className="px-2 py-6 text-center text-ui text-text-3">没有找到技能</p>}
    </div>
  );
}
