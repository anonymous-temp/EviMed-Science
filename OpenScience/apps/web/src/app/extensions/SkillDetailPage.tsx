import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, Pencil, Trash2 } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { List, ListRow } from "@/components/ui/ListRow";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { getWebProjectId } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { productErrorMessage } from "@/lib/productClient";
import { getPersonalSkill, personalSkillDefaults, personalSkillHistory, personalSkillResourceUrl, projectSkills, removePersonalSkill, restorePersonalSkill, savePersonalSkillDefaults, saveProjectSkills, updatePersonalSkill, type PersonalSkill, type SkillSelection, type SkillSelectionRecord, type SkillVersion, type SkillWrite } from "@/lib/skillLibraryClient";
import { SkillEditor } from "./SkillEditor";

export function SkillDetailPage() {
  const { skillId = "" } = useParams();
  useProjectStore(state => state.currentId);
  const projectId = getWebProjectId();
  return <SkillDetail key={`${skillId}:${projectId}`} skillId={skillId} projectId={projectId} />;
}
function SkillDetail({ skillId, projectId }: { skillId: string; projectId: string }) {
  const navigate = useNavigate(), alive = useRef(true), generation = useRef(0), working = useRef(false);
  const [skill, setSkill] = useState<PersonalSkill | null>(null), [history, setHistory] = useState<SkillVersion[]>([]);
  const [defaults, setDefaults] = useState<SkillSelectionRecord | null>(null), [selection, setSelection] = useState<SkillSelectionRecord | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [editing, setEditing] = useState(false), [removing, setRemoving] = useState(false), [compared, setCompared] = useState<SkillVersion | null>(null);
  const load = useCallback(async () => {
    const request = ++generation.current;
    try {
      const [record, versions, future, project] = await Promise.all([getPersonalSkill(skillId), personalSkillHistory(skillId), personalSkillDefaults(), projectSkills(projectId)]);
      if (alive.current && request === generation.current) { setSkill(record); setHistory(versions); setDefaults(future); setSelection(project); setError(null); }
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
  const save = (value: SkillWrite) => act(async () => { await updatePersonalSkill(skillId, value); if (alive.current) setEditing(false); });
  const currentSelection = selection?.payload.skills.find(item => item.skillId === skillId);
  const defaultSelection = defaults?.payload.skills.find(item => item.skillId === skillId);
  return <PageShell title={skill?.payload.title ?? "技能"} actions={<><Button variant="text" onClick={() => navigate("/app/extensions/skills")}><ArrowLeft size={16} aria-hidden />返回</Button>{skill && <Button variant="text" disabled={busy} onClick={() => setEditing(true)}><Pencil size={16} aria-hidden />编辑</Button>}</>}>
    {error && <p role="alert" className="mb-4 text-ui text-error">{error}<Button variant="text" disabled={busy} onClick={() => void load()}>刷新</Button></p>}
    {!skill ? !error && <FilesSkeleton /> : editing ? <SkillEditor key={skill.revision} initial={{ expectedRevision: skill.revision, title: skill.payload.title, description: skill.payload.description, instructions: skill.payload.instructions }} busy={busy} onSave={value => void save(value)} onCancel={() => setEditing(false)} /> : <div className="flex flex-col gap-6">
      <p className="text-ui text-text-2">{skill.payload.description}</p>
      <div className="flex flex-wrap gap-3 text-ui text-text-2"><span>当前版本 {skill.revision}</span>{currentSelection && <span>当前项目选用版本 {currentSelection.revision}</span>}{defaultSelection && <span>新项目默认版本 {defaultSelection.revision}</span>}</div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" disabled={busy || !selection} onClick={() => void act(() => saveProjectSkills(projectId, selection!.revision, select(selection!.payload.skills, !currentSelection)))}>{currentSelection ? "移出当前项目" : "加入当前项目"}</Button>
        <Button variant="text" disabled={busy || !defaults} onClick={() => void act(() => savePersonalSkillDefaults(defaults!.revision, select(defaults!.payload.skills, !defaultSelection)))}>{defaultSelection ? "取消新项目默认选用" : "新项目默认选用"}</Button>
        {currentSelection && currentSelection.revision !== skill.revision && <Button variant="text" disabled={busy || !selection} onClick={() => void act(() => saveProjectSkills(projectId, selection!.revision, select(selection!.payload.skills, true)))}>当前项目更新到版本 {skill.revision}</Button>}
        {defaultSelection && defaultSelection.revision !== skill.revision && <Button variant="text" disabled={busy || !defaults} onClick={() => void act(() => savePersonalSkillDefaults(defaults!.revision, select(defaults!.payload.skills, true)))}>新项目默认更新到版本 {skill.revision}</Button>}
        <Link to="/app/chat" className="text-ui text-accent">前往对话</Link>
      </div>
      <pre className="whitespace-pre-wrap break-words rounded bg-surface-1 p-4 text-ui text-text">{skill.payload.instructions}</pre>
      {skill.payload.resources.length > 0 && <section aria-label="技能资源"><h2 className="mb-2 text-ui font-medium text-text">资源</h2><List divided>{skill.payload.resources.map(resource => <ListRow key={`${resource.id}:${resource.path}`} title={resource.path} href={personalSkillResourceUrl(skill.id, skill.revision, resource.id)} />)}</List></section>}
      <section aria-label="版本记录"><h2 className="mb-2 text-ui font-medium text-text">版本记录</h2><List divided>{history.filter(version => !version.deletedAt).map(version => <ListRow key={version.revision} title={`版本 ${version.revision}`} meta={version.payload.title} onOpen={() => setCompared(version)} actions={version.revision !== skill.revision ? <Button size="sm" variant="text" disabled={busy} onClick={() => void act(() => restorePersonalSkill(skillId, skill.revision, version.revision))}>恢复此版本</Button> : undefined} />)}</List></section>
      {compared && <section aria-label="版本比较"><h2 className="mb-3 text-ui font-medium text-text">版本 {compared.revision} 与当前版本</h2><div className="grid gap-4 md:grid-cols-2"><div><p className="mb-2 text-caption text-text-3">版本 {compared.revision}</p><pre className="whitespace-pre-wrap break-words rounded bg-surface-1 p-4 text-ui text-text">{compared.payload.instructions}</pre></div><div><p className="mb-2 text-caption text-text-3">当前版本</p><pre className="whitespace-pre-wrap break-words rounded bg-surface-1 p-4 text-ui text-text">{skill.payload.instructions}</pre></div></div><Button variant="text" onClick={() => setCompared(null)}>收起比较</Button></section>}
      <div><Button variant="text" destructive disabled={busy} onClick={() => setRemoving(true)}><Trash2 size={16} aria-hidden />移除技能</Button></div>
    </div>}
    {removing && skill && <ConfirmDialog title="移除技能" body="从个人技能库移除，并停止在新对话中选用。现有版本记录和已生成的文件会保留。" confirmLabel="移除" busy={busy} onCancel={() => setRemoving(false)} onConfirm={() => void act(async () => { await removePersonalSkill(skillId, skill.revision); if (alive.current) navigate("/app/extensions/skills"); })} />}
  </PageShell>;
}
