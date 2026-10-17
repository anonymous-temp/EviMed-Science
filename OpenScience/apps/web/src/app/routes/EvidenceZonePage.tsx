import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  useEvidenceScope,
  useEvidenceRequestId,
} from "@/components/frontier/useEvidenceScope";
import { fetchFrontierItem, type FrontierItem } from "@/lib/frontierClient";
import { evidenceDay } from "@/components/frontier/evidenceDate";
import {
  evidenceNatureLabel,
  evidenceVerificationTally,
} from "@/components/frontier/EvidenceCardHeader";
import { ZoneEditor, CardEditor } from "@/components/frontier/EvidenceEditors";
import { EvidenceMaintenance } from "@/components/frontier/EvidenceMaintenance";
import { EvidenceVisibility } from "@/components/frontier/EvidenceVisibility";
import { EvidenceChangeLog } from "@/components/frontier/EvidenceChangeLog";
import { EvidenceCommunityCards } from "@/components/frontier/EvidenceCommunityCards";
import { ZoneSubscription } from "@/components/capsule/ZoneSubscription";
import { useEvidenceFeatures } from "@/components/frontier/useEvidenceFeatures";
import { DEFAULT_PUBLIC_BASE_PATH } from "@/lib/evidenceUpkeepClient";
import { PageShell } from "@/components/layout/PageShell";
import { FrontierBack } from "@/components/frontier/FrontierBack";
import { FrontierSkeleton } from "@/components/frontier/FrontierSkeleton";
import { EmptyState } from "@/components/cards/EmptyState";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { List, ListRow } from "@/components/ui/ListRow";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Textarea } from "@/components/ui/Input";
import { ShowMore } from "@/components/ui/ShowMore";
import {
  fetchEvidenceZoneDetail,
  publishEvidenceZone,
  listZoneEvidence,
  followEvidenceZone,
  submitEvidenceZoneFeedback,
  prepareEvidenceResearch,
  type EvidenceZone,
  type EvidenceCard,
} from "@/lib/evidenceZoneClient";
import { evidenceErrorMessage } from "@/lib/evidenceZoneClient";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";

