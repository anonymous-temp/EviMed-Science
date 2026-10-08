import { Fragment, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  useEvidenceScope,
  useEvidenceRequestId,
} from "@/components/frontier/useEvidenceScope";
import { fetchFrontierItem, type FrontierItem } from "@/lib/frontierClient";
import { evidenceReviewLabel } from "@/components/frontier/EvidenceReading";
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
import { Menu } from "@/components/ui/Menu";
import { Textarea } from "@/components/ui/Input";
import { SearchInput } from "@/components/ui/SearchInput";
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
  const [logOpened, setLogOpened] = useState(false);
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const capture = useEvidenceScope(`${zoneId}:${query}:${refresh}`);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
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
  const publicLink =
    features.publicPages && zone?.state === "published" && zone.visibility === "internet" ? (
      <a
        className="text-accent"
        href={`${features.publicBasePath ?? DEFAULT_PUBLIC_BASE_PATH}/z/${encodeURIComponent(zone.id)}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        公开页
      </a>
    ) : null;
  const metaParts = zone
    ? [
        zone.state === "draft" ? "草稿" : null,
        zone.creator || null,
        zone.createdAt ? evidenceDay(zone.createdAt) : null,
        publicLink,
      ].filter((part) => part !== null)
    : [];
  return (
    <PageShell
      title={zone?.title ?? "证据专区"}
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
            {zone.canEdit && (
              <Menu
                label="更多操作"
                items={[
                  {
                    label: "编辑专区",
                    disabled: editing || adding,
                    onSelect: () => setEditing(true),
                  },
                  {
                    label: zone.state === "published" ? "撤回专区" : "发布专区",
                    disabled: editing || adding || busy,
                    onSelect: () =>
                      void act(async (current) => {
                        const updated = await publishEvidenceZone(
                          zone,
                          zone.state === "published" ? "draft" : "published",
                        );
                        if (current()) setZone(updated);
                      }),
                  },
                ]}
              />
            )}
          </>
        )
      }
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
            <header className="space-y-2">
              {metaParts.length > 0 && (
                <p className="text-caption text-text-3">
                  {metaParts.map((part, index) => (
                    <Fragment key={index}>
                      {index > 0 && " · "}
                      {part}
                    </Fragment>
                  ))}
                </p>
              )}
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
              {(zone.background || zone.experts.length > 0) && (
                <details className="text-ui">
                  <summary className="cursor-pointer text-text-3">
                    领域背景与专家
                  </summary>
                  {zone.background && (
                    <p className="mt-3 max-w-measure whitespace-pre-wrap leading-relaxed text-text-2">
                      {zone.background}
                    </p>
                  )}
                  {zone.experts.length > 0 && (
                    <ul className="mt-3 text-caption text-text-2">
                      {zone.experts.map((expert, index) => (
                        <li key={index}>
                          {expert.name}
                          {expert.institution && ` · ${expert.institution}`}
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              )}
            </header>
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
                {countLine && (
                  <p className="mb-3 text-caption text-text-3">{countLine}</p>
                )}
                {zone.canEdit && (
                  <div className="mb-3">
                    <Button
                      variant="secondary"
                      disabled={editing || adding}
                      onClick={() => setAdding(true)}
                    >
                      添加证据
                    </Button>
                  </div>
                )}
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
                {(items.length > 0 || query) && (
                  <form
                    className="flex gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      setQuery(q.trim());
                    }}
                  >
                    <SearchInput
                      disabled={editing || adding}
                      label="搜索当前专区证据"
                      className="flex-1"
                      value={q}
                      onChange={(event) => setQ(event.target.value)}
                      onClear={() => { setQ(""); setQuery(""); }}
                    />
                    <Button
                      disabled={editing || adding}
                      type="submit"
                      variant="secondary"
                    >
                      搜索
                    </Button>
                  </form>
                )}
                {!items.length ? (
                  <EmptyState
                    title={query ? "没有找到匹配的证据" : "专区暂无证据"}
                  />
                ) : (
                  <ul className="divide-y divide-border">
                    {items.map((card) => {
                      const tally = evidenceVerificationTally(card);
                      const meta = [
                        card.state === "draft" ? "草稿" : null,
                        evidenceNatureLabel(card),
                        tally ? `核验 ${tally.verified}/${tally.checkable}` : null,
                        evidenceReviewLabel(card) === "AI 已评议" ? "AI 已评议" : null,
                      ].filter(Boolean);
                      return (
                        <li key={card.id} className="py-3">
                          <Link
                            to={`/app/frontier/zones/${encodeURIComponent(zone.id)}/evidence/${encodeURIComponent(card.id)}`}
                            className="text-ui font-medium text-text hover:text-accent"
                          >
                            {card.content?.question || card.title}
                          </Link>
                          {(card.content?.answer || card.summary) && (
                            <p className="mt-1 line-clamp-2 max-w-measure text-ui leading-relaxed text-text-2">
                              {card.content?.answer || card.summary}
                            </p>
                          )}
                          {meta.length > 0 && (
                            <p className="mt-1.5 text-caption text-text-3">
                              {meta.join(" · ")}
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {cursor && (
                  <Button
                    variant="secondary"
                    loading={busy}
                    onClick={() =>
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
                  >
                    加载更多
                  </Button>
                )}
              </section>
            )}
            {zone.kind === "official" && zone.state === "published" && (
              <EvidenceCommunityCards zoneId={zone.id} from={{ to: zonePath, label: zone.title }} />
            )}
            {features.upkeep && zone.state === "published" && !bare && (
              <details
                className="text-ui"
                onToggle={(event) => {
                  if (event.currentTarget.open) setLogOpened(true);
                }}
              >
                <summary className="cursor-pointer text-text-3">变更记录</summary>
                {logOpened && (
                  <div className="mt-3">
                    <EvidenceChangeLog zoneId={zone.id} />
                  </div>
                )}
              </details>
            )}
            {zone.canEdit && suggestions.length > 0 && (
              <section>
                <h3 className="mb-2 text-ui font-medium text-text">
                  收到的专区建议
                </h3>
                <ul className="divide-y divide-border">
                  {suggestions.map((suggestion) => (
                    <li key={suggestion.id} className="py-3">
                      <p className="text-caption text-text-3">
                        {suggestion.author} ·{" "}
                        {evidenceDay(suggestion.createdAt)}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap text-ui text-text-2">
                        {suggestion.text}
                      </p>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {zone.canFeedback && (
              <section className="border-t border-border pt-4">
                <Button
                  variant="text"
                  onClick={() => {
                    setFeedbackOpen((value) => !value);
                    setSent(false);
                  }}
                >
                  给专区提建议
                </Button>
                {feedbackOpen && (
                  <form
                    className="mt-3 space-y-3"
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
                )}
              </section>
            )}
          </div>
        )
      )}
    </PageShell>
  );
}
