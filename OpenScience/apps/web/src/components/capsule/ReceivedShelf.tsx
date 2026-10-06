import { useState } from "react";
import { useNavigate } from "react-router";
import { declineDelivery, importDelivery, listPendingDeliveries, openDelivery, type PendingDelivery } from "@/lib/capsuleShareClient";
import { CAPSULE_ENTRY_TYPES, CAPSULE_SCAN_REASONS, fromSender } from "@/lib/capsuleText";
import {
  announceMemoryChanged, disableCapsule, enableReceivedCapsule, fetchReceivedCapsules, startCapsuleTrial, type ReceivedCapsule,
} from "@/lib/memoryClient";
import { formatDay } from "@/lib/format";
import { productErrorMessage, type CapsuleRecord } from "@/lib/productClient";
import { useProjectStore } from "@/lib/projects";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { toast } from "@/lib/toast";
import { LoadError } from "@/components/cards/LoadError";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { List, ListRow } from "@/components/ui/ListRow";
import { Menu } from "@/components/ui/Menu";
import { Switch } from "@/components/ui/Switch";
import { useCapsuleData } from "./useCapsuleData";

/** A capsule someone else shared: imported, never mixed into the researcher's own. */
export function isReceived(capsule: CapsuleRecord) {
  return (capsule.payload as { imported?: boolean }).imported === true;
}

/** What a pack brings, counted by kind, in the reader's words. */
function contents(pack: ReceivedCapsule) {
  const parts = CAPSULE_ENTRY_TYPES
    .filter((type) => (pack.counts[type.value] ?? 0) > 0)
    .map((type) => `${type.label} ${pack.counts[type.value]}`);
  const other = Object.entries(pack.counts)
    .filter(([kind]) => !CAPSULE_ENTRY_TYPES.some((type) => type.value === kind))
    .reduce((sum, [, count]) => sum + count, 0);
  if (other > 0) parts.push(`其他 ${other}`);
  return parts.length ? parts.join(" · ") : "没有可用的内容";
}

/**
 * 「待收下的分享」: the deliveries named to this account that it has not answered yet (flywheel F17). A delivery reaches the recipient as an
 * inbox notice, but a recipient who did not come through the inbox had no way to find it, so the shelf lists them: the row opens the page
 * that previews the pack (the card its author signed, every entry, what the automatic scan would drop) and tries it, 「收下」 writes a copy that
 * is not in force — the same import the page does, of exactly the pack that was previewed — and 「不需要」 turns it down. Silent when there is
 * none; the sender is shown by display name only.
 */
