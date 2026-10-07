import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp } from "lucide-react";
import {
  fetchWebConnectors,
  removeWebConnectorCredential,
  webErrorMessage,
  type WebConnector,
  type WebConnectorCheck,
} from "@/lib/apiClient";
import { announceConnectorsChanged } from "@/lib/connectorAttention";
import { capabilityTitle } from "@/lib/researchAgentUi";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Panel, PanelRow } from "@/components/ui/Panel";
import { Tag } from "@/components/ui/Tag";
import { Tooltip } from "@/components/ui/Tooltip";
import { ConnectorCredentialForm, type SavedConnectorCredential } from "./ConnectorCredentialForm";

const day = (value: string) => new Date(value).toLocaleDateString("zh-CN");

/** Whether a source is served for this researcher now: by the platform, or by their own credential. */
function connected(connector: WebConnector) {
  return connector.source === "deployment" || connector.source === "user";
}

/** A source some capability cannot work without, that nothing serves yet. */
function needed(connector: WebConnector) {
  return !connected(connector) && !connector.keyless && connector.capabilities.length > 0;
}

/**
 * What a source that works without a key says in place of 「X需要」: what a key gives, in the source's own sentence
 * (`unlocks` — for each keyless source the registry's sentence already says it works without one). The fallback is
 * true of every keyless source, whose definition is that the upstream serves without a key, only with a lower ceiling.
 */
const KEYLESS_FALLBACK = "不填也能用，填写自己的密钥可以提高请求上限";

function keylessNote(connector: WebConnector): string {
  return connector.unlocks || KEYLESS_FALLBACK;
}

/** 「孟德尔随机化需要」: the capabilities that depend on it, by their product names. */
function neededBy(connector: WebConnector): string | null {
  const names = connector.capabilities.map((id) => capabilityTitle(id) ?? id);
  return names.length ? `${names.join("、")}需要` : null;
}

/**
 * What the source said when the researcher's own credential was saved, as the
 * words and the tone beside the 已配置: a refusal is the one a reader must see,
 * and the only one with a tone. `unchecked` — a source with no cheap check —
 * says nothing.
 */
function checkTag(check: WebConnectorCheck | null | undefined): { label: string; tone: "neutral" | "warn" } | null {
  if (check === "verified") return { label: "已验证", tone: "neutral" };
  if (check === "rejected") return { label: "数据源拒绝了这个凭据，请核对", tone: "warn" };
  if (check === "unreachable") return { label: "暂时无法验证", tone: "neutral" };
  return null;
}

/** The toast a save ends in: a refusal is said as one, everything else is 已保存. */
function savedMessage(connector: WebConnector, saved: SavedConnectorCredential): { tone: "success" | "error"; text: string } {
  if (saved.check === "rejected") return { tone: "error", text: `已保存，但 ${connector.title} 拒绝了这个凭据，请核对后重新填写` };
  return { tone: "success", text: saved.expiresAt ? `已保存，有效期至 ${day(saved.expiresAt)}` : "已保存" };
}

/**
 * 「数据源」 in 设置 (2026-09-23 plan §5.9, mockup m11): one row per source —
 * its name, whether it is 已配置 or 未配置, and 「设置」, which opens the
 * credential field under the row. The sources nothing depends on are folded
 * under 「另外 N 个可选数据源」.
 *
 * A source with no credential is the researcher's to configure when they use it
 * (2026-10-04), so this page is no longer the only place that asks: the
 * conversation whose run went without one offers the same field
 * (`ConnectorCredentialForm`). A source that works without a key is 可选 —
 * not 未配置, which reads as something missing — with its own line saying what
 * a key of one's own gives, and takes one too: a saved NCBI, openFDA or
 * Semantic Scholar credential is used now, where it used to sit unread. Only a
 * source some capability cannot work without says 未配置 and 「X需要」.
 *
 * Values go in and are never shown again: a row reports a state, never a
 * credential. Beside a researcher's own credential is what the source said when
 * it was saved (已验证, or a warning that it was refused — kept either way).
 * Replacing and removing it are in the row's 「⋯」, and removal asks first. What
 * each source unlocks is the name's tooltip, and the capabilities that depend
 * on it are the row's one line.
 */
