import { useState } from "react";
import { EVIDENCE_CHALLENGE_WAITING_LABEL_ZH } from "@evimed/domain";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import { Tag } from "@/components/ui/Tag";
import {
  EVIDENCE_OUTCOME_LABELS,
  EVIDENCE_REASON_LIMITS,
  evidenceUpkeepErrorMessage,
  submitEvidenceChallenge,
  type EvidenceChallengeView,
} from "@/lib/evidenceUpkeepClient";

/** What the reader is told a challenge has come to. The platform judges its own cards; for anyone else's it only tells the producer. */
function standing(challenge: EvidenceChallengeView): string {
  if (challenge.state === "resolved")
    return `复核结果：${challenge.outcomeLabel ?? (challenge.outcome ? EVIDENCE_OUTCOME_LABELS[challenge.outcome] : "已处理")}`;
  if (challenge.state === "closed") return "出品方已修改这张卡，这条质疑已关闭。";
  if (challenge.state === "notified") return "已通知出品方。平台不会替出品方修改内容；出品方修改后这条质疑会自动关闭。";
  if (challenge.waiting) return `${EVIDENCE_CHALLENGE_WAITING_LABEL_ZH}。轮到后结果会写进变更记录，也会通知你。`;
  return "已提交，正在复核。结果会写进变更记录，也会通知你。";
}

/**
 * 「质疑」 — a reader challenges one claim of a published card. The reason is the reader's own words; the platform answers in the change log.
 * Not mounted by itself: the reading page puts it beside a claim in 「依据」 and may pass the reader's earlier challenge on that claim.
 */
export function EvidenceChallenge({
  cardId,
  claimId,
  existing = null,
  onFiled,
}: {
  cardId: string;
  claimId: string;
  /** The reader's open or settled challenge on this claim, when the page knows of one. */
  existing?: EvidenceChallengeView | null;
  onFiled?: (challenge: EvidenceChallengeView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filed, setFiled] = useState<EvidenceChallengeView | null>(null);
  const text = reason.trim();
  const tooShort = text.length < EVIDENCE_REASON_LIMITS.min;
  const submit = async () => {
    if (busy || tooShort) return;
    setBusy(true);
    setError(null);
    try {
      const challenge = await submitEvidenceChallenge(cardId, claimId, text);
      setFiled(challenge);
      setOpen(false);
      setReason("");
      onFiled?.(challenge);
    } catch (reasonForFailure) {
      // The reason stays where it was written: a refused challenge is not a lost one.
      setError(evidenceUpkeepErrorMessage(reasonForFailure));
    } finally {
      setBusy(false);
    }
  };
  // The page may hold a fresher view of the reader's challenge than this component does; the later of the two is what stands.
  const shown = filed && (!existing || Date.parse(filed.createdAt) >= Date.parse(existing.createdAt)) ? filed : existing;
  const status = shown && (
    <p className="flex flex-wrap items-center gap-2 text-caption text-muted" role="status">
      <Tag tone={shown.state === "resolved" && shown.outcome !== "uphold" ? "warn" : "neutral"}>你的质疑</Tag>
      <span>{standing(shown)}</span>
      {shown.explanation && shown.state === "resolved" && <span className="text-text-2">{shown.explanation}</span>}
    </p>
  );
  // One open challenge per claim: while one is waiting there is nothing to file; once it is settled the reader may challenge again.
  if (shown && (shown.state === "open" || shown.state === "notified")) return status;
  if (!open)
    return (
      <div className="flex flex-wrap items-center gap-2">
        {status}
        <Button variant="text" onClick={() => setOpen(true)} aria-label={`质疑结论 ${claimId}`}>
          {shown ? "再次质疑" : "质疑"}
        </Button>
      </div>
    );
  return (
    <form
      className="max-w-measure space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Textarea
        label={`质疑结论 ${claimId}：说明你认为哪里不对`}
        required
        minLength={EVIDENCE_REASON_LIMITS.min}
        maxLength={EVIDENCE_REASON_LIMITS.max}
        value={reason}
        disabled={busy}
        onChange={(event) => setReason(event.target.value)}
        error={error}
      />
      <p className="text-caption text-muted">
        {text.length}/{EVIDENCE_REASON_LIMITS.max}。平台的卡片会逐字核对原文并复核；别人出品的卡片只会通知出品方。
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="secondary" loading={busy} disabled={tooShort}>
          提交质疑
        </Button>
        <Button
          variant="text"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          取消
        </Button>
      </div>
    </form>
  );
}
