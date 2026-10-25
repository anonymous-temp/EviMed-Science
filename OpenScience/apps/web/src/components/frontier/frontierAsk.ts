import type { NavigateFunction } from "react-router";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { askDraft, type AskItem } from "./frontierText";

/**
 * The one way from an item of 前沿动态 into the assistant (c3-ask): a new conversation in the person's current project with the
 * draft in the composer, unsent, and the item as its origin — the composer's 「来自：…」 chip opens the item's reading page again, and
 * the assistant reads the item through `frontier_search` by the id the draft's first line carries. Used by 就此提问 (a question of the
 * item's, or the reader's own), by 深入研究 on the cards and in the reader, and by the questions of an event's first-hand report.
 */
export function openItemConversation(navigate: NavigateFunction, item: AskItem, question: string | null): void {
  navigate("/app/chat", {
    state: {
      runtimeUiIntent: {
        ...newRuntimeUiIntent(askDraft(item, question)),
        originReference: { kind: "frontier-item", id: item.id, title: item.title.slice(0, 300) },
      },
    },
  });
}
