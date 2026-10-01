import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  useEvidenceScope,
  useEvidenceRequestId,
} from "@/components/frontier/useEvidenceScope";
import { fetchFrontierItem, type FrontierItem } from "@/lib/frontierClient";
import { evidenceDate } from "@/components/frontier/EvidenceReading";
import { ZoneEditor, CardEditor } from "@/components/frontier/EvidenceEditors";
import { PageShell } from "@/components/layout/PageShell";
import { FrontierNavigation } from "@/components/frontier/FrontierNavigation";
import { FrontierSkeleton } from "@/components/frontier/FrontierSkeleton";
import { EmptyState } from "@/components/cards/EmptyState";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
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
  return (
    <PageShell title="前沿动态">
      <FrontierNavigation active="zones" />
      <Link
        to="/app/frontier/zones"
        className="mt-4 inline-block text-caption text-accent"
      >
        返回证据专区
      </Link>
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
          <div className="mt-4 space-y-6">
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
            <header>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-section font-semibold text-text">
                  {zone.title}
                </h2>
                <div className="flex flex-wrap gap-2">
                  {zone.canEdit && (
                    <>
                      <Button
                        variant="text"
                        disabled={editing || adding}
                        onClick={() => setEditing(true)}
                      >
                        编辑专区
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={editing || adding}
                        loading={busy}
                        onClick={() =>
                          void act(async (current) => {
                            const updated = await publishEvidenceZone(
                              zone,
                              zone.state === "published"
                                ? "draft"
                                : "published",
                            );
                            if (current()) setZone(updated);
                          })
                        }
                      >
                        {zone.state === "published" ? "撤回专区" : "发布专区"}
                      </Button>
                    </>
                  )}
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
                  {zone.canResearch && (
                    <Button
                      loading={busy}
                      onClick={() =>
                        void act(async () => {
                          const current = capture();
                          const prepared = await prepareEvidenceResearch(zone);
                          if (!current()) return;
                          navigate("/app/chat", {
                            state: {
                              runtimeUiIntent: newRuntimeUiIntent(
                                prepared.draft,
                              ),
                            },
                          });
                        })
                      }
                    >
                      问这个专区
                    </Button>
                  )}
                </div>
              </div>
              <p className="mt-2 text-caption text-text-3">
                {zone.state === "draft" ? "草稿" : "已发布"}
                {zone.creator && ` · ${zone.creator}`}
                {zone.createdAt && ` · ${evidenceDate(zone.createdAt)}`}
              </p>
              {zone.description && (
                <p className="mt-2 max-w-measure text-ui text-text-2">
                  {zone.description}
                </p>
              )}
              {(zone.background || zone.experts.length > 0) && (
                <details className="mt-3 text-ui">
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
            <section aria-label="专区证据">
              <div className="mb-3 flex flex-wrap gap-3 text-caption text-text-3">
                {total !== null && <span>{total} 条匹配证据</span>}
                {zone.evidenceCount !== null && (
                  <span>{zone.evidenceCount} 条已发布证据</span>
                )}
                {zone.canEdit && <span>包含我的草稿</span>}
              </div>
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
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  setQuery(q.trim());
                }}
              >
                <Input
                  disabled={editing || adding}
                  aria-label="搜索当前专区证据"
                  placeholder="搜索当前专区证据"
                  value={q}
                  onChange={(event) => setQ(event.target.value)}
                />
                <Button
                  disabled={editing || adding}
                  type="submit"
                  variant="secondary"
                >
                  搜索
                </Button>
              </form>
              {!items.length ? (
                <EmptyState
                  title={query ? "没有找到匹配的证据" : "专区暂无证据"}
                />
              ) : (
                <ul className="divide-y divide-border">
                  {items.map((card) => (
                    <li key={card.id} className="py-4">
                      <div className="mb-1 text-caption text-text-3">
                        {card.subtype === "academic"
                          ? "学术证据"
                          : card.subtype === "knowledge"
                            ? "知识证据卡片"
                            : card.subtype}
                        {card.state === "draft" && " · 草稿"}
                      </div>
                      <Link
                        to={`/app/frontier/zones/${encodeURIComponent(zone.id)}/evidence/${encodeURIComponent(card.id)}`}
                        className="text-ui font-medium text-text hover:text-accent"
                      >
                        {card.title}
                      </Link>
                      {card.summary && (
                        <p className="mt-2 line-clamp-3 max-w-measure text-ui leading-relaxed text-text-2">
                          {card.summary}
                        </p>
                      )}
                      <div className="mt-2 flex flex-wrap gap-3 text-caption text-text-3">
                        {card.creator && <span>创作者 {card.creator}</span>}
                        {card.reviewer && <span>评议者 {card.reviewer}</span>}
                      </div>
                    </li>
                  ))}
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
                        {evidenceDate(suggestion.createdAt)}
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
