import { useState } from "react";
import { useNavigate } from "react-router";
import { CAPSULE_ENTRY_TYPES, CAPSULE_SCAN_REASONS } from "@/lib/capsuleText";
import {
  announceMemoryChanged, disableCapsule, enableReceivedCapsule, fetchReceivedCapsules, startCapsuleTrial, type ReceivedCapsule,
} from "@/lib/memoryClient";
import { productErrorMessage, type CapsuleRecord } from "@/lib/productClient";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { toast } from "@/lib/toast";
import { LoadError } from "@/components/cards/LoadError";
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
 * 「收到的胶囊」, inside 分享与导入: what other people shared, trusted as a
 * whole pack — no entry to approve one by one. A row is the pack, what it
 * brings, and a switch that puts it in force account-wide as a reference
 * (methods and standards, never an identity); 「试用一次」 — a conversation of
 * its own that writes nothing into memory — is in its 「⋯」.
 *
 * Said only when it matters (2026-09-23 inventory §1.7): a publisher this
 * service cannot verify, and what the automatic scan dropped. When it was
 * received, that a signature checked out, and how far the scan got are the
 * back office's.
 */
export function ReceivedShelf() {
  const navigate = useNavigate();
  const { data, failed, reload } = useCapsuleData(fetchReceivedCapsules);
  const [busy, setBusy] = useState<string | null>(null);

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
    toast.success(`已启用「${pack.title}」`, {
      action: { label: "撤销", onClick: () => void disableCapsule(pack.id).then(() => { announceMemoryChanged(); reload(); }) },
    });
  });
  const disable = (pack: ReceivedCapsule) => act(`disable:${pack.id}`, async () => {
    await disableCapsule(pack.id);
    toast.success(`已停用「${pack.title}」`);
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
                  <p>{contents(pack)}{pack.issuerTrust === "verified" ? "" : " · 发布者未验证"}</p>
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
                  label={`启用「${pack.title}」`}
                  checked={pack.enabled}
                  disabled={busy !== null}
                  onChange={(next) => void (next ? enable(pack) : disable(pack))}
                />
              )}
              menu={<Menu label="更多" items={[{ label: "试用一次", disabled: busy !== null, onSelect: () => void trial(pack) }]} />}
            />
          );
        })}
      </List>
    </section>
  );
}
