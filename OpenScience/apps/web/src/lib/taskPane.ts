import { useSyncExternalStore } from "react";
import { geoIdFromChatPath } from "@/lib/geoLocation";
import { isStudyChatPath } from "@/lib/studyLocation";
import { isTaskPath } from "@/lib/taskLocation";

/**
 * Where the kernel's conversation is wanted on a page that holds it in a pane: a task's page, a study's conversation view and a GEO project's conversation.
 *
 * The frame cannot be rendered by the page: the kernel's application is an iframe holding a document, a websocket and a handshake,
 * and putting an iframe in another place in the tree reloads all three (`SessionFrameHost` explains what that cost). So the page
 * only says where it wants the conversation — the element that is its pane — and which conversation, and the shell's resident frame
 * is sized and placed over that element. The page registers while it wants the frame (a task whose execution has a conversation to
 * show, a study that has one) and withdraws when it does not: a run still working in a bounded runtime shows its progress in the
 * pane instead.
 */
export interface TaskPaneRequest {
  /** The pane the conversation sits over. */
  element: HTMLElement;
  /** The project the page belongs to: a frame of another project is never placed here. */
  projectId: string;
  /** The conversation the pane shows: the execution's, or the study's own. */
  sessionId: string;
}

/**
 * Whether an address is one of the pages that hold the conversation in a pane — the places the frame may be placed over besides the
 * chat surface itself: a scheduled task (`/app/autopilot/:taskId`) a study's conversation view
 * (`/app/virtual-research/:studyId/chat`) and GEO's addressed conversation (`/app/geo/:geoId/chat/:sessionId`). Read from the address alone, on every navigation, as the chat surface is.
 */
export function isPanePath(pathname: string): boolean {
  return isTaskPath(pathname) || isStudyChatPath(pathname) || geoIdFromChatPath(pathname) !== null;
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
