import { useSyncExternalStore } from "react";

/**
 * Where the kernel's conversation is wanted on a task's page.
 *
 * The frame cannot be rendered by the page: the kernel's application is an iframe holding a document, a websocket and a handshake,
 * and putting an iframe in another place in the tree reloads all three (`SessionFrameHost` explains what that cost). So the page
 * only says where it wants the conversation — the element that is its pane — and which conversation, and the shell's resident frame
 * is sized and placed over that element. The page registers while it wants the frame (a task whose execution has a conversation to
 * show) and withdraws when it does not: an execution still running in a bounded runtime shows its progress in the pane instead.
 */
export interface TaskPaneRequest {
  /** The pane the conversation sits over. */
  element: HTMLElement;
  /** The project the page belongs to: a frame of another project is never placed here. */
  projectId: string;
  /** The conversation the pane shows: the execution's. */
  sessionId: string;
}

let current: TaskPaneRequest | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

/** Asks for the frame over `request.element`. Returns the withdrawal; a newer request replaces this one. */
export function registerTaskPane(request: TaskPaneRequest): () => void {
  current = request;
  notify();
  return () => {
    if (current !== request) return;
    current = null;
    notify();
  };
}

export function useTaskPane(): TaskPaneRequest | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => current,
    () => null,
  );
}
