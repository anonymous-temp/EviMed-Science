import { Link } from "react-router";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Note } from "@/components/ui/Note";
import { taskPath } from "@/lib/taskLocation";
import { CONVERSATION_HELD } from "./taskPresentation";

/**
 * Said before the researcher meets the wall: a bounded scheduled execution holds the project's runtime while it runs, so no conversation
 * of the project opens until it ends. The kernel's own frame says so only once a conversation is clicked (`RuntimeUiFrame`), after the
 * click that could not have worked; this sentence is on the pages that show the execution, with the one thing that releases it.
 *
 * The execution is the page's own task's: the note then offers to stop it (`onStop`), which gives the conversation back at once.
 * It is another task's: the note links to that task instead, where its execution can be stopped.
 */
export function ConversationHeldNote({ onStop, stopping = false, busy = false, otherTaskId }: {
  /** Stops the execution that holds the project; given when it is the page's own task's. */
  onStop?: () => void;
  stopping?: boolean;
  busy?: boolean;
  /** The task whose execution holds the project, when it is not the one on screen. */
  otherTaskId?: string;
}) {
  return <Note
    tone="warn"
    action={otherTaskId
      ? <Link to={taskPath(otherTaskId)} className={buttonClasses({ variant: "secondary", size: "sm" })}>查看正在运行的任务</Link>
      : onStop ? <Button variant="secondary" size="sm" actionKind="set" disabled={busy || stopping} onClick={onStop}>{stopping ? "正在停止" : "停止并继续对话"}</Button> : undefined}
  >{CONVERSATION_HELD}</Note>;
}
