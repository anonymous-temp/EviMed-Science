import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import {
  fetchWebConnectors,
  removeWebConnectorCredential,
  saveWebConnectorCredential,
  webErrorMessage,
  type WebConnector,
} from "@/lib/apiClient";
import { announceConnectorsChanged } from "@/lib/connectorAttention";
import { capabilityTitle } from "@/lib/researchAgentUi";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Panel, PanelRow } from "@/components/ui/Panel";

const day = (value: string) => new Date(value).toLocaleDateString("zh-CN");

/** Whether a source is served for this researcher now: by the platform, or by their own credential. */
function connected(connector: WebConnector) {
  return connector.source === "deployment" || connector.source === "user";
}

/** A source some capability cannot work without, that nothing serves yet. */
function needed(connector: WebConnector) {
  return !connected(connector) && !connector.keyless && connector.capabilities.length > 0;
}

/** 「孟德尔随机化需要」: the capabilities that depend on it, by their product names. */
function neededBy(connector: WebConnector): string | null {
  const names = connector.capabilities.map((id) => capabilityTitle(id) ?? id);
  return names.length ? `${names.join("、")}需要` : null;
}

/**
 * 「数据源」 in 设置 (2026-09-23 plan §5.9, mockup m11): one row per source —
 * its name, and either its state (已连接 / 无需设置) or 「设置」, which opens
 * the credential field under the row. A source the platform serves, and one
 * that works without a key, shows no field at all; the sources nothing depends
 * on are folded under 「另外 N 个可选数据源」.
 *
 * Values go in and are never shown again: a row reports a state, never a
 * credential. Replacing and removing the researcher's own credential are in
 * the row's 「⋯」, and removal asks first. What each source unlocks is the
 * name's tooltip; the sentences about where credentials are kept went.
 */
export function ConnectorsSection() {
  const [connectors, setConnectors] = useState<WebConnector[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<WebConnector | null>(null);
  const [showOptional, setShowOptional] = useState(false);
  // 「设置」 gives way to the field it opens, so the field takes the focus.
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) field.current?.focus(); }, [editing]);

  const reload = () => fetchWebConnectors()
    .then((list) => {
      setConnectors(list);
      setError(null);
      // The sidebar reads the same list; tell it now rather than on its next mount.
      announceConnectorsChanged();
    })
    .catch((caught) => setError(webErrorMessage(caught)));

  useEffect(() => {
    let active = true;
    fetchWebConnectors()
      .then((list) => { if (active) setConnectors(list); })
      .catch((caught) => { if (active) setError(webErrorMessage(caught)); });
    return () => { active = false; };
  }, []);

  const edit = (connector: WebConnector | null) => { setEditing(connector?.id ?? null); setDraft(""); };

  const save = async (connector: WebConnector) => {
    const value = draft.trim();
    if (!value) return;
    setBusy(connector.id);
    try {
      const saved = await saveWebConnectorCredential(connector.id, value);
      edit(null);
      toast.success(saved.expiresAt ? `已保存，有效期至 ${day(saved.expiresAt)}` : "已保存");
      await reload();
    } catch (caught) {
      toast.error(`保存失败：${webErrorMessage(caught)}`);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (connector: WebConnector) => {
    setBusy(connector.id);
    try {
      await removeWebConnectorCredential(connector.id);
      toast.success(`已移除 ${connector.title} 凭据`);
      await reload();
    } catch (caught) {
      toast.error(`移除失败：${webErrorMessage(caught)}`);
    } finally {
      setBusy(null);
    }
  };

  const row = (connector: WebConnector) => {
    const own = connector.own;
    const description = own?.expired && own.expiresAt ? `已于 ${day(own.expiresAt)} 过期`
      : connector.source === "user" && own?.expiresAt ? `有效期至 ${day(own.expiresAt)}`
        : connected(connector) ? null : neededBy(connector);
    const menu: MenuEntry[] = connector.source === "deployment" || !own ? [] : [
      ...(connector.source === "user" ? [{ label: "更换凭据", onSelect: () => edit(connector) }] : []),
      { label: "移除凭据", destructive: true, disabled: busy === connector.id, onSelect: () => setPendingRemoval(connector) },
    ];
    const open = editing === connector.id;
    const state = connected(connector) ? "已连接" : connector.keyless ? "无需设置" : null;
    return (
      <PanelRow
        key={connector.id}
        label={<span title={connector.unlocks}>{connector.title}</span>}
        description={description}
        control={(state || !open || menu.length > 0) ? (
          <>
            {state ?? (!open && <Button variant="secondary" onClick={() => edit(connector)}>设置</Button>)}
            {menu.length > 0 && <Menu label={`${connector.title} 凭据`} items={menu} />}
          </>
        ) : undefined}
      >
        {open && (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => { event.preventDefault(); void save(connector); }}
          >
            <Input
              ref={field}
              type="password"
              autoComplete="off"
              aria-label={`${connector.title} 凭据`}
              placeholder={connector.kind === "email" ? "联系邮箱" : connector.kind === "jwt" ? "粘贴 JWT 令牌" : "粘贴 API 密钥"}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="w-72"
            />
            <Button type="submit" aria-label={`保存 ${connector.title} 凭据`} loading={busy === connector.id} disabled={!draft.trim()}>保存</Button>
            <Button variant="text" onClick={() => edit(null)}>取消</Button>
            <a
              href={connector.obtainUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`获取 ${connector.title} 凭据`}
              className="inline-flex min-h-6 items-center gap-1 text-caption text-accent hover:underline"
            >
              获取<ExternalLink size={16} aria-hidden="true" />
            </a>
          </form>
        )}
      </PanelRow>
    );
  };

  const list = connectors ?? [];
  const shown = [...list.filter(connected), ...list.filter(needed), ...list.filter((item) => !connected(item) && item.keyless)];
  const optional = list.filter((item) => !connected(item) && !item.keyless && item.capabilities.length === 0);

  return (
    <>
      <Panel title="数据源">
        {error ? (
          <PanelRow
            label={<span role="alert">读取数据源失败：{error}</span>}
            control={<Button variant="text" onClick={() => void reload()}>重试</Button>}
          />
        ) : !connectors ? (
          <PanelRow label={<span className="text-text-3">正在读取…</span>} />
        ) : (
          <>
            {shown.map(row)}
            {optional.length > 0 && (
              <PanelRow
                label={`另外 ${optional.length} 个可选数据源`}
                control={(
                  <Button variant="text" aria-expanded={showOptional} onClick={() => setShowOptional((value) => !value)}>
                    {showOptional ? "收起" : "展开"}
                    {showOptional ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
                  </Button>
                )}
              />
            )}
            {showOptional && optional.map(row)}
          </>
        )}
      </Panel>
      {pendingRemoval && createPortal(
        <ConfirmDialog
          title={`移除你的 ${pendingRemoval.title} 凭据？`}
          body={`移除后，需要 ${pendingRemoval.title} 的研究会报告缺少凭据，直到你重新填写；已经完成的研究不受影响。`}
          confirmLabel="移除凭据"
          onConfirm={() => { const connector = pendingRemoval; setPendingRemoval(null); void remove(connector); }}
          onCancel={() => setPendingRemoval(null)}
        />,
        document.body,
      )}
    </>
  );
}
