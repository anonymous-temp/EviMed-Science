import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  useEvidenceScope,
  useEvidenceRequestId,
} from "@/components/frontier/useEvidenceScope";
import { CardEditor } from "@/components/frontier/EvidenceEditors";
import { Textarea, inputClasses } from "@/components/ui/Input";
import { Disclosure } from "@/components/ui/Disclosure";
import { Menu } from "@/components/ui/Menu";
import { Tooltip } from "@/components/ui/Tooltip";
import { PageShell } from "@/components/layout/PageShell";
import { FrontierBack } from "@/components/frontier/FrontierBack";
import { FrontierSkeleton } from "@/components/frontier/FrontierSkeleton";
import { EvidenceReading } from "@/components/frontier/EvidenceReading";
import {
  EvidenceDiscussionList,
  EvidenceReviews,
  EvidenceRevisions,
  evidenceDiscussionCount,
} from "@/components/frontier/EvidenceDiscussion";
import { EvidenceCardLinks, EvidenceContinueAction } from "@/components/frontier/EvidenceCardLinks";
import { EvidenceChangeLog } from "@/components/frontier/EvidenceChangeLog";
import { useEvidenceFeatures } from "@/components/frontier/useEvidenceFeatures";
import { listMyEvidenceChallenges, type EvidenceChallengeView } from "@/lib/evidenceUpkeepClient";
import { EmptyState } from "@/components/cards/EmptyState";
import { WebApiError } from "@/lib/apiClient";
import { fetchFrontierItem } from "@/lib/frontierClient";
import { Button } from "@/components/ui/Button";
import {
  fetchEvidenceZone,
  publishEvidenceCard,
  deleteEvidenceComment,
  reviewEvidenceCard,
  commentEvidenceCard,
  fetchZoneEvidence,
  prepareEvidenceResearch,
  type EvidenceZone,
  type EvidenceCard,
} from "@/lib/evidenceZoneClient";
import { evidenceErrorMessage } from "@/lib/evidenceZoneClient";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";

