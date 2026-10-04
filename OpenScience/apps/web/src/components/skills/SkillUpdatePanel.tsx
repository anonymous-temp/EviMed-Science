import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { List, ListRow } from "@/components/ui/ListRow";
import { productErrorMessage } from "@/lib/productClient";
import {
  applySkillUpdate, previewPersonalSkillRepository, previewSkillUpdate, uploadPersonalSkill,
  type SkillPackageView, type SkillUpdateDecision, type SkillUpdatePlan, type SkillUpdateResult,
} from "@/lib/skillLibraryClient";

const PART_NAME: Record<string, string> = { description: "描述", instructions: "说明正文", whenToUse: "使用时机", invocation: "调用方式", metadata: "技能说明" };
const DECISION: Record<SkillUpdateDecision, string> = {
  unchanged: "无变化", same: "两边一致", "keep-local": "保留你的修改", "take-upstream": "采用新版本的更新", add: "新增", remove: "新版本已移除", conflict: "两边都改了",
};

/**
 * Updating an edited copy of a skill toward a newer version of where it came from.
 *
 * It shows what the update would change before it changes anything: the researcher's
 * own edits stay, the new version's changes come, and a difference both made is named
 * so they can keep theirs or take the new one, part by part. The update is a new
 * revision of this skill; the revision a project selects and the one a running
 * conversation was started with are not touched, and the page says so afterwards.
 */
export function SkillUpdatePanel({ skillId, revision, source, onApplied }: { skillId: string; revision: number; source: SkillPackageView["source"]; onApplied: () => void }) {
  const [repository, setRepository] = useState(source?.repository ?? ""), [commit, setCommit] = useState(""), [subdirectory, setSubdirectory] = useState(source?.path ?? "");
  const [file, setFile] = useState<File | null>(null), [mode, setMode] = useState<"repository" | "file">(source?.kind === "repository" ? "repository" : "file");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [staged, setStaged] = useState<{ resourceId: string; plan: SkillUpdatePlan & { revision: number } } | null>(null);
  const [choices, setChoices] = useState<Record<string, "local" | "upstream">>({}), [done, setDone] = useState<SkillUpdateResult | null>(null);
  const pending = useRef(false);
  const stage = async () => {
    if (pending.current) return;
    if (mode === "repository" && (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(repository.trim()) || !/^[a-f0-9]{40}$/u.test(commit.trim()))) { setError("请填写公开仓库名称和完整的 40 位提交编号。"); return; }
    if (mode === "file" && !file) return;
    pending.current = true; setBusy(true); setError(null); setStaged(null); setDone(null); setChoices({});
    try {
      const resourceId = mode === "repository"
        ? (await previewPersonalSkillRepository({ repository: repository.trim(), commit: commit.trim(), ...(subdirectory.trim() ? { subdirectory: subdirectory.trim() } : {}) })).resourceId
        : (await uploadPersonalSkill(file!)).resourceId;
      setStaged({ resourceId, plan: await previewSkillUpdate(skillId, resourceId) });
    } catch (caught) { setError(productErrorMessage(caught)); }
    finally { pending.current = false; setBusy(false); }
  };
  const apply = async () => {
    if (!staged || pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const result = await applySkillUpdate(skillId, { resourceId: staged.resourceId, expectedRevision: revision, resolutions: choices });
      setDone(result); setStaged(null); onApplied();
    } catch (caught) { setError(productErrorMessage(caught)); }
    finally { pending.current = false; setBusy(false); }
  };
  const label = (entry: SkillUpdatePlan["entries"][number]) => (entry.scope === "part" ? PART_NAME[entry.name] ?? entry.name : entry.name);
  const shown = staged?.plan.entries.filter((entry) => entry.decision !== "unchanged") ?? [];
  return (
    <section aria-label="更新技能" className="flex flex-col gap-3">
      <h2 className="text-ui font-medium text-text">更新到新版本</h2>
      <p className="text-ui text-text-2">先看会改什么：你改过的部分保留，新版本改过的部分带过来，两边都改过的由你决定。更新会生成一个新版本，项目和正在进行的对话仍使用原来选用的版本。</p>
      <div className="flex gap-2">
        <Button type="button" variant={mode === "repository" ? "secondary" : "text"} disabled={busy} onClick={() => { setMode("repository"); setStaged(null); }}>公开仓库</Button>
        <Button type="button" variant={mode === "file" ? "secondary" : "text"} disabled={busy} onClick={() => { setMode("file"); setStaged(null); }}>本地文件</Button>
      </div>
      {mode === "repository" ? <>
        <Input label="公开仓库" placeholder="owner/repository" value={repository} disabled={busy} onChange={(event) => { setRepository(event.target.value); setStaged(null); }} />
        <Input label="新版本的提交" placeholder="完整的 40 位提交编号" value={commit} disabled={busy} onChange={(event) => { setCommit(event.target.value); setStaged(null); }} />
        <Input label="技能子目录" placeholder="可留空" value={subdirectory} disabled={busy} onChange={(event) => { setSubdirectory(event.target.value); setStaged(null); }} />
      </> : <Input label="新版本的技能文件" type="file" accept=".md,.zip,.tgz,.gz" disabled={busy} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setStaged(null); }} />}
      <div><Button variant="secondary" loading={busy && !staged} disabled={busy} onClick={() => void stage()}>查看会改什么</Button></div>
      {error && <p role="alert" className="text-ui text-error">{error}</p>}
      {staged && (
        <section aria-label="更新预览" className="flex flex-col gap-3">
          {!staged.plan.baseKnown && <p className="text-ui text-text-2">这个技能没有记录它当初的版本，所以每一处不同都按“两边都改了”处理，默认保留你的内容。</p>}
          {shown.length === 0 ? <p className="text-ui text-text-2">新版本和你现在的内容没有区别。</p> : (
            <List label="更新内容" divided>
              {shown.map((entry) => (
                <ListRow key={`${entry.scope}:${entry.name}`} title={label(entry)} meta={DECISION[entry.decision]}
                  trailing={entry.decision === "conflict" ? (
                    <select aria-label={`${label(entry)} 的处理`} className="rounded bg-surface-2 px-2 text-ui text-text" value={choices[entry.name] ?? "local"} disabled={busy}
                      onChange={(event) => setChoices({ ...choices, [entry.name]: event.target.value as "local" | "upstream" })}>
                      <option value="local">保留我的</option><option value="upstream">采用新版本的</option>
                    </select>
                  ) : undefined} />
              ))}
            </List>
          )}
          <div className="flex gap-2">
            <Button loading={busy} disabled={busy} onClick={() => void apply()}>{staged.plan.changes + Object.values(choices).filter((value) => value === "upstream").length > 0 ? "更新为新版本" : "记录这个新版本"}</Button>
            <Button variant="text" disabled={busy} onClick={() => setStaged(null)}>取消</Button>
          </div>
        </section>
      )}
      {done && <p role="status" className="text-ui text-text">{done.applied ? `已生成新版本 ${done.skill.revision}；项目和对话仍使用版本 ${done.pinnedRevision}，需要时在上方更新选用。` : "没有需要更新的内容。"}</p>}
    </section>
  );
}