export function ConnectorsSection() {
  const [connectors, setConnectors] = useState<WebConnector[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<WebConnector | null>(null);
  const [showOptional, setShowOptional] = useState(false);

  const reload = () => fetchWebConnectors()
    .then((list) => {
      setConnectors(list);
      setError(null);
      // The conversation reads the same list; tell it now rather than on its next mount.
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

  const saved = async (connector: WebConnector, result: SavedConnectorCredential) => {
    setEditing(null);
    const message = savedMessage(connector, result);
    if (message.tone === "error") toast.error(message.text);
    else toast.success(message.text);
    await reload();
  };

  const remove = async (connector: WebConnector) => {
    setBusy(connector.id);
    try {
      await removeWebConnectorCredential(connector.id);
      toast.success(`已移除 ${connector.title} 凭据`);
      await reload();
    } catch (caught) {
      toast.error(`无法移除：${webErrorMessage(caught)}`);
    } finally {
      setBusy(null);
    }
  };

  const row = (connector: WebConnector) => {
    const own = connector.own;
    const expiry = own?.expired && own.expiresAt ? `已于 ${day(own.expiresAt)} 过期`
      : connector.source === "user" && own?.expiresAt ? `有效期至 ${day(own.expiresAt)}`
        : null;
    // A source nothing depends on is 「可选」 and says what a key of one's own gives; only a source some capability cannot work
    // without says 「X需要」. A keyless source never claims a capability needs it, whatever the registry lists beside it.
    const optionalNote = connector.keyless && !connected(connector) ? keylessNote(connector) : null;
    const description = [connector.keyless ? optionalNote : neededBy(connector), expiry].filter(Boolean).join(" · ") || null;
    // The researcher's own credential is theirs to replace or remove whichever
    // source is winning, so they can see and correct it; the deployment's is not.
    const menu: MenuEntry[] = !own ? [] : [
      { label: "更换凭据", onSelect: () => setEditing(connector.id) },
      { label: "移除凭据", destructive: true, disabled: busy === connector.id, onSelect: () => setPendingRemoval(connector) },
    ];
    const open = editing === connector.id;
    const check = connector.source === "user" ? checkTag(own?.check?.state) : null;
    return (
      <PanelRow
        key={connector.id}
        label={connector.unlocks && connector.unlocks !== optionalNote ? <Tooltip content={connector.unlocks}><span>{connector.title}</span></Tooltip> : connector.title}
        description={description}
        control={(
          <>
            {check && <Tag tone={check.tone}>{check.label}</Tag>}
            {connected(connector) ? "已配置" : connector.keyless ? "可选" : "未配置"}
            {!connected(connector) && !open && <Button variant="secondary" onClick={() => setEditing(connector.id)}>设置</Button>}
            {menu.length > 0 && <Menu label={`${connector.title} 凭据`} items={menu} />}
          </>
        )}
      >
        {open && (
          <ConnectorCredentialForm
            connector={connector}
            onSaved={(result) => saved(connector, result)}
            onCancel={() => setEditing(null)}
          />
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
            label={<span role="alert">无法读取数据源：{error}</span>}
            control={<Button variant="text" onClick={() => void reload()}>重试</Button>}
          />
        ) : !connectors ? (
          <PanelRow label={<span className="text-text-3">正在读取</span>} />
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
          body={`移除后，需要 ${pendingRemoval.title} 的研究会跳过这部分，直到你重新填写；已经完成的研究不受影响。`}
          confirmLabel="移除凭据"
          onConfirm={() => { const connector = pendingRemoval; setPendingRemoval(null); void remove(connector); }}
          onCancel={() => setPendingRemoval(null)}
        />,
        document.body,
      )}
    </>
  );
}
