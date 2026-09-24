import { useState } from "react";
import { useNavigate } from "react-router";
import { ShieldCheck, ShieldQuestion } from "lucide-react";
import { CAPSULE_ENTRY_TYPES, CAPSULE_SCAN_MODEL_STATUS, CAPSULE_SCAN_REASONS } from "@/lib/capsuleText";
import { formatDateTime } from "@/lib/format";
import {
  announceMemoryChanged, disableCapsule, enableReceivedCapsule, fetchReceivedCapsules, startCapsuleTrial, type ReceivedCapsule,
} from "@/lib/memoryClient";
import { productErrorMessage, type CapsuleRecord } from "@/lib/productClient";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
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
 * 「收到的胶囊」: what other people shared, trusted as a whole pack (plan
 * §3.3 #4) — no entry to approve one by one. Each pack says who signed it,
 * what it brings, and what its automatic scan dropped and why; then 「试用一次」
 * (a conversation of its own that writes nothing into your memory), 「启用」
 * (in force account-wide, as a reference: methods and standards, never an
 * identity) and 「停用」 (it stops contributing anything). Each one click.
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
    toast.success(`「${pack.title}」已启用：之后的任务会参考它的方法和标准`, {
      action: { label: "撤销", onClick: () => void disableCapsule(pack.id).then(() => { announceMemoryChanged(); reload(); }) },
    });
  });
  const disable = (pack: ReceivedCapsule) => act(`disable:${pack.id}`, async () => {
    await disableCapsule(pack.id);
    toast.success(`「${pack.title}」已停用：它不再参与任何任务`);
  });
  const trial = (pack: ReceivedCapsule) => act(`trial:${pack.id}`, async () => {
    // The conversation's id is chosen here so it can be marked as the trial
    // before the frame opens it; the frame then creates it under that id.
    const intent = newRuntimeUiIntent();
    await startCapsuleTrial(pack.id, intent.sessionId);
    navigate("/app/chat", { state: { runtimeUiIntent: intent } });
  });

  if (failed && data === null) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-ui text-muted">
        <span>暂时读不到收到的胶囊。</span>
        <Button variant="ghost" size="sm" onClick={reload}>重试</Button>
      </div>
    );
  }
  if (data === null) return <p role="status" className="text-ui text-muted">正在读取…</p>;
  // Nothing at all: silent. The way to get one is 「导入胶囊」 in the page's
  // footer, and a permanent empty block above it would say so a second time.
  if (data.length === 0) return null;
  return (
    <section aria-labelledby="received-capsules">
      <h2 id="received-capsules" className="mb-2 text-body font-semibold text-text">收到的胶囊</h2>
      <ul className="divide-y divide-border rounded-card border border-border bg-surface">
      {data.map((pack) => {
        const dropped = pack.scan?.dropped ?? [];
        return (
          <li key={pack.id} className="space-y-2 px-4 py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-ui font-medium text-text">{pack.title}</p>
              <p className="text-caption text-muted">{pack.enabled ? "已启用 · 参考胶囊" : "未启用"}</p>
            </div>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted">
              <span className="inline-flex items-center gap-1 text-text">
                {pack.issuerTrust === "verified"
                  ? <><ShieldCheck size={16} aria-hidden="true" />签名已验证</>
                  : <><ShieldQuestion size={16} aria-hidden="true" />签名有效，但发布者不在本服务上</>}
              </span>
              <span>{contents(pack)}</span>
              {pack.importedAt && <span>收到于 {formatDateTime(pack.importedAt, { month: "short", day: "numeric" })}</span>}
            </p>
            {pack.methods.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-5 text-ui text-text">
                {pack.methods.map((method) => <li key={method}>{method}</li>)}
              </ul>
            )}
            <p className="text-caption text-muted">
              {pack.scan
                ? `自动检查：${CAPSULE_SCAN_MODEL_STATUS[pack.scan.model] ?? "已完成"}${dropped.length ? `，剔除了 ${dropped.length} 条` : "，没有剔除任何内容"}。`
                : `这个胶囊在整包信任之前收下，还有 ${pack.waiting} 条未检查；第一次试用或启用时会自动检查。`}
            </p>
            {dropped.length > 0 && (
              <Disclosure summary={`看看剔除了什么（${dropped.length}）`} summaryClassName="text-caption">
                <ul className="space-y-1.5 border-l border-border pl-3 text-caption text-muted">
                  {dropped.map((item) => (
                    <li key={item.id}>
                      <span className="text-text">{item.excerpt}</span>
                      <span className="block">
                        {CAPSULE_SCAN_REASONS[item.code] ?? "没有通过自动检查"}
                        {item.source === "model" && item.reason ? `：${item.reason}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" loading={busy === `trial:${pack.id}`} disabled={busy !== null} onClick={() => void trial(pack)}>试用一次</Button>
              {pack.enabled
                ? <Button size="sm" variant="ghost" loading={busy === `disable:${pack.id}`} disabled={busy !== null} onClick={() => void disable(pack)}>停用</Button>
                : <Button size="sm" loading={busy === `enable:${pack.id}`} disabled={busy !== null} onClick={() => void enable(pack)}>启用</Button>}
            </div>
          </li>
        );
      })}
      </ul>
    </section>
  );
}
