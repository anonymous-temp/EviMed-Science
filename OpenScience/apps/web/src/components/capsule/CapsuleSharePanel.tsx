import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Disclosure } from "@/components/ui/Disclosure";
import { Input } from "@/components/ui/Input";
import { List, ListRow } from "@/components/ui/ListRow";
import {
  createShareLink, deliverCapsule, listSentDeliveries, listShareLinks, revokeShareLink,
  type DeliveryState, type SentDelivery, type ShareLink,
} from "@/lib/capsuleShareClient";
import { recipientsOf } from "@/lib/capsuleText";
import { formatDateTime } from "@/lib/format";
import { productErrorMessage, type CapsuleCard } from "@/lib/productClient";

export const DELIVERY_STATE_LABELS: Record<DeliveryState, string> = {
  delivered: "已送达", opened: "已打开", imported: "已收下", declined: "已拒收", withdrawn: "已撤回", taken_down: "已下架",
};
const LINK_STATE_LABELS: Record<ShareLink["state"], string> = { active: "有效", expired: "已过期", exhausted: "次数已用完", revoked: "已撤回" };

function when(value: string) {
  return formatDateTime(value, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export { recipientsOf };

/**
 * 「分享给平台里的人」, inside 分享与导入 (evidence-flywheel F17, 2026-10-05): hand the capsule to named accounts of this platform in
 * one step, and make a link only signed-in accounts can open. What travels between people is text only. Nothing here lists accounts:
 * a name is typed in full, and the answer to a delivery is how many arrived, the same whatever kept the others from arriving. `card`
 * is what the sender signs these shares with (the 署名, and a title and summary if they wrote them, of the dialog it sits in);
 * without one the shares are signed as the account always was. `excludeEntryIds` are the entries the sender unticked in the preview.
 * The method pack (a folder of methods for other tools) is not a share between accounts and is the export tab's own.
 */
export function CapsuleSharePanel({ capsuleId, card, excludeEntryIds }: { capsuleId: string | null; card?: CapsuleCard; excludeEntryIds?: string[] }) {
  const [names, setNames] = useState("");
  const [sent, setSent] = useState<SentDelivery[]>([]);
  const [links, setLinks] = useState<ShareLink[]>([]);
  /** The address of the link just made: shown once, because only its hash is kept. */
  const [created, setCreated] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ShareLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let active = true;
    setSent([]); setLinks([]);
    if (!capsuleId) return;
    void Promise.all([listSentDeliveries(capsuleId), listShareLinks(capsuleId)])
      .then(([deliveries, found]) => { if (active) { setSent(Array.isArray(deliveries) ? deliveries : []); setLinks(Array.isArray(found) ? found : []); } })
      .catch(() => { /* the lists are a convenience; sharing itself still says why it cannot run */ });
    return () => { active = false; };
  }, [capsuleId, refresh]);

  const perform = useCallback(async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try { await action(); } catch (caught) { if (mounted.current) setError(productErrorMessage(caught)); }
    finally { if (mounted.current) setBusy(false); }
  }, [busy]);

  const recipients = recipientsOf(names);

  return <section className="space-y-4" aria-label="分享给平台里的人">
    <h3 className="text-ui font-semibold text-text">分享给平台里的人</h3>
    {error && <p role="alert" className="text-ui text-error">{error}</p>}
    {notice && <p role="status" className="text-ui text-text-2">{notice}</p>}
    {revoking && <ConfirmDialog
      title="撤回这个链接？"
      body="撤回后没有人能再用它打开这份胶囊；已经收下的人不受影响。"
      confirmLabel="撤回链接"
      onCancel={() => setRevoking(null)}
      onConfirm={() => {
        const link = revoking; setRevoking(null);
        if (!capsuleId) return;
        void perform(async () => { await revokeShareLink(capsuleId, link.id); setRefresh((value) => value + 1); });
      }}
    />}

    <div className="space-y-2">
      <Input label="发给平台内的账号" placeholder="账号名或账号 ID，完全一致；多个用逗号隔开" value={names} disabled={busy || !capsuleId}
        onChange={(event) => setNames(event.target.value)} maxLength={2000} />
      <Button disabled={busy || !capsuleId || recipients.length === 0} onClick={() => void perform(async () => {
        if (!capsuleId) return;
        const result = await deliverCapsule(capsuleId, { recipients, ...(card ? { card } : {}), ...(excludeEntryIds?.length ? { excludeEntryIds } : {}) });
        if (!mounted.current) return;
        setNames(""); setRefresh((value) => value + 1);
        setNotice(result.delivered === 0 ? "没有送达任何人：名字没有对上，或对方现在不能接收。"
          : result.notDelivered > 0 ? `已发给 ${result.delivered} 位；其余 ${result.notDelivered} 位没有送达（名字没有对上，或对方不能接收）。` : `已发给 ${result.delivered} 位。`);
      })}>发送</Button>
    </div>

    {sent.length > 0 && <Disclosure summary={`发出的分享 ${sent.length} 条`}>
      <List label="发出的分享" divided>
        {sent.map((row) => <ListRow key={row.id} title={row.recipient.name} trailing={`${DELIVERY_STATE_LABELS[row.state] ?? row.state} · ${when(row.createdAt)}`} />)}
      </List>
    </Disclosure>}

    <div className="space-y-2">
      <Button variant="secondary" disabled={busy || !capsuleId} onClick={() => void perform(async () => {
        if (!capsuleId) return;
        const options = { ...(card ? { card } : {}), ...(excludeEntryIds?.length ? { excludeEntryIds } : {}) };
        const made = await (Object.keys(options).length ? createShareLink(capsuleId, options) : createShareLink(capsuleId));
        if (mounted.current) { setCreated(`${window.location.origin}${made.path}`); setRefresh((value) => value + 1); }
      })}>创建分享链接</Button>
      {created && <div className="space-y-1">
        <p className="text-ui text-text">链接只显示这一次，请现在复制：</p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="break-all rounded-sm bg-surface-2 px-2 py-1 text-caption text-text">{created}</code>
          <Button size="sm" variant="secondary" onClick={() => { void navigator.clipboard?.writeText(created).then(() => setNotice("已复制链接")).catch(() => setNotice("没有复制成功，请手动选中复制。")); }}>复制</Button>
        </div>
      </div>}
      {links.length > 0 && <Disclosure summary={`分享链接 ${links.length} 个`}>
        <List label="分享链接" divided>
          {links.map((link) => <ListRow key={link.id}
            title={`${LINK_STATE_LABELS[link.state]} · 已用 ${link.uses} / ${link.maxUses} 次 · 已收下 ${link.importedCount} 人 · ${when(link.expiresAt)} 到期`}
            actions={link.state === "active" ? <Button size="sm" variant="text" destructive disabled={busy} onClick={() => setRevoking(link)}>撤回</Button> : undefined} />)}
        </List>
      </Disclosure>}
    </div>
  </section>;
}
