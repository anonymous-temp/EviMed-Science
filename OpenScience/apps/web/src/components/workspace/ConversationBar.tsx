import { useState } from "react";
import { PenLine } from "lucide-react";
import { Link } from "react-router";
import { isSubmitKey } from "@/lib/compositionKeys";
import { Button, buttonClasses } from "@/components/ui/Button";

/**
 * A module's conversation when it is collapsed: one line at the bottom of the window, on every view of the work (DESIGN.md, 模块工作台).
 *
 * It is not a second composer. Nothing is ever sent from here: what is typed goes, unsent, into the native composer when the conversation
 * opens, and the kernel's input stays the one way to send. It is drawn by the shell and not by the frame so that reading a module's
 * results starts no runtime: a person has two at a time, and a cold one takes as long as it takes. A runtime starts when the person
 * opens the conversation, and they may begin typing before that.
 *
 * `readOnlyTo` is the conversation of someone whose role reads and does not run: a link to it, and nothing to type into.
 */
export function ConversationBar({ onOpen, readOnlyTo, busy = false, placeholder = "告诉 AI 接下来要做什么…" }: {
  onOpen?: (draft: string | undefined) => void;
  readOnlyTo?: string | null;
  busy?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  if (!onOpen) {
    return readOnlyTo
      ? <div data-conversation-bar="read" className="mx-auto flex w-full max-w-wide items-center justify-end"><Link className={buttonClasses({ variant: "text" })} to={readOnlyTo}>查看项目对话</Link></div>
      : null;
  }
  const open = () => { if (!busy) onOpen(text.trim() || undefined); };
  return (
    <div data-conversation-bar="" className="mx-auto flex w-full max-w-wide items-end gap-2 rounded-composer bg-surface py-1 pl-4 pr-1">
      <textarea
        rows={1}
        aria-label="告诉 AI 接下来要做什么"
        placeholder={placeholder}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => { if (isSubmitKey(event)) { event.preventDefault(); open(); } }}
        className="min-h-9 flex-1 resize-none bg-transparent py-1.5 text-ui text-text outline-none placeholder:text-text-3"
      />
      <Button variant="text" loading={busy} actionKind="draft" onClick={open}><PenLine size={16} aria-hidden="true" />{text.trim() ? "放进对话" : "打开对话"}</Button>
    </div>
  );
}
