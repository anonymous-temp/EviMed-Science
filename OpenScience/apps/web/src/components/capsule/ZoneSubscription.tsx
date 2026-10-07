import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { subscribeZone, unsubscribeZone, zoneSubscriptionStatus, type ZoneSubscriptionView } from "@/lib/capsuleShareClient";
import { productErrorMessage } from "@/lib/productClient";
import { useProjectStore } from "@/lib/projects";

/**
 * 「订阅到当前项目」: a small control on an evidence zone's page that makes the zone one project's reference (evidence-flywheel F18,
 * 2026-10-05). The zone's published cards are then recalled in that project as index-only context labelled 「来自证据专区《…》」 — the
 * primary sources are cited, never the card — and nowhere else. Nothing is copied: unsubscribing removes it at once, and a zone that
 * is later unpublished or deleted says so here.
 *
 * Mount it in `EvidenceZonePage.tsx` beside the zone's follow control, with the zone's id: `<ZoneSubscription zoneId={zone.id} />`.
 * It reads the project the shell is in, and asks the server whether the module is on: where it is off the answer is a 404 and the
 * control renders nothing.
 */
export function ZoneSubscription({ zoneId, projectId }: { zoneId: string; projectId?: string }) {
  const current = useProjectStore((state) => state.projects.find((item) => item.id === (projectId ?? state.currentId)) ?? null);
  const [state, setState] = useState<"loading" | "off" | "ready">("loading");
  const [subscription, setSubscription] = useState<ZoneSubscriptionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const projectKey = current?.id ?? null;

  useEffect(() => {
    let active = true;
    setState("loading"); setSubscription(null); setError(null);
    if (!projectKey) { setState("off"); return; }
    void zoneSubscriptionStatus(projectKey, zoneId)
      .then((answer) => { if (active) { setSubscription(answer.subscription); setState("ready"); } })
      .catch((caught) => { if (active) { setState((caught as { code?: string })?.code === "evidence_zone_subscription_not_enabled" ? "off" : "ready"); } });
    return () => { active = false; };
  }, [projectKey, zoneId]);

  if (state === "loading" || state === "off" || !current) return null;
  const act = async (operation: () => Promise<ZoneSubscriptionView | null>) => {
    setBusy(true); setError(null);
    try { const result = await operation(); if (mounted.current) setSubscription(result); }
    catch (caught) { if (mounted.current) setError(productErrorMessage(caught)); }
    finally { if (mounted.current) setBusy(false); }
  };

  return <div className="space-y-1">
    {subscription ? (
      <>
        <p className="text-ui text-text">
          {subscription.status === "active"
            ? `已订阅到“${current.name}”：这个项目的对话会把专区里的卡片当作线索，引用时只引用原始来源。`
            : `已订阅到“${current.name}”，但${subscription.message ?? "专区暂时没有内容。"}`}
        </p>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act(async () => { await unsubscribeZone(current.id, zoneId); return null; })}>取消订阅</Button>
      </>
    ) : (
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act(() => subscribeZone(current.id, zoneId))}>订阅到当前项目</Button>
    )}
    {error && <p role="alert" className="text-caption text-error">{error}</p>}
  </div>;
}
