import { useState } from "react";
import { webErrorMessage } from "@/lib/apiClient";
import { rememberMemory } from "@/lib/memoryClient";
import { Button } from "@/components/ui/Button";
import { FormDialog } from "@/components/ui/FormDialog";
import { Textarea } from "@/components/ui/Input";

/**
 * 「记住这一条」: the person says something in their own words and the memory writes it down. It is the one place on the page
 * that adds a memory; every other memory comes from a conversation. The words are handed over and the dialog closes — what
 * comes back is a row marked 「正在记住」 in the list until the memory has written it (`usePendingMemory`).
 *
 * A text the memory refuses (a key, an ID number, a phone number) is said here in the registry's own sentence, with the words
 * still in the box so the person can take the part that is not refused.
 */
export function RememberDialog({ projectId = null, onClose, onAsked }: {
  /** The project the words belong to, when the caller names one; the account's own otherwise (what the memory page asks). */
  projectId?: string | null;
  onClose: () => void;
  /** The words were accepted: the page reads its list again to show them as 正在记住. */
  onAsked: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (markSaved: () => void) => {
    const words = text.trim();
    if (!words || busy) return;
    setBusy(true);
    setError(null);
    try {
      await rememberMemory(words, projectId);
      markSaved(); setText(""); setBusy(false);
      onAsked();
      onClose();
    } catch (reason) {
      setError(webErrorMessage(reason, { fallback: "没有记下，请重试。" }));
      setBusy(false);
    }
  };
  return (
    <FormDialog title="记住这一条" onClose={onClose} busy={busy} dirty={text.length > 0}>
      {(requestClose, markSaved) => <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void submit(markSaved); }}>
        <Textarea
          aria-label="要记住的内容"
          rows={4}
          disabled={busy}
          maxLength={2_000}
          value={text}
          placeholder="例如：以后报告先给结论，再给依据。"
          onChange={(event) => setText(event.target.value)}
        />
        {error && <p role="alert" className="text-ui text-error">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="text" disabled={busy} onClick={requestClose}>取消</Button>
          <Button type="submit" loading={busy} disabled={!text.trim()}>记住</Button>
        </div>
      </form>}
    </FormDialog>
  );
}