function PendingDeliveries() {
  const { data, failed, reload } = useCapsuleData(listPendingDeliveries);
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (delivery: PendingDelivery, operation: () => Promise<void>) => {
    setBusy(delivery.id);
    try {
      await operation();
      announceMemoryChanged();
      reload();
    } catch (error) {
      toast.error(`没有完成：${productErrorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };
  const take = (delivery: PendingDelivery) => act(delivery, async () => {
    // What is taken is what was opened: the digest of the preview the server reads on the recipient's behalf.
    const opened = await openDelivery(delivery.id);
    if (!opened.preview?.canImport) throw new Error("这份分享现在不能收下。");
    const title = delivery.card?.title ?? opened.preview.card?.title ?? "收到的分享";
    await importDelivery(delivery.id, { expectedDigest: opened.preview.archiveSha256, title });
    toast.success(`已收下“${title}”。它还没有生效：在下面的“收到的胶囊”里先试用一次，或直接启用。`);
  });
  const turnDown = (delivery: PendingDelivery) => act(delivery, async () => {
    await declineDelivery(delivery.id);
    toast.success("已拒收这份分享");
  });

  if (failed && data === null) return <LoadError message="暂时读不到待收下的分享。" onRetry={reload} />;
  if (data === null || data.length === 0) return null;
  return (
    <section aria-labelledby="pending-deliveries">
      <h3 id="pending-deliveries" className="text-ui font-semibold text-text">待收下的分享</h3>
      <List label="待收下的分享" className="mt-2">
        {data.map((delivery) => (
          <ListRow
            key={delivery.id}
            title={delivery.card?.title || `${delivery.sender.name} 的分享`}
            to={`/app/memory/delivered/${encodeURIComponent(delivery.id)}`}
            meta={<p>{[
              delivery.card?.author ? fromSender(delivery.card.author) : fromSender(delivery.sender.name),
              delivery.card?.summary,
              formatDay(delivery.createdAt),
              "点开预览，再决定要不要收下",
            ].filter(Boolean).join(" · ")}</p>}
            actions={(
              <>
                <Button variant="secondary" size="sm" disabled={busy !== null} loading={busy === delivery.id} aria-label={`收下“${delivery.card?.title || delivery.sender.name}”`}
                  onClick={() => void take(delivery)}>收下</Button>
                <Button variant="text" size="sm" disabled={busy !== null} aria-label={`不需要“${delivery.card?.title || delivery.sender.name}”`}
                  onClick={() => void turnDown(delivery)}>不需要</Button>
              </>
            )}
          />
        ))}
      </List>
    </section>
  );
}

/** The shelf: what is waiting to be taken in, then what was taken in. Each says nothing while it has nothing to say. */
export function ReceivedShelf() {
  return (
    <>
      <PendingDeliveries />
      <ReceivedPacks />
    </>
  );
}

/**
 * 「收到的胶囊」, inside 分享与导入: what other people shared, trusted as a
 * whole pack — no entry to approve one by one. A row is the pack, what it
 * brings, and a switch that puts it in force account-wide as a reference
 * (methods and standards, never an identity); 「试用一次」 — a conversation of
 * its own that writes nothing into memory — and 「只在…启用」, in force in the
 * project the shell is in and nowhere else (build spec §9.4 #6), are in its
 * 「⋯」. The switch reads "in force here": account-wide, or in this project.
 *
 * Said only when it matters (2026-09-23 inventory §1.7): a publisher this
 * service cannot verify, and what the automatic scan dropped. When it was
 * received, that a signature checked out, and how far the scan got are the
 * back office's.
 */
function ReceivedPacks() {
  const navigate = useNavigate();
  const { data, failed, reload } = useCapsuleData(fetchReceivedCapsules);
  const [busy, setBusy] = useState<string | null>(null);
  const project = useProjectStore((state) => state.projects.find((item) => item.id === state.currentId) ?? null);

  const act = async (key: string, operation: () => Promise<void>) => {
    setBusy(key);
    try {
      await operation();
      announceMemoryChanged();
      reload();
    } catch (error) {
      toast.error(`没有完成：${productErrorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };
  const enable = (pack: ReceivedCapsule) => act(`enable:${pack.id}`, async () => {
    await enableReceivedCapsule(pack.id);
    toast.success(`已启用“${pack.title}”`, {
      action: { label: "撤销", onClick: () => void disableCapsule(pack.id).then(() => { announceMemoryChanged(); reload(); }) },
    });
  });
  const enableHere = (pack: ReceivedCapsule, target: { id: string; name: string }) => act(`enable:${pack.id}`, async () => {
    await enableReceivedCapsule(pack.id, target.id);
    toast.success(`已在“${target.name}”启用“${pack.title}”`, {
      action: { label: "撤销", onClick: () => void disableCapsule(pack.id).then(() => { announceMemoryChanged(); reload(); }) },
    });
  });
  const disable = (pack: ReceivedCapsule) => act(`disable:${pack.id}`, async () => {
    await disableCapsule(pack.id);
    toast.success(`已停用“${pack.title}”`);
  });
  const trial = (pack: ReceivedCapsule) => act(`trial:${pack.id}`, async () => {
    // The conversation's id is chosen here so it can be marked as the trial
    // before the frame opens it; the frame then creates it under that id.
    const intent = newRuntimeUiIntent();
    await startCapsuleTrial(pack.id, intent.sessionId);
    navigate("/app/chat", { state: { runtimeUiIntent: intent } });
  });

  if (failed && data === null) return <LoadError message="暂时读不到收到的胶囊。" onRetry={reload} />;
  // Nothing received, or not read yet: silent. 导入 is right above.
  if (data === null || data.length === 0) return null;
  return (
    <section aria-labelledby="received-capsules">
      <h3 id="received-capsules" className="text-ui font-semibold text-text">收到的胶囊</h3>
      <List label="收到的胶囊" className="mt-2">
        {data.map((pack) => {
          const dropped = pack.scan?.dropped ?? [];
          return (
            <ListRow
              key={pack.id}
              title={pack.title}
              meta={(
                <>
                  {/* Who sent it and what it says it holds, from the card its
                      sender signed; the counts when a pack carries no card. */}
                  {pack.takenDown && <p className="text-danger-strong">
                    {pack.takenDown.by === "operator" ? "已被平台下架并停用" : "已被作者下架并停用"}{pack.takenDown.reason ? `：${pack.takenDown.reason}` : ""}
                  </p>}
                  <p>{[
                    pack.card?.author ? fromSender(pack.card.author) : null,
                    pack.card?.summary || contents(pack),
                    pack.issuerTrust === "verified" ? null : "发布者未验证",
                    pack.enabledIn === "project" && project ? `只在“${project.name}”启用` : null,
                  ].filter(Boolean).join(" · ")}</p>
                  {pack.upgradedAt && pack.card?.changelog && <p>{formatDay(pack.upgradedAt)}更新：{pack.card.changelog}</p>}
                  {pack.methods.length > 0 && <p className="truncate">{pack.methods.join("、")}</p>}
                  {dropped.length > 0 && (
                    <Disclosure summary={`已剔除 ${dropped.length} 条`} summaryClassName="text-caption" className="mt-1">
                      <ul className="space-y-1.5 border-l border-border pl-3">
                        {dropped.map((item) => (
                          <li key={item.id}>
                            <span className="text-text-2">{item.excerpt}</span>
                            <span className="block">
                              {CAPSULE_SCAN_REASONS[item.code] ?? "没有通过自动检查"}
                              {item.source === "model" && item.reason ? `：${item.reason}` : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </Disclosure>
                  )}
                </>
              )}
              trailing={(
                <Switch
                  label={`启用“${pack.title}”`}
                  checked={pack.enabled}
                  disabled={busy !== null || Boolean(pack.takenDown)}
                  onChange={(next) => void (next ? enable(pack) : disable(pack))}
                />
              )}
              menu={pack.takenDown ? undefined : <Menu label="更多" items={[
                { label: "试用一次", disabled: busy !== null, onSelect: () => void trial(pack) },
                ...(project && !pack.enabled
                  ? [{ label: `只在“${project.name}”启用`, disabled: busy !== null, onSelect: () => void enableHere(pack, project) }]
                  : []),
              ]} />}
            />
          );
        })}
      </List>
    </section>
  );
}
