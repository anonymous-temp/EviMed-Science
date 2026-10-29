import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { fetchWebMe, webErrorMessage } from "@/lib/apiClient";
import { readLegacyVcrDrafts, discardLegacyVcrDraft, type LegacyVcrDraft } from "@/lib/vcrLegacyDraft";
import { getVcrStudy } from "@/lib/vcrClient";
import { useProjectStore } from "@/lib/projects";
import { vcrChatPath } from "@/lib/studyLocation";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { List } from "@/components/ui/ListRow";
import { Note } from "@/components/ui/Note";
import { useGeneralResearchDraft } from "./useGeneralResearchDraft";

/** The original browser copy is retained after restoration, until explicitly discarded. */
export function VcrLegacyDraftRecovery() {
  const [account, setAccount] = useState<{ userId: string; tenantId: string } | null>(null);
  const [drafts, setDrafts] = useState<LegacyVcrDraft[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const ask = useGeneralResearchDraft();
  const navigate = useNavigate();
  const select = useProjectStore(state => state.select);
  useEffect(() => {
    let live = true;
    void fetchWebMe().then(me => {
      if (!live || !me?.user?.id) return;
      const identity = { userId: me.user.id, tenantId: me.tenant?.id ?? me.user.tenantId ?? me.user.id };
      setAccount(identity); setDrafts(readLegacyVcrDrafts(identity.userId, identity.tenantId));
    }).catch(() => { /* Recovery never changes storage when account identity cannot be read. */ });
    return () => { live = false; };
  }, []);
  if (!drafts.length || !account) return null;
  const restore = (draft: LegacyVcrDraft) => {
    if (!draft.studyId) { ask(draft.text, undefined, true); return; }
    setBusy(draft.key);
    void getVcrStudy(draft.studyId).then(study => {
      if (!study.conversation.sessionId) throw new Error("The original conversation is not available.");
      return select(study.projectId, () => navigate(vcrChatPath(study.id), { state: { runtimeUiIntent: { kind: "open", projectId: study.projectId, sessionId: study.conversation.sessionId, requestId: crypto.randomUUID(), draft: draft.text, restoreDraft: true } } }));
    }).catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "原研究对话暂时无法读取，草稿已保留，请稍后重试。" }))).finally(() => setBusy(null));
  };
  return <Disclosure summary={`旧版未发送草稿 · ${drafts.length}`}><List label="可恢复的旧草稿" divided>{drafts.map(draft => <li key={draft.key} className="flex flex-col gap-3 py-4">
    <p className="text-ui font-semibold text-text">{draft.name || "未发送的研究问题"}</p>
    {draft.state === "uncertain" && <Note action={null}>之前的提交状态尚未确认，请先核对是否已经开始过研究。恢复文字不会发送或重新提交。</Note>}
    <p className="whitespace-pre-wrap break-words text-ui text-text-2">{draft.text}</p>
    <div className="flex flex-wrap gap-3"><Button variant="secondary" loading={busy === draft.key} disabled={busy !== null} onClick={() => restore(draft)}>恢复到对话输入框</Button><Button variant="text" disabled={busy !== null} onClick={() => { if (discardLegacyVcrDraft(draft, account.userId, account.tenantId)) setDrafts(previous => previous.filter(item => item.key !== draft.key)); }}>丢弃这份旧草稿</Button></div>
  </li>)}</List></Disclosure>;
}
