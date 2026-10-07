import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Disclosure } from "@/components/ui/Disclosure";
import { Drawer } from "@/components/ui/Drawer";
import { List, ListRow } from "@/components/ui/ListRow";
import { Menu } from "@/components/ui/Menu";
import { Switch } from "@/components/ui/Switch";
import { Tabs } from "@/components/ui/Tabs";
import { Tag } from "@/components/ui/Tag";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { SkillPackagePanel } from "@/components/skills/SkillPackagePanel";
import { SkillUpdatePanel } from "@/components/skills/SkillUpdatePanel";
import { formatClock, formatDay } from "@/lib/format";
import { productErrorMessage } from "@/lib/productClient";
import { useProjectStore } from "@/lib/projects";
import {
  getPersonalSkill, personalSkillDefaults, personalSkillHistory, personalSkillPortableUrl, personalSkillResourceUrl, personalSkillSupply, projectSkills,
  removePersonalSkill, restorePersonalSkill, savePersonalSkillDefaults, saveProjectSkills, updatePersonalSkill,
  type PersonalSkill, type SkillSelection, type SkillSelectionRecord, type SkillSupplyResult, type SkillVersion, type SkillWrite,
} from "@/lib/skillLibraryClient";
import { DrawerSection } from "./PlatformSkillDrawer";
import { SkillEditor } from "./SkillEditor";

/** The browser downloads a file the way a link would, from a menu item that cannot be one. */
function download(url: string) {
  const link = document.createElement("a");
  link.href = url; link.download = "";
  document.body.appendChild(link); link.click(); link.remove();
}

/**
 * One of the reader's own skills, opened from the list. The page this replaces stacked ten sections; the drawer has two
 * tabs — what the skill says and where it is used (内容), and its earlier states (版本) — with the actions in its menu.
 *
 * A skill is used in a project only once it is selected for it, so 「在项目里使用」 is on this tab as a switch beside the
 * text it applies to, and a skill selected at an older state says so and offers 「更新到最新内容」. States are told apart
 * by the day and time they were saved, not by the ledger's number.
 */
