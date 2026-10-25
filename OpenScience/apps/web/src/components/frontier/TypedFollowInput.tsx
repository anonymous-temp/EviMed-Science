import { useEffect, useId, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { addFrontierFollow, FOLLOW_LABEL_MAX, frontierErrorMessage, type FrontierFollow } from "@/lib/frontierClient";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";

/** What a reader typed, as the server reads it: NFKC and one space between words. */
export function typedFollowWords(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** The follow that already holds these words (a typed follow is unique by its words, case-folded). */
export function heldTypedFollow(held: readonly FrontierFollow[], words: string): FrontierFollow | undefined {
  const key = words.toLowerCase();
  return held.find((follow) => follow.kind === "query" && follow.key.toLowerCase() === key);
}

/**
 * 「关注一个药物、试验或问题」 (c3-watch, 2026-10-25): one input in which a reader types what they want to hear about — a drug, a trial,
 * 「GLP-1 和胰腺炎」 — and the server reads it. Enter or the plus adds it; the follow's feed is what opens next (`onAdded`). The same
 * words twice are said once, with no request. A reading that fails is not an error the reader sees: the server keeps the words.
 */
export function TypedFollowInput({ held, onAdded, compact = false }: {
  held: readonly FrontierFollow[];
  onAdded: (follow: FrontierFollow) => void;
  /** In the narrow column of follows: the label is the placeholder and the field's name. */
  compact?: boolean;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "note" | "error"; text: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const messageId = useId();
  const submit = async () => {
    const words = typedFollowWords(text);
    if (!words || pending) return;
    if ([...words].length > FOLLOW_LABEL_MAX) { setMessage({ tone: "error", text: `最多 ${FOLLOW_LABEL_MAX} 个字` }); return; }
    const already = heldTypedFollow(held, words);
    if (already) { setMessage({ tone: "note", text: `已经关注了“${already.label}”` }); return; }
    setPending(true);
    setMessage(null);
    try {
      const follow = await addFrontierFollow({ kind: "query", key: words, label: words });
      if (!alive.current) return;
      setText("");
      onAdded(follow);
    } catch (failure) {
      if (alive.current) setMessage({ tone: "error", text: frontierErrorMessage(failure) });
    } finally {
      if (alive.current) setPending(false);
    }
  };
  const label = "关注一个药物、试验或问题";
  return (
    <form
      className="min-w-0 space-y-1"
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
    >
      <Input
        {...(compact ? { "aria-label": label } : { label })}
        value={text}
        maxLength={FOLLOW_LABEL_MAX}
        placeholder={compact ? "药物、试验或问题" : "司美格鲁肽、SELECT 试验"}
        aria-describedby={message ? messageId : undefined}
        aria-busy={pending || undefined}
        onChange={(event) => { setText(event.target.value); setMessage(null); }}
        trailing={<IconButton icon={Plus} label="关注" size="sm" type="submit" disabled={pending || !typedFollowWords(text)} />}
      />
      {message && (
        <p id={messageId} role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "text-caption text-error" : "text-caption text-text-2"}>
          {message.text}
        </p>
      )}
    </form>
  );
}
