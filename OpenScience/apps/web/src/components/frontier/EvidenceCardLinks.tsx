import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button } from "@/components/ui/Button";
import {
  continueResearchFromCard,
  evidenceErrorMessage,
  fetchEvidenceCardLinks,
  type EvidenceCard,
  type EvidenceCardLinks as Links,
  type EvidenceCardRef,
  type EvidenceContinuation,
} from "@/lib/evidenceZoneClient";
import { useProjectStore } from "@/lib/projects";
import type { RuntimeUiIntent } from "@/lib/runtimeUiNavigation";

const RELATION_LABEL = { next_version: "后续版本", research_from_card: "后续研究" } as const;

const cardPath = (card: Pick<EvidenceCardRef, "zoneId" | "id">) => `/app/frontier/zones/${encodeURIComponent(card.zoneId)}/evidence/${encodeURIComponent(card.id)}`;

/** The conversation `continueResearchFromCard` bound, opened the way every new one opens: the question in the composer, unsent. */
export function continuationIntent(continuation: EvidenceContinuation): RuntimeUiIntent {
  return { kind: "create", projectId: continuation.projectId, requestId: crypto.randomUUID(), sessionId: continuation.sessionId, draft: continuation.draft };
}

/**
 * 「用这张卡继续研究」: a project, the card's primary sources in its knowledge base and the question, written and not sent. It
 * adds to 「问这条证据」 and replaces nothing. A source that could not be saved is said before the conversation opens.
 */
export function EvidenceContinueAction({ evidence }: { evidence: Pick<EvidenceCard, "id" | "canResearch"> }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<EvidenceContinuation | null>(null);
  if (!evidence.canResearch) return null;
  const open = (continuation: EvidenceContinuation) => {
    void useProjectStore.getState().select(continuation.projectId, () => {
      navigate("/app/chat", { flushSync: true, state: { runtimeUiIntent: continuationIntent(continuation) } });
    });
  };
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const continuation = await continueResearchFromCard(evidence.id);
      if (continuation.library.failed.length > 0) setPending(continuation);
      else open(continuation);
    } catch (reason) {
      setError(evidenceErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <Button variant="secondary" loading={busy} onClick={() => void start()}>
        用这张卡继续研究
      </Button>
      {error && <p role="alert" className="text-ui text-error">{error}</p>}
      {pending && (
        <div role="status" className="space-y-2 text-ui text-text-2">
          <p>已存入 {pending.library.saved.length} 个来源，有 {pending.library.failed.length} 个没有存成：{pending.library.failed.map((item) => `来源 ${item.index}`).join("、")}。</p>
          <Button variant="secondary" onClick={() => open(pending)}>继续</Button>
        </div>
      )}
    </div>
  );
}

function CardLine({ card, label }: { card: EvidenceCardRef; label: string }) {
  return (
    <li className="text-ui text-text-2">
      <span className="text-text-3">{label} · </span>
      <Link className="text-accent hover:underline" to={cardPath(card)}>{card.title}</Link>
      {card.creator && <span className="text-text-3">{` · ${card.creator}`}</span>}
    </li>
  );
}

/**
 * What a card points to and what points to it: its author, the card its research began from, the card it follows, and the
 * published cards that follow it or began from it. Quiet when there is nothing to say; a read that fails is said once, with
 * a retry, and never replaces the card.
 */
export function EvidenceCardLinks({ cardId }: { cardId: string }) {
  const [links, setLinks] = useState<Links | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setFailed(false);
    fetchEvidenceCardLinks(cardId)
      .then((value) => { if (active) setLinks(value); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [cardId, attempt]);
  if (failed) {
    return (
      <p role="status" className="text-caption text-text-3">
        关联的作者和卡片暂时读不出来。
        <Button variant="text" size="sm" onClick={() => setAttempt((value) => value + 1)}>重试</Button>
      </p>
    );
  }
  if (!links) return null;
  const lines = [
    ...(links.origin ? [<CardLine key="origin" card={links.origin} label="这张卡的研究始于" />] : []),
    ...(links.previous ? [<CardLine key="previous" card={links.previous} label="前一版" />] : []),
    ...links.related.map((card) => <CardLine key={card.id} card={card} label={RELATION_LABEL[card.relation]} />),
  ];
  return (
    <section className="space-y-3" aria-label="关联">
      <p className="text-ui text-text-2">
        <span className="text-text-3">作者 · </span>
        <Link className="text-accent hover:underline" to={`/app/frontier/authors/${encodeURIComponent(links.author.id)}`}>{links.author.name}</Link>
      </p>
      {lines.length > 0 && <ul className="space-y-1">{lines}</ul>}
    </section>
  );
}
