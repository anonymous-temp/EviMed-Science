import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { Drawer } from "@/components/ui/Drawer";
import { ApplyControl } from "./ApplyControl";
import { Tag } from "@/components/ui/Tag";
import { LoadError } from "@/components/cards/LoadError";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { copyPlatformSkill, readPlatformSkill, projectPlatformSkills, saveProjectPlatformSkills, type PersonalSkill, type PlatformSkill } from "@/lib/skillLibraryClient";
import { productErrorMessage } from "@/lib/productClient";
import { nextDisabled, skillActivationText, skillDisplayName, skillAdapted, skillOrigin, skillPublisher, skillRepositoryUrl } from "./catalogueModel";
import { RepositoryLink } from "./CatalogueView";
import { useActivationPoll } from "./useActivationPoll";
import { useLoad } from "./useLoad";

export function DrawerSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="flex flex-col gap-3"><h3 className="text-ui font-semibold text-text">{title}</h3>{children}</section>;
}

/** Shared upstream files stay immutable; the project chooses native invocation policy. */
export function PlatformSkillDrawer({ skill, projectId, projectName, onClose, onCopied, onSelectionChanged }: {
  skill: PlatformSkill; projectId: string; projectName: string; onClose: () => void;
  onCopied: (created: PersonalSkill) => void; onSelectionChanged: () => void;
}) {
  const read = useCallback(() => readPlatformSkill(skill.id), [skill.id]);
  const { state, reload } = useLoad(read);
  const policy = useLoad(useCallback(() => projectPlatformSkills(projectId), [projectId]));
  const current = policy.state.status === "ready" ? policy.state.data : null;
  const detail = state.status === "ready" ? state.data : null;
  const row = current?.items.find(item => item.id === skill.id);
  const enabled = row?.enabled ?? !current?.payload.disabled.includes(skill.id);
  const source = detail?.provenance ?? skill.provenance;
  const thirdParty = skillOrigin(detail ?? skill) === "third-party";
  const sourceUrl = thirdParty ? skillRepositoryUrl(source?.repository) : null;
  const alive = useRef(true), key = useRef(crypto.randomUUID()), running = useRef(false);
  const [copying, setCopying] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
  const refreshPolicy = policy.reload;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const refreshQuietly = useCallback(() => refreshPolicy(true), [refreshPolicy]);
  useActivationPoll(current?.activation.phase === "waiting", refreshQuietly, current, String(current?.revision ?? 0));
  const save = async (checked: boolean) => {
    if (!current || running.current) return;
    running.current = true; setSaving(true); setError(null);
    try {
      const result = await saveProjectPlatformSkills(projectId, current.revision, nextDisabled(current, skill.id, checked));
      if (alive.current) { policy.replace(result); onSelectionChanged(); }
    } catch (cause) { if (alive.current) { setError(productErrorMessage(cause)); policy.reload(true); } }
    finally { running.current = false; if (alive.current) setSaving(false); }
  };
  const copy = async () => {
    if (running.current) return;
    running.current = true; setCopying(true); setError(null);
    try { const created = await copyPlatformSkill(skill.id, { title: skill.title, idempotencyKey: key.current }); if (alive.current) onCopied(created); }
    catch (cause) { if (alive.current) setError(productErrorMessage(cause)); }
    finally { running.current = false; if (alive.current) setCopying(false); }
  };
  return <Drawer title={skillDisplayName(skill)} description={`${skillPublisher(detail ?? skill)} · ${skill.group}`} onClose={onClose}>
    <div className="flex min-h-full flex-col gap-6">
      <div className="flex flex-col gap-4"><div className="flex flex-wrap items-center gap-2"><Tag>技能</Tag><Tag>{thirdParty ? "第三方" : "EviMed Science"}</Tag>{skillAdapted(detail ?? skill) && <Tag>已改编</Tag>}<RepositoryLink href={sourceUrl} title={skill.title} /></div>
        <p data-prose className="text-body text-text-2">{skill.use}</p></div>
      {!skill.requirement?.required && <div className="rounded-card bg-surface-1 p-4"><DrawerSection title="当前项目">
        {current?.activation.phase !== "not-applicable" && <ApplyControl showLabel label={`在“${projectName}”里使用`} checked={enabled} disabled={!current || saving || copying} onChange={checked => void save(checked)} />}
        <p role="status" className="text-ui text-text-2">{skillActivationText(enabled, current?.activation)}</p>
        {current && ["failed", "rolled-back"].includes(current.activation.phase) && <Button variant="text" disabled={saving} onClick={() => void save(enabled)}>重新应用</Button>}
        {policy.state.status === "error" && <LoadError message={policy.state.message} onRetry={() => policy.reload()} />}
      </DrawerSection></div>}
      {detail?.when && <DrawerSection title="适用场景"><p className="text-ui text-text">{detail.when}</p></DrawerSection>}
      {source && <DrawerSection title="来源">
        <p className="text-ui text-text-2">{skillAdapted(detail ?? skill) ? `${skillPublisher(detail ?? skill)} 发布，平台为在线运行做过改编` : skillPublisher(detail ?? skill)}</p>
      </DrawerSection>}
      {state.status === "loading" && <FilesSkeleton />}
      {state.status === "error" && <LoadError message={state.message} onRetry={() => reload()} />}
      {detail?.instructions && <Disclosure summary="查看技能全文"><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-card bg-surface-1 p-4 text-ui text-text">{detail.instructions}</pre></Disclosure>}
      {error && <p role="alert" className="text-ui text-error">{error}</p>}
      {skill.canCopy && <div className="mt-auto pt-2"><Button variant="secondary" disabled={saving} loading={copying} onClick={() => void copy()}>复制为我的技能</Button></div>}
    </div>
  </Drawer>;
}
