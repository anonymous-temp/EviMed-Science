import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Note } from "@/components/ui/Note";
import { createWebAgentKey, fetchWebAgentKeys, revokeWebAgentKey, WebApiError, type WebAgentKey, type WebAgentKeyScope } from "@/lib/apiClient";
import { sessionGeneration, subscribeSessionBoundary } from "@/lib/sessionLifecycle";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { Panel, PanelRow } from "@/components/ui/Panel";

const SCOPE_LABELS: Record<WebAgentKeyScope, string> = {
  "memory.read": "读取记忆与做法",
  "memory.history.read": "读取原始对话（需同时允许读取记忆）",
  "memory.write": "提出待确认的记忆",
  "memory.remember": "记住本人明确说过的话",
  "memory.manage": "管理记忆（确认、修改、忘记和恢复）",
  "memory.ingest": "从本人参与的外部对话中提取记忆",
  "learning.signal": "提交使用记忆后的反馈",
  "memory.share": "分享和接收胶囊",
  "memory.observe": "记录处方修改",
  "analysis.read": "读取分析结果",
  "analysis.write": "提交分析任务",
};
const supportedScope = (value: string): value is WebAgentKeyScope => Object.hasOwn(SCOPE_LABELS, value);
const disabledApi = (error: unknown) => error instanceof WebApiError && error.status === 503 && error.code === "agent_memory_disabled";

/** The account's key page: transient create-only credential, cleared with the browser session. */
export function AgentKeysSection() {
  const generation = useSyncExternalStore(subscribeSessionBoundary, sessionGeneration, sessionGeneration);
  return <AgentKeysForm key={generation} />;
}