export function EvidenceReadingPage() {
  const { zoneId = "", cardId = "" } = useParams();
  return (
    <EvidenceReadingContent
      key={`${zoneId}:${cardId}`}
      zoneId={zoneId}
      cardId={cardId}
    />
  );
}
function EvidenceReadingContent({
  zoneId,
  cardId,
}: {
  zoneId: string;
  cardId: string;
}) {
  const navigate = useNavigate();
  const commentRequestId = useEvidenceRequestId();
  const [score, setScore] = useState<number | "">("");
  const [reviewText, setReviewText] = useState("");
  // A draft made from a research result opens straight in the editor (`?edit=1`).
  const [params] = useSearchParams();
  const [editing, setEditing] = useState(params.get("edit") === "1");
  const [comment, setComment] = useState("");
  const [zone, setZone] = useState<EvidenceZone | null>(null);
  const [evidence, setEvidence] = useState<EvidenceCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const capture = useEvidenceScope(`${zoneId}:${cardId}:${refresh}`);
  // Keeping cards current (flywheel F14): where the deployment has it, each claim offers 「质疑」 and the card shows its history.
  const features = useEvidenceFeatures();
  const [challenges, setChallenges] = useState<EvidenceChallengeView[] | undefined>(undefined);
  const challengeable = features.upkeep && evidence?.state === "published";
  // 「更新记录」 is read when the reader opens it, not with every card.
  const [logOpened, setLogOpened] = useState(false);
  // The feed item the card was written from: 「回到相关动态」 is offered while the item can still be read.
  const sourceItemId = evidence?.sourceItemId ?? null;
  const [sourceItemLive, setSourceItemLive] = useState(false);
  useEffect(() => {
    setSourceItemLive(false);
    if (!sourceItemId) return;
    let active = true;
    fetchFrontierItem(sourceItemId)
      .then(() => active && setSourceItemLive(true))
      .catch((reason) => {
        // An item that was taken down is gone for good; any other failure says nothing about it, and the link stays.
        const gone = reason instanceof WebApiError && reason.status === 404 && reason.code === "frontier_item_not_found";
        if (active) setSourceItemLive(!gone);
      });
    return () => {
      active = false;
    };
  }, [sourceItemId]);
  useEffect(() => {
    if (!challengeable) {
      setChallenges(undefined);
      return;
    }
    let active = true;
    // A failure to read the reader's earlier challenges leaves the claims challengeable and merely forgets them.
    listMyEvidenceChallenges(cardId)
      .then((items) => active && setChallenges(items))
      .catch(() => active && setChallenges([]));
    return () => {
      active = false;
    };
  }, [challengeable, cardId]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setBusy(false);
    setError(null);
    setEvidence(null);
    setZone(null);
    Promise.all([fetchEvidenceZone(zoneId), fetchZoneEvidence(zoneId, cardId)])
      .then(([detail, card]) => {
        if (active) {
          setZone(detail);
          setEvidence(card);
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
  }, [zoneId, cardId, refresh]);
  const research = async () => {
    if (!zone || !evidence) return;
    const current = capture();
    setBusy(true);
    setError(null);
    try {
      const prepared = await prepareEvidenceResearch(zone, evidence);
      if (!current()) return;
      navigate("/app/chat", {
        state: { runtimeUiIntent: newRuntimeUiIntent(prepared.draft) },
      });
    } catch (reason) {
      if (current()) setError(evidenceErrorMessage(reason));
    } finally {
      if (current()) setBusy(false);
    }
  };
  const question = evidence ? evidence.content?.question || evidence.title : null;
  const zonePath = `/app/frontier/zones/${encodeURIComponent(zoneId)}`;
  const askable = !!zone?.canResearch && !!evidence?.canResearch;
  const publishable = !!evidence && !(evidence.state === "draft" && (!evidence.body.trim() || !evidence.sources.length));
  const publishCard = () => {
    if (!evidence) return;
    const current = capture();
    setBusy(true);
    setError(null);
    publishEvidenceCard(
      evidence,
      evidence.state === "published" ? "draft" : "published",
    )
      .then((card) => {
        if (current()) setEvidence(card);
      })
      .catch((reason) => {
        if (current()) setError(evidenceErrorMessage(reason));
      })
      .finally(() => {
        if (current()) setBusy(false);
      });
  };
  const upkeepLog = features.upkeep && evidence?.state === "published";
  const hasRevisions = (evidence?.revisions?.length ?? 0) > 1;
  return (
    <PageShell
      title={question ?? "证据卡"}
      back={<FrontierBack trail={[{ label: zone?.title || "专区", to: zonePath }]} />}
      actions={
        (askable || evidence?.canEdit) && (
          <>
            {askable && (
              <Tooltip content="在当前项目里带着这张卡提问">
                <Button loading={busy} onClick={() => void research()}>
                  问这条证据
                </Button>
              </Tooltip>
            )}
            {evidence?.canEdit && (
              <Menu
                label="更多操作"
                items={[
                  {
                    label: "编辑证据",
                    disabled: editing,
                    onSelect: () => setEditing(true),
                  },
                  {
                    label: evidence.state === "published" ? "撤回证据" : "发布证据",
                    disabled: editing || busy || !publishable,
                    onSelect: publishCard,
                  },
                ]}
              />
            )}
          </>
        )
      }
    >
      {evidence?.canEdit && evidence.state === "draft" && !publishable && (
        <p className="mb-4 text-caption text-text-3">发布前请填写正文并添加来源</p>
      )}
      {editing && evidence?.canEdit && (
        <div className="mb-4">
          <CardEditor
            key={`${zoneId}:${cardId}`}
            zoneId={zoneId}
            card={evidence}
            onCancel={() => setEditing(false)}
            onSaved={(card) => {
              setEvidence(card);
              setEditing(false);
            }}
          />
        </div>
      )}
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
      {loading ? (
        <FrontierSkeleton />
      ) : (
        evidence && (
          <>
            <EvidenceReading
              evidence={evidence}
              challenges={challengeable ? (challenges ?? []) : undefined}
              afterAnswer={<EvidenceContinueAction evidence={evidence} />}
            />
            <div className="mt-6 max-w-measure-body space-y-4">
              {sourceItemLive && (
                <Link
                  className="inline-block text-caption text-accent"
                  to={`/app/frontier?item=${encodeURIComponent(evidence.sourceItemId ?? "")}`}
                >
                  回到相关动态
                </Link>
              )}
              <EvidenceCardLinks
                cardId={evidence.id}
                from={{ to: `${zonePath}/evidence/${encodeURIComponent(cardId)}`, label: question ?? evidence.title }}
              />
              <Disclosure summary={`评议与讨论（${evidenceDiscussionCount(evidence)}）`}>
                <div className="space-y-6">
                  <EvidenceReviews evidence={evidence} />
                  <EvidenceDiscussionList
                    evidence={evidence}
                    onDeleteComment={(id) => {
                      const current = capture();
                      setBusy(true);
                      deleteEvidenceComment(evidence, id)
                        .then(async () => {
                          const updated = await fetchZoneEvidence(zoneId, cardId);
                          if (current()) setEvidence(updated);
                        })
                        .catch((reason) => {
                          if (current()) setError(evidenceErrorMessage(reason));
                        })
                        .finally(() => {
                          if (current()) setBusy(false);
                        });
                    }}
                  />
                  {evidence.canReview && (
                    <form
                      className="max-w-measure space-y-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const current = capture();
                        setBusy(true);
                        setError(null);
                        reviewEvidenceCard(evidence, Number(score), reviewText.trim())
                          .then(async () => {
                            const updated = await fetchZoneEvidence(zoneId, cardId);
                            if (current()) {
                              setEvidence(updated);
                              setReviewText("");
                            }
                          })
                          .catch((reason) => {
                            if (current()) setError(evidenceErrorMessage(reason));
                          })
                          .finally(() => {
                            if (current()) setBusy(false);
                          });
                      }}
                    >
                      <label className="block text-ui text-text">
                        学术评议评分
                        <select
                          className={inputClasses({ className: "mt-2" })}
                          required
                          value={score}
                          onChange={(event) =>
                            setScore(
                              event.target.value ? Number(event.target.value) : "",
                            )
                          }
                        >
                          <option value="">请选择评分</option>
                          {[1, 2, 3, 4, 5].map((value) => (
                            <option key={value} value={value}>
                              {value} / 5
                            </option>
                          ))}
                        </select>
                      </label>
                      <Textarea
                        label="评议意见"
                        maxLength={4000}
                        value={reviewText}
                        onChange={(event) => setReviewText(event.target.value)}
                      />
                      <Button
                        type="submit"
                        variant="secondary"
                        loading={busy}
                        disabled={!reviewText.trim() || score === ""}
                      >
                        发布评议
                      </Button>
                    </form>
                  )}
                  {evidence.state === "published" && (
                    <form
                      className="max-w-measure space-y-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const current = capture();
                        setBusy(true);
                        setError(null);
                        commentEvidenceCard(
                          evidence,
                          comment.trim(),
                          commentRequestId(`${evidence.id}:${comment.trim()}`),
                        )
                          .then(async () => {
                            const updated = await fetchZoneEvidence(zoneId, cardId);
                            if (current()) {
                              setEvidence(updated);
                              setComment("");
                            }
                          })
                          .catch((reason) => {
                            if (current()) setError(evidenceErrorMessage(reason));
                          })
                          .finally(() => {
                            if (current()) setBusy(false);
                          });
                      }}
                    >
                      <Textarea
                        label="参与讨论"
                        maxLength={4000}
                        value={comment}
                        onChange={(event) => setComment(event.target.value)}
                      />
                      <Button
                        type="submit"
                        variant="secondary"
                        loading={busy}
                        disabled={!comment.trim()}
                      >
                        发布讨论
                      </Button>
                    </form>
                  )}
                </div>
              </Disclosure>
              {(hasRevisions || upkeepLog) && (
                <Disclosure
                  summary="更新记录"
                  onToggle={(open) => {
                    if (open) setLogOpened(true);
                  }}
                >
                  <div className="space-y-6">
                    <EvidenceRevisions evidence={evidence} />
                    {upkeepLog && logOpened && (
                      <section aria-label="这张卡的变更记录">
                        <h3 className="mb-2 text-ui font-medium text-text">变更记录</h3>
                        <EvidenceChangeLog zoneId={zoneId} cardId={evidence.id} pageSize={10} />
                      </section>
                    )}
                  </div>
                </Disclosure>
              )}
            </div>
          </>
        )
      )}
    </PageShell>
  );
}
