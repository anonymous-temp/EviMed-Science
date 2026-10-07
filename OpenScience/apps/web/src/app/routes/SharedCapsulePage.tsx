import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { LoadError } from "@/components/cards/LoadError";
import { RunsSkeleton } from "@/components/cards/Skeletons";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { Input } from "@/components/ui/Input";
import {
  declineDelivery, importDelivery, importShareLink, openDelivery, openShareLink, type SharedPreview,
} from "@/lib/capsuleShareClient";
import { CAPSULE_SCAN_REASONS, capsuleEntryLabel, fromSender } from "@/lib/capsuleText";
import { announceMemoryChanged, enableReceivedCapsule, startCapsuleTrial } from "@/lib/memoryClient";
import { productErrorMessage, type CapsuleRecord } from "@/lib/productClient";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";

/** Why a delivery that was closed can no longer be taken in, in the recipient's words. */
const CLOSED_TEXT: Record<string, string> = {
  withdrawn: "分享的人已经撤回了这份分享，不能再收下。",
  taken_down: "这份分享已被下架，不能再收下。",
  declined: "你已经拒收了这份分享。",
};

/**
 * 「收到的分享」: where a share link (`/app/memory/shared/<token>`) and a delivery from the inbox (`/app/memory/delivered/<id>`)
 * land (evidence-flywheel F17, 2026-10-05). The pack is read on the recipient's behalf — no file to hold — and is the same flow a
 * file import has: the card its author signed, every entry, what the automatic scan would drop; 「收下」 writes a copy that is not in
 * force; then 「试用一次」 (a conversation of its own that writes nothing into memory) or 「启用」. Only text is ever shared, and what
 * is kept always says whose it is.
 */
export function SharedCapsulePage() {
  const { token, deliveryId } = useParams();
  const navigate = useNavigate();
  const [shared, setShared] = useState<SharedPreview | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [title, setTitle] = useState("收到的分享");
  const [imported, setImported] = useState<CapsuleRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let active = true;
    setShared(null); setFailed(null); setImported(null);
    const load = token ? openShareLink(token) : deliveryId ? openDelivery(deliveryId) : Promise.reject(new Error("no share"));
    void load.then((value) => {
      if (!active) return;
      setShared(value);
      if (value.preview?.card?.title) setTitle(value.preview.card.title);
    }).catch((caught) => { if (active) setFailed(productErrorMessage(caught)); });
    return () => { active = false; };
  }, [token, deliveryId, attempt]);

  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); } catch (caught) { if (mounted.current) setError(productErrorMessage(caught)); }
    finally { if (mounted.current) setBusy(false); }
  };

  const preview = shared?.preview ?? null;
  const closed = shared?.delivery && !preview ? CLOSED_TEXT[shared.delivery.state] ?? "这份分享已经不能收下了。" : null;
  const sender = preview?.card?.author ?? shared?.delivery?.sender.name ?? null;
  const dropped = preview?.scan?.dropped ?? [];

  return (
    <PageShell title="收到的分享">
      {failed && <LoadError message={failed} onRetry={() => setAttempt((value) => value + 1)} />}
      {!failed && shared === null && <RunsSkeleton filter={false} />}
      {closed && <p role="status" className="max-w-measure text-ui text-text">{closed}</p>}
      {preview && (
        <div className="max-w-measure space-y-4">
          <div className="space-y-1">
            {preview.card?.title && <p className="text-ui font-semibold text-text">{preview.card.title}</p>}
            <p className="text-ui text-text-2">{[sender ? fromSender(sender) : null, preview.card?.summary ?? `${preview.entries.length} 条`].filter(Boolean).join(" · ")}</p>
            {shared?.link && <p className="text-caption text-text-3">这个链接还能用 {shared.link.usesLeft} 次。</p>}
            {dropped.length > 0 && <p className="text-caption text-text-3">不会带上 {dropped.length} 条没有通过自动检查的内容。</p>}
          </div>
          <ul className="space-y-1">
            {preview.entries.map((entry) => {
              const drop = dropped.find((item) => item.id === entry.id);
              return <li key={entry.id}>
                <Disclosure summary={`${capsuleEntryLabel(entry.factKind)}${drop ? ` · 不会带上：${CAPSULE_SCAN_REASONS[drop.code] ?? "没有通过自动检查"}` : ""}`}>
                  <p className="max-w-measure whitespace-pre-wrap text-ui text-text">{entry.content}</p>
                </Disclosure>
              </li>;
            })}
          </ul>
          {error && <p role="alert" className="text-ui text-error">{error}</p>}
          {imported ? (
            <div className="space-y-2">
              <p role="status" className="text-ui text-text">已收下“{imported.payload.title}”。它还没有生效：先试用一次，或直接启用。</p>
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy} onClick={() => void perform(async () => {
                  // The conversation's id is chosen here so it can be marked as the trial before the frame opens it.
                  const intent = newRuntimeUiIntent();
                  await startCapsuleTrial(imported.id, intent.sessionId);
                  navigate("/app/chat", { state: { runtimeUiIntent: intent } });
                })}>试用一次</Button>
                <Button variant="secondary" disabled={busy} onClick={() => void perform(async () => {
                  await enableReceivedCapsule(imported.id); announceMemoryChanged(); navigate("/app/memory");
                })}>启用</Button>
                <Button variant="text" disabled={busy} onClick={() => navigate("/app/memory")}>稍后再说</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <Input label="收下后的名称" value={title} disabled={busy} maxLength={150} onChange={(event) => setTitle(event.target.value)} />
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy || !preview.canImport || !title.trim()} onClick={() => void perform(async () => {
                  const input = { expectedDigest: preview.archiveSha256, title: title.trim() };
                  const result = token ? await importShareLink(token, input) : await importDelivery(deliveryId ?? "", input);
                  if (mounted.current) { setImported(result); announceMemoryChanged(); }
                })}>收下</Button>
                {deliveryId && <Button variant="text" disabled={busy} onClick={() => void perform(async () => { await declineDelivery(deliveryId); navigate("/app/inbox"); })}>不需要</Button>}
              </div>
            </div>
          )}
        </div>
      )}
    </PageShell>
  );
}
