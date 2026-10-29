import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Layers } from "lucide-react";
import { ZoneSubscription } from "@/components/capsule/ZoneSubscription";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { List, ListRow } from "@/components/ui/ListRow";
import type { MenuEntry } from "@/components/ui/Menu";
import { ShowMore } from "@/components/ui/ShowMore";
import { toast } from "@/lib/toast";
import {
  evidenceErrorMessage,
  fetchEvidenceZoneDetail,
  followEvidenceZone,
  listZoneEvidence,
  publishEvidenceZone,
  setEvidenceZoneVisibility,
  type EvidenceCard,
  type EvidenceZone,
} from "@/lib/evidenceZoneClient";
import { evidenceDay } from "../evidenceDate";
import { evidenceNatureLabel, evidenceVerificationTally } from "../EvidenceCardHeader";
import { FrontierSkeleton } from "../FrontierSkeleton";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; zone: EvidenceZone; cards: EvidenceCard[]; total: number | null; cursor: string | null };

/**
 * The page of a zone that is not a topic zone (2026-10-29): a reader's container of research-result cards (「发布为证据卡」 into a zone of
 * their own) or a 循证 GEO product zone. The topic page has no place for them — no keywords, no counts of items, nothing to edit as a
 * definition — and their address is still handed out (a card's way back, the author's list of zones, a notice), so it opens here: the
 * zone, what it says of itself, and its cards, read through the old zone client and nothing new on the server.
 *
 * What the reader can do is what the zone was for: follow it (it is published), read a card, and for its owner publish or withdraw the
 * zone and choose who may read it (signed-in accounts or anyone). Cards are made where they come from (the result's 「发布为证据卡」) and
 * by the team's interface; this page does not write them.
 */
export function LegacyZoneView({ zoneId, back }: { zoneId: string; back: ReactNode }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    let active = true;
    setState({ kind: "loading" });
    fetchEvidenceZoneDetail(zoneId)
      .then(async ({ zone }) => ({ zone, page: await listZoneEvidence(zone.id, "", null, zone.canEdit ? "owned" : undefined) }))
      .then(
        ({ zone, page }) => { if (active) setState({ kind: "ready", zone, cards: page.items, total: page.total, cursor: page.nextCursor }); },
        (error: unknown) => { if (active) setState({ kind: "error", message: evidenceErrorMessage(error) }); },
      );
    return () => { active = false; };
  }, [zoneId, attempt]);

  const run = useCallback(async (action: (zone: EvidenceZone) => Promise<EvidenceZone>) => {
    if (state.kind !== "ready") return;
    setBusy(true);
    try {
      const updated = await action(state.zone);
      setState((current) => (current.kind === "ready" ? { ...current, zone: updated } : current));
    } catch (error) {
      toast.error(evidenceErrorMessage(error));
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  }, [state]);

  if (state.kind !== "ready") {
    return (
      <PageShell title="证据专区" back={back}>
        {state.kind === "loading" && <FrontierSkeleton />}
        {state.kind === "error" && <LoadError message={state.message} onRetry={() => setAttempt((value) => value + 1)} />}
      </PageShell>
    );
  }

  const { zone, cards, total, cursor } = state;
  const path = `/app/frontier/zones/${encodeURIComponent(zone.id)}`;
  const published = zone.state === "published";
  const open = zone.visibility === "internet";
  const owner: MenuEntry[] = zone.canEdit ? [
    { label: published ? "撤回专区" : "发布专区", disabled: busy, onSelect: () => void run((current) => publishEvidenceZone(current, published ? "draft" : "published")) },
    ...(published
      ? [open
        ? { label: "取消公开", disabled: busy, onSelect: () => void run((current) => setEvidenceZoneVisibility(current, "platform")) }
        : { label: "公开到互联网", disabled: busy, onSelect: () => setConfirmOpen(true) }]
      : []),
  ] : [];
  const meta = [
    zone.state === "draft" ? "草稿" : null,
    zone.creator || null,
    zone.createdAt ? evidenceDay(zone.createdAt) : null,
    published ? (open ? "公开到互联网" : "平台内可见") : null,
  ].filter((part): part is string => part !== null).join(" · ");

  const loadMore = async () => {
    if (!cursor) return;
    setBusy(true);
    try {
      const page = await listZoneEvidence(zone.id, "", cursor, zone.canEdit ? "owned" : undefined);
      setState((current) => (current.kind === "ready" ? { ...current, cards: [...current.cards, ...page.items], cursor: page.nextCursor } : current));
    } catch (error) {
      toast.error(evidenceErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageShell
      title={zone.title}
      documentTitle={`${zone.title} · 证据专区`}
      meta={meta || undefined}
      back={back}
      actionPlan={{
        primary: zone.canFollow ? { id: "follow", label: zone.following ? "已关注" : "关注", loading: busy, onSelect: () => void run((current) => followEvidenceZone(current)) } : undefined,
        overflow: owner,
        overflowLabel: "更多操作",
      }}
    >
      <div className="space-y-6">
        {zone.description && <p data-prose="" className="max-w-measure-body text-ui text-text-2">{zone.description}</p>}
        {published && cards.length > 0 && <ZoneSubscription zoneId={zone.id} />}
        {cards.length === 0 ? (
          <EmptyState icon={Layers}
            title={zone.canEdit ? "这个专区还没有证据卡片。在研究结果上选“发布为证据卡”，卡片会放进来。" : "这个专区还没有证据卡片"} />
        ) : (
          <section aria-label="专区证据">
            <List divided label="专区证据">
              {cards.map((card) => {
                const tally = evidenceVerificationTally(card);
                const facts = [
                  card.state === "draft" ? "草稿" : null,
                  evidenceNatureLabel(card),
                  tally ? `引文已核对 ${tally.verified}/${tally.checkable}` : null,
                ].filter(Boolean);
                // The line under the question is the card's own summary (what the server wrote for lists), not the answer.
                const line = card.summary || card.content?.answer;
                return (
                  <ListRow
                    key={card.id}
                    to={`${path}/evidence/${encodeURIComponent(card.id)}`}
                    state={{ evidenceFrom: { to: path, label: zone.title } }}
                    title={card.content?.question || card.title}
                    meta={line || facts.length > 0 ? (
                      <>
                        {line && <span className="line-clamp-2 max-w-measure text-ui leading-relaxed text-text-2">{line}</span>}
                        {facts.length > 0 && <span className={line ? "mt-1.5 block" : "block"}>{facts.join(" · ")}</span>}
                      </>
                    ) : undefined}
                  />
                );
              })}
            </List>
            {cursor && (
              <ShowMore remaining={typeof total === "number" ? Math.max(1, total - cards.length) : null} unit="条" loading={busy} onMore={() => void loadMore()} />
            )}
          </section>
        )}
      </div>
      {confirmOpen && (
        <ConfirmDialog
          title="公开到互联网"
          body="公开后，任何人都能在不登录的情况下看到这个专区和其中已发布的证据。随时可以取消公开。"
          confirmLabel="公开"
          tone="primary"
          busy={busy}
          onConfirm={() => void run((current) => setEvidenceZoneVisibility(current, "internet"))}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </PageShell>
  );
}