export function EvidenceZonePage() {
  const { zoneId = "" } = useParams();
  return <EvidenceZoneContent key={zoneId} zoneId={zoneId} />;
}
function EvidenceZoneContent({ zoneId }: { zoneId: string }) {
  const feedbackRequestId = useEvidenceRequestId();
  const features = useEvidenceFeatures();
  const [params] = useSearchParams();
  const fromItem = params.get("fromItem");
  const [sourceItem, setSourceItem] = useState<FrontierItem | null>(null);
  const navigate = useNavigate();
  const [suggestions, setSuggestions] = useState<
    Array<{ id: string; author: string; text: string; createdAt: string }>
  >([]);
  const [zone, setZone] = useState<EvidenceZone | null>(null);
  const [items, setItems] = useState<EvidenceCard[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  // The box commits to the query a moment after typing stops — the same live search as the zone list — never in the middle of an
  // IME composition (pinyin is not a query); Enter commits at once. There is no 「搜索」 button (R19, audit D C5).
  const composing = useRef(false);
  const [composed, setComposed] = useState(0);
  useEffect(() => {
    const text = q.trim();
    if (composing.current || text === query) return;
    const timer = setTimeout(() => setQuery(text), 300);
    return () => clearTimeout(timer);
  }, [q, composed, query]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const capture = useEvidenceScope(`${zoneId}:${query}:${refresh}`);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  // What the header's 「⋯」 opens: the zone's background and experts, its change log, and a suggestion to its owner.
  const [panel, setPanel] = useState<"background" | "log" | "suggest" | null>(null);
  const [feedback, setFeedback] = useState("");
  const [sent, setSent] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setBusy(false);
    setError(null);
    setItems([]);
    setCursor(null);
    setZone(null);
    fetchEvidenceZoneDetail(zoneId)
      .then(async (detail) => ({
        detail,
        page: await listZoneEvidence(
          zoneId,
          query,
          null,
          detail.zone.canEdit ? "owned" : undefined,
        ),
      }))
      .then(({ detail, page }) => {
        if (active) {
          setZone(detail.zone);
          setSuggestions(detail.feedback || []);
          setItems(page.items);
          setTotal(page.total);
          setCursor(page.nextCursor);
        }
      })
      .catch((reason) => {
        if (active) setError(evidenceErrorMessage(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [zoneId, query, refresh]);
  useEffect(() => {
    let active = true;
    setSourceItem(null);
    if (fromItem && zone?.canEdit)
      fetchFrontierItem(fromItem)
        .then((item) => {
          if (active) {
            setSourceItem(item);
            setAdding(true);
          }
        })
        .catch((reason) => {
          if (active) setError(evidenceErrorMessage(reason));
        });
    return () => {
      active = false;
    };
  }, [fromItem, zone?.canEdit]);
  const act = async (action: (current: () => boolean) => Promise<void>) => {
    const current = capture();
    setBusy(true);
    setError(null);
    try {
      if (current()) await action(current);
    } catch (reason) {
      if (current()) setError(evidenceErrorMessage(reason));
    } finally {
      if (current()) setBusy(false);
    }
  };
  // A zone nobody has written a card for yet offers a reader nothing to search, count or ask: one sentence and the way to be told.
  const bare =
    !!zone &&
    zone.state === "published" &&
    zone.evidenceCount === 0 &&
    !query &&
    !zone.canEdit;
  const askable = !!zone && zone.canResearch && (zone.evidenceCount ?? 1) > 0;
  const countLine = !zone
    ? null
    : query
      ? total === null
        ? null
        : `${total} 条匹配证据`
      : zone.canEdit && total !== null && zone.evidenceCount !== null && total > zone.evidenceCount
        ? `${zone.evidenceCount} 条已发布，含草稿共 ${total} 条`
        : (zone.evidenceCount ?? total) === null
          ? null
          : `${zone.evidenceCount ?? total} 条证据`;
  const zonePath = zone ? `/app/frontier/zones/${encodeURIComponent(zone.id)}` : "";
  const bareNote = !zone
    ? ""
    : zone.canFollow && !zone.following
      ? "这个专区还没有证据。关注后，有新证据会出现在“前沿动态”的“关注”里。"
      : zone.following
        ? "这个专区还没有证据。有新证据时，会出现在“前沿动态”的“关注”里。"
        : "这个专区还没有证据。";
  const publicUrl =
    features.publicPages && zone?.state === "published" && zone.visibility === "internet"
      ? `${features.publicBasePath ?? DEFAULT_PUBLIC_BASE_PATH}/z/${encodeURIComponent(zone.id)}`
      : null;
  const metaParts = zone
    ? [
        zone.state === "draft" ? "草稿" : null,
        zone.creator || null,
        zone.createdAt ? evidenceDay(zone.createdAt) : null,
      ].filter((part) => part !== null)
    : [];
  // The header's 「⋯」: what a reader may do about the zone besides following and asking it, and, for its owner, to edit and publish it.
  const forReaders: MenuEntry[] = zone ? [
    ...(publicUrl ? [{ label: "公开页", onSelect: () => { window.open(publicUrl, "_blank", "noopener,noreferrer"); } }] : []),
    ...(zone.background || zone.experts.length > 0 ? [{ label: "领域背景与专家", onSelect: () => setPanel("background") }] : []),
    ...(features.upkeep && zone.state === "published" && !bare ? [{ label: "变更记录", onSelect: () => setPanel("log") }] : []),
    ...(zone.canFeedback ? [{ label: "给专区提建议", onSelect: () => { setSent(false); setPanel("suggest"); } }] : []),
  ] : [];
  const forOwner: MenuEntry[] = zone?.canEdit ? [
    { label: "编辑专区", disabled: editing || adding, onSelect: () => setEditing(true) },
    {
      label: zone.state === "published" ? "撤回专区" : "发布专区",
      disabled: editing || adding || busy,
      onSelect: () =>
        void act(async (current) => {
          const updated = await publishEvidenceZone(zone, zone.state === "published" ? "draft" : "published");
          if (current()) setZone(updated);
        }),
    },
  ] : [];
  const more: MenuEntry[] = [...forReaders, ...(forReaders.length > 0 && forOwner.length > 0 ? ["separator" as const] : []), ...forOwner];
  const searchable = !!zone && !bare && (items.length > 0 || !!query);
  return (
    <PageShell
      title={zone?.title ?? "证据专区"}
      meta={metaParts.length > 0 ? metaParts.join(" · ") : undefined}
      back={
        <FrontierBack
          trail={[
            {
              label: "证据专区",
              to: `/app/frontier/zones${fromItem ? `?fromItem=${encodeURIComponent(fromItem)}` : ""}`,
            },
          ]}
        />
      }
      actions={
        zone && (
          <>
            {zone.canFollow && (
              <Button
                variant="secondary"
                loading={busy}
                onClick={() =>
                  void act(async (current) => {
                    const updated = await followEvidenceZone(zone);
                    if (current()) setZone(updated);
                  })
                }
              >
                {zone.following ? "取消关注" : "关注"}
              </Button>
            )}
            {askable && (
              <Button
                loading={busy}
                onClick={() =>
                  void act(async () => {
                    const current = capture();
                    const prepared = await prepareEvidenceResearch(zone);
                    if (!current()) return;
                    navigate("/app/chat", {
                      state: {
                        runtimeUiIntent: newRuntimeUiIntent(prepared.draft),
                      },
                    });
                  })
                }
              >
                问这个专区
              </Button>
            )}
            {more.length > 0 && <Menu label="更多操作" items={more} />}
          </>
        )
      }
      // The list's controls, over the list: a live search and the count after it, and the owner's way to add to it.
      toolbar={zone && !bare ? {
        label: "专区证据筛选",
        search: searchable ? {
          label: "搜索当前专区证据",
          value: q,
          maxLength: 200,
          onChange: setQ,
          onClear: () => { setQ(""); setQuery(""); },
          inputProps: {
            disabled: editing || adding,
            onKeyDown: (event) => { if (event.key === "Enter") { event.preventDefault(); setQuery(q.trim()); } },
            onCompositionStart: () => { composing.current = true; },
            onCompositionEnd: (event) => { composing.current = false; setQ(event.currentTarget.value); setComposed((value) => value + 1); },
          },
        } : undefined,
        summary: countLine ?? undefined,
        actions: zone.canEdit ? (
          <Button variant="secondary" size="sm" disabled={editing || adding} onClick={() => setAdding(true)}>添加证据</Button>
        ) : undefined,
      } : undefined}
    >
      {error && (
        <EmptyState
          title={error}
          action={
            <Button
              variant="secondary"
              onClick={() => setRefresh((value) => value + 1)}
            >
              重试
            </Button>
          }
        />
      )}
      {loading && !zone ? (
        <FrontierSkeleton />
      ) : (
        zone && (
          <div className="space-y-6">
            {editing && (
              <ZoneEditor
                zone={zone}
                onCancel={() => setEditing(false)}
                onSaved={(saved) => {
                  setZone(saved);
                  setEditing(false);
                }}
              />
            )}
            {(zone.description || (zone.state === "published" && !bare)) && (
              <header className="space-y-2">
                {zone.description && (
                  <p className="max-w-measure text-ui text-text-2">
                    {zone.description}
                  </p>
                )}
                {zone.state === "published" && !bare && (
                  <div className="pt-1">
                    <ZoneSubscription zoneId={zone.id} />
                  </div>
                )}
              </header>
            )}
            {zone.canEdit && <EvidenceVisibility zone={zone} onChanged={setZone} />}
            {zone.canEdit && (
              <EvidenceMaintenance
                key={zone.id}
                zone={zone}
                onUpdated={() => setRefresh((value) => value + 1)}
              />
            )}
            {bare ? (
              <EmptyState
                title={bareNote}
                action={
                  features.publicPages && zone.kind === "official" ? (
                    <Link
                      className="text-ui text-accent"
                      to={`/app/frontier/zones?request=${encodeURIComponent(zone.title)}`}
                    >
                      申请这个主题的选题 ›
                    </Link>
                  ) : undefined
                }
              />
            ) : (
              <section aria-label="专区证据">
                {adding && zone.canEdit && (
                  <div className="mb-4">
                    <CardEditor
                      key={`${zone.id}:${sourceItem?.id || "new"}`}
                      zoneId={zone.id}
                      sourceItem={sourceItem || undefined}
                      onCancel={() => setAdding(false)}
                      onSaved={(card) => {
                        setAdding(false);
                        navigate(
                          `/app/frontier/zones/${encodeURIComponent(zone.id)}/evidence/${encodeURIComponent(card.id)}`,
                        );
                      }}
                    />
                  </div>
                )}
                {!items.length ? (
                  <EmptyState
                    title={query ? "没有找到匹配的证据" : "专区暂无证据"}
                  />
                ) : (
                  <List divided label="专区证据">
                    {items.map((card) => {
                      const tally = evidenceVerificationTally(card);
                      const meta = [
                        card.state === "draft" ? "草稿" : null,
                        evidenceNatureLabel(card),
                        tally ? `引文已核对 ${tally.verified}/${tally.checkable}` : null,
                      ].filter(Boolean);
                      // The line under the question is the card's own summary (what the server wrote for lists), not the answer: a
                      // card that has no headline claim answers with one neutral sentence, the same on every such card.
                      const line = card.summary || card.content?.answer;
                      return (
                        <ListRow
                          key={card.id}
                          to={`/app/frontier/zones/${encodeURIComponent(zone.id)}/evidence/${encodeURIComponent(card.id)}`}
                          title={card.content?.question || card.title}
                          meta={(line || meta.length > 0) ? (
                            <>
                              {line && <span className="line-clamp-2 max-w-measure text-ui leading-relaxed text-text-2">{line}</span>}
                              {meta.length > 0 && <span className={line ? "mt-1.5 block" : "block"}>{meta.join(" · ")}</span>}
                            </>
                          ) : undefined}
                        />
                      );
                    })}
                  </List>
                )}
                {cursor && (
                  <ShowMore
                    remaining={typeof total === "number" ? Math.max(1, total - items.length) : null}
                    unit="条"
                    loading={busy}
                    onMore={() =>
                      void act(async (current) => {
                        const page = await listZoneEvidence(
                          zone.id,
                          query,
                          cursor,
                          zone.canEdit ? "owned" : undefined,
                        );
                        if (current()) {
                          setItems((previous) => [...previous, ...page.items]);
                          setCursor(page.nextCursor);
                        }
                      })
                    }
                  />
                )}
              </section>
            )}
            {zone.kind === "official" && zone.state === "published" && (
              <EvidenceCommunityCards zoneId={zone.id} from={{ to: zonePath, label: zone.title }} />
            )}
            {zone.canEdit && suggestions.length > 0 && (
              <section>
                <h2 className="mb-2 text-section font-semibold text-text">收到的专区建议</h2>
                <List divided label="收到的专区建议">
                  {suggestions.map((suggestion) => (
                    <ListRow
                      key={suggestion.id}
                      title={<span className="whitespace-pre-wrap font-normal text-text-2">{suggestion.text}</span>}
                      meta={`${suggestion.author} · ${evidenceDay(suggestion.createdAt)}`}
                    />
                  ))}
                </List>
              </section>
            )}
          </div>
        )
      )}
      {zone && panel === "background" && (
        <Drawer title="领域背景与专家" onClose={() => setPanel(null)}>
          <div className="space-y-4 text-ui text-text-2">
            {zone.background && <p className="whitespace-pre-wrap leading-relaxed">{zone.background}</p>}
            {zone.experts.length > 0 && (
              <ul className="text-caption">
                {zone.experts.map((expert, index) => (
                  <li key={index}>
                    {expert.name}
                    {expert.institution && ` · ${expert.institution}`}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Drawer>
      )}
      {zone && panel === "log" && (
        <Drawer title="变更记录" onClose={() => setPanel(null)}>
          <EvidenceChangeLog zoneId={zone.id} />
        </Drawer>
      )}
      {zone && panel === "suggest" && (
        <Drawer title="给专区提建议" onClose={() => setPanel(null)}>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void act(async (current) => {
                await submitEvidenceZoneFeedback(
                  zone,
                  feedback.trim(),
                  feedbackRequestId(`${zone.id}:${feedback.trim()}`),
                );
                if (current()) {
                  setFeedback("");
                  setSent(true);
                }
              });
            }}
          >
            <Textarea
              label="专区建议"
              maxLength={4000}
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
            />
            <Button
              type="submit"
              variant="secondary"
              loading={busy}
              disabled={!feedback.trim()}
            >
              提交建议
            </Button>
            {sent && (
              <p role="status" className="text-caption text-text-2">
                建议已提交
              </p>
            )}
          </form>
        </Drawer>
      )}
    </PageShell>
  );
}