function AgentKeysForm() {
  const [keys, setKeys] = useState<WebAgentKey[]>([]);
  const [scopes, setScopes] = useState<WebAgentKeyScope[]>([]);
  const [selected, setSelected] = useState<WebAgentKeyScope[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "disabled" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<{ message: string; refresh: boolean } | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ id: string; value: string } | null>(null);
  const [copyMessage, setCopyMessage] = useState("");
  const mounted = useRef(false);
  const credentialField = useRef<HTMLInputElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const owner = useRef(sessionGeneration());
  const current = () => mounted.current && sessionGeneration() === owner.current;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (secret) credentialField.current?.focus(); }, [secret]);
  useEffect(() => { if (creating) nameField.current?.focus(); }, [creating]);
  useEffect(() => {
    let active = true;
    setState("loading"); setError(null);
    void fetchWebAgentKeys().then(result => {
      if (!active) return;
      const offered = result.scopes.filter(supportedScope);
      setKeys(result.keys); setScopes(offered);
      setSelected(offered.includes("memory.read") ? ["memory.read"] : []);
      setState("ready");
    }).catch(reason => {
      if (!active) return;
      setState(disabledApi(reason) ? "disabled" : "error");
    });
    return () => { active = false; };
  }, [attempt]);

  const failed = (reason: unknown, message: string, refresh = false) => {
    if (!current()) return;
    if (disabledApi(reason)) { setState("disabled"); setSecret(null); setKeys([]); }
    else setError({ message, refresh });
  };
  const create = async () => {
    if (busy || !name.trim() || !selected.length) return;
    setBusy("create"); setError(null);
    try {
      const { key, ...record } = await createWebAgentKey({ name: name.trim(), scopes: selected });
      if (!current()) return;
      setKeys(existing => [record, ...existing]);
      setSecret({ id: record.id, value: key }); setCopyMessage(""); setCreating(false); setName("");
    } catch (reason) {
      failed(reason, "创建结果暂时无法确认，请刷新列表后检查；密钥只显示一次，如未保存请撤销后重新创建。", true);
      if (current()) setCreating(false);
    } finally { if (current()) setBusy(null); }
  };
  const revoke = async (key: WebAgentKey) => {
    if (busy) return;
    setBusy(key.id); setError(null);
    try {
      const revoked = await revokeWebAgentKey(key.id);
      if (!current()) return;
      setKeys(existing => existing.map(item => item.id === key.id ? revoked : item));
      setSecret(existing => existing?.id === key.id ? null : existing);
    } catch (reason) { failed(reason, "暂时无法撤销密钥，请重试。"); }
    finally { if (current()) setBusy(null); }
  };
  const copy = async () => {
    if (!secret) return;
    try { await navigator.clipboard.writeText(secret.value); if (current()) setCopyMessage("已复制，请保存到本机文件。"); }
    catch { if (current()) setCopyMessage("无法自动复制，请选中上方密钥手动复制。"); }
  };

  return <Panel title="外部智能体访问（API 密钥）">
    {state === "disabled" ? <PanelRow label="此部署尚未启用外部智能体访问。" />
      : state === "loading" ? <PanelRow label="正在读取 API 密钥" />
        : state === "error" ? <div className="p-4"><InlineAlert onRetry={() => setAttempt(value => value + 1)}>暂时无法读取 API 密钥。</InlineAlert></div>
          : <>
            <PanelRow label="供你在其他智能体中使用" description="DSH 插件只需读取权限；要提出待确认的记忆，再勾选相应权限。" control={
              <Button variant="secondary" disabled={busy !== null || creating || secret !== null || scopes.length === 0} onClick={() => { setCreating(true); setError(null); setSelected(scopes.includes("memory.read") ? ["memory.read"] : []); }}>创建密钥</Button>
            }>
              {creating && <form aria-label="创建 API 密钥" className="grid gap-3" onSubmit={event => { event.preventDefault(); void create(); }}>
                <Input ref={nameField} label="密钥名称" maxLength={120} autoComplete="off" value={name} disabled={busy !== null} onChange={event => setName(event.target.value)} placeholder="例如：本机 DSH" />
                <fieldset disabled={busy !== null}>
                  <legend className="text-ui text-text">允许的操作</legend>
                  {scopes.map(scope => <Checkbox key={scope} label={SCOPE_LABELS[scope]} checked={selected.includes(scope)} onChange={event => setSelected(existing => event.target.checked ? [...existing, scope] : existing.filter(item => item !== scope))} />)}
                </fieldset>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" variant="secondary" loading={busy === "create"} disabled={!name.trim() || selected.length === 0}>创建</Button>
                  <Button variant="secondary" disabled={busy !== null} onClick={() => { setCreating(false); setName(""); }}>取消</Button>
                </div>
              </form>}
              {secret && <div className="grid gap-3">
                <Input ref={credentialField} label="新密钥（仅显示这一次）" value={secret.value} readOnly autoComplete="off" spellCheck={false} onFocus={event => event.target.select()} />
                <Note action={<span className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => void copy()}>复制密钥</Button>
                  <Button variant="secondary" onClick={() => { setSecret(null); setCopyMessage(""); }}>我已保存，关闭</Button>
                </span>}>请复制并保存到本机文件，在插件中将 “apiKeyFile” 指向这个文件；关闭后无法再次查看。</Note>
                {copyMessage && <p role="status" className="text-caption text-text-2">{copyMessage}</p>}
              </div>}
              {error && <div className="mt-3"><InlineAlert onRetry={error.refresh ? () => setAttempt(value => value + 1) : undefined}>{error.message}</InlineAlert></div>}
            </PanelRow>
            {keys.length === 0 && <PanelRow label="尚未创建 API 密钥" />}
            {keys.map(key => <PanelRow key={key.id} label={<span className="break-words">{key.name}</span>} description={<>
              <span className="block">{key.scopes.filter(supportedScope).map(scope => SCOPE_LABELS[scope]).join("、")}</span>
              <span className="block">创建于 {formatDate(key.createdAt)} · {key.lastUsedAt ? `最近使用于 ${formatDate(key.lastUsedAt)}` : "尚未使用"}</span>
            </>} control={key.revokedAt ? "已撤销" : <Button variant="secondary" destructive aria-label={`撤销密钥“${key.name}”`} loading={busy === key.id} disabled={busy !== null} onClick={() => void revoke(key)}>撤销</Button>} />)}
          </>}
  </Panel>;
}