export function PersonalSkillDrawer({ skillId, projectId, onClose, onChanged, onRemoved }: {
  skillId: string; projectId: string; onClose: () => void;
  /** The skill's words changed (an edit, a restore): the list re-reads. */
  onChanged: () => void; onRemoved: () => void;
}) {
  const projectName = useProjectStore(state => state.projects.find(project => project.id === projectId)?.name);
  const alive = useRef(true), generation = useRef(0), working = useRef(false);
  const [skill, setSkill] = useState<PersonalSkill | null>(null), [history, setHistory] = useState<SkillVersion[]>([]);
  const [defaults, setDefaults] = useState<SkillSelectionRecord | null>(null), [selection, setSelection] = useState<SkillSelectionRecord | null>(null), [supply, setSupply] = useState<SkillSupplyResult | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [editing, setEditing] = useState(false), [removing, setRemoving] = useState(false), [compared, setCompared] = useState<SkillVersion | null>(null);
  const [view, setView] = useState<"content" | "versions">("content");
  const load = useCallback(async () => {
    const request = ++generation.current;
    try {
      // The package is a label beside the skill: reading it can fail without the skill failing to open.
      const [record, versions, future, project, packaged] = await Promise.all([getPersonalSkill(skillId), personalSkillHistory(skillId), personalSkillDefaults(), projectSkills(projectId), personalSkillSupply(skillId).catch(() => null)]);
      if (alive.current && request === generation.current) { setSkill(record); setHistory(versions); setDefaults(future); setSelection(project); setSupply(packaged); setError(null); }
    } catch (caught) { if (alive.current && request === generation.current) setError(productErrorMessage(caught)); }
  }, [skillId, projectId]);
  useEffect(() => { const requests = generation; alive.current = true; void load(); return () => { alive.current = false; requests.current++; }; }, [load]);
  const act = async (work: () => Promise<unknown>) => {
    if (working.current) return; working.current = true;
    setBusy(true); setError(null);
    try { await work(); if (alive.current) await load(); }
    catch (caught) { if (alive.current) setError(productErrorMessage(caught)); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  };
  const select = (rows: SkillSelection[], enabled: boolean) => [
    ...rows.filter(item => item.skillId !== skillId), ...(enabled && skill ? [{ skillId, revision: skill.revision }] : []),
  ];
  const save = (value: SkillWrite) => act(async () => { await updatePersonalSkill(skillId, value); if (alive.current) { setEditing(false); onChanged(); } });
  const currentSelection = selection?.payload.skills.find(item => item.skillId === skillId);
  const defaultSelection = defaults?.payload.skills.find(item => item.skillId === skillId);
  const stale = skill && currentSelection && currentSelection.revision !== skill.revision;
  const staleDefault = skill && defaultSelection && defaultSelection.revision !== skill.revision;
  const menu = skill && !editing && (
    <Menu label="更多操作" items={[
      { label: "编辑", icon: Pencil, onSelect: () => { setView("content"); setEditing(true); } },
      { label: "导出历史", icon: Download, onSelect: () => download(personalSkillPortableUrl(skill.id)) },
      "separator",
      { label: "移除", icon: Trash2, destructive: true, onSelect: () => setRemoving(true) },
    ]} />
  );
  return (
    <Drawer title={skill?.payload.title ?? "技能"} description="我的技能" onClose={onClose} actions={menu || undefined}>
      {error && <p role="alert" className="mb-4 text-ui text-error">{error}<Button variant="text" disabled={busy} onClick={() => void load()}>刷新</Button></p>}
      {!skill ? !error && <FilesSkeleton /> : editing ? (
        <SkillEditor key={skill.revision} initial={{ expectedRevision: skill.revision, title: skill.payload.title, description: skill.payload.description, instructions: skill.payload.instructions }} busy={busy} onSave={value => void save(value)} onCancel={() => setEditing(false)} />
      ) : (
        <div className="flex flex-col gap-6">
          <Tabs label="技能内容" items={[{ value: "content", label: "内容" }, { value: "versions", label: "版本" }]} value={view} onChange={setView} />
          {view === "content" ? (
            <div className="flex flex-col gap-6">
              {skill.payload.description && <p className="text-ui text-text-2">{skill.payload.description}</p>}
              <DrawerSection title="使用">
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <Switch showLabel label={`在“${projectName ?? "当前项目"}”里使用`} checked={!!currentSelection} disabled={busy || !selection}
                      onChange={checked => void act(() => saveProjectSkills(projectId, selection!.revision, select(selection!.payload.skills, checked)))} />
                    {stale && <Button size="sm" variant="text" disabled={busy || !selection} onClick={() => void act(() => saveProjectSkills(projectId, selection!.revision, select(selection!.payload.skills, true)))}>更新到最新内容</Button>}
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <Switch showLabel label="新项目默认使用" checked={!!defaultSelection} disabled={busy || !defaults}
                      onChange={checked => void act(() => savePersonalSkillDefaults(defaults!.revision, select(defaults!.payload.skills, checked)))} />
                    {staleDefault && <Button size="sm" variant="text" disabled={busy || !defaults} onClick={() => void act(() => savePersonalSkillDefaults(defaults!.revision, select(defaults!.payload.skills, true)))}>更新到最新内容</Button>}
                  </div>
                </div>
              </DrawerSection>
              <DrawerSection title="全文"><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-card bg-surface-1 p-4 text-ui text-text">{skill.payload.instructions}</pre></DrawerSection>
              {skill.payload.resources.length > 0 && (
                <DrawerSection title="资源"><List label="技能资源" divided>{skill.payload.resources.map(resource => <ListRow key={`${resource.id}:${resource.path}`} title={resource.path} href={personalSkillResourceUrl(skill.id, skill.revision, resource.id)} />)}</List></DrawerSection>
              )}
              <Disclosure summary="详细信息"><SkillPackagePanel view={supply?.package ?? null} availability={supply?.availability ?? null} /></Disclosure>
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              <List label="版本记录" divided>
                {history.filter(version => !version.deletedAt).map(version => {
                  const current = version.revision === skill.revision;
                  return <ListRow key={version.revision} title={`${formatDay(version.recordedAt)} ${formatClock(version.recordedAt)}`} meta={version.payload.title}
                    onOpen={() => setCompared(version)} trailing={current ? <Tag>当前</Tag> : undefined}
                    actions={!current ? <Button size="sm" variant="text" disabled={busy} onClick={() => void act(async () => { await restorePersonalSkill(skillId, skill.revision, version.revision); if (alive.current) onChanged(); })}>恢复此版本</Button> : undefined} />;
                })}
              </List>
              {compared && (
                <section aria-label="版本比较" className="flex flex-col gap-3">
                  <h3 className="text-ui font-medium text-text">{formatDay(compared.recordedAt)} {formatClock(compared.recordedAt)} 与当前内容</h3>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div><p className="mb-2 text-caption text-text-3">这一版</p><pre className="whitespace-pre-wrap break-words rounded-card bg-surface-1 p-4 text-ui text-text">{compared.payload.instructions}</pre></div>
                    <div><p className="mb-2 text-caption text-text-3">当前内容</p><pre className="whitespace-pre-wrap break-words rounded-card bg-surface-1 p-4 text-ui text-text">{skill.payload.instructions}</pre></div>
                  </div>
                  <div><Button variant="text" onClick={() => setCompared(null)}>收起比较</Button></div>
                </section>
              )}
              {supply?.package?.source && ["repository", "upload", "builtin-copy"].includes(supply.package.source.kind) && (
                <Disclosure summary="从来源更新"><SkillUpdatePanel skillId={skillId} revision={skill.revision} source={supply.package.source} onApplied={() => { void load(); onChanged(); }} /></Disclosure>
              )}
            </div>
          )}
        </div>
      )}
      {removing && skill && <ConfirmDialog title="移除技能" body="从个人技能库移除，并停止在新对话中选用。现有版本记录和已生成的文件会保留。" confirmLabel="移除" busy={busy}
        onCancel={() => setRemoving(false)} onConfirm={() => void act(async () => { await removePersonalSkill(skillId, skill.revision); if (alive.current) onRemoved(); })} />}
    </Drawer>
  );
}
