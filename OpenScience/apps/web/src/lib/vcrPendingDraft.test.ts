import { beforeEach, expect, it } from "vitest";
import { WEB_SESSION_STARTED_EVENT } from "./sessionLifecycle";
import { pendingRuntimeUiIntent, runtimeUiIntentFromState } from "./runtimeUiNavigation";
import { acceptVcrPendingDraft, prepareVcrPendingDraft, promoteVcrPendingDraft, retireVcrPendingDraft, vcrPendingDraftStatus } from "./vcrPendingDraft";

beforeEach(() => window.dispatchEvent(new Event(WEB_SESSION_STARTED_EVENT)));

it("requires a committed chat and exact study, project and marker version before promoting a draft", () => {
  const draft = { draft: "Unsent draft", restoreDraft: false };
  const marker = prepareVcrPendingDraft("study-a", "project-a", draft);
  const state = { vcrPendingDraft: marker };
  expect(promoteVcrPendingDraft(state, "study-a", "project-a", "session-a")).toBeNull();
  acceptVcrPendingDraft(state, "study-b", "project-a");
  acceptVcrPendingDraft(state, "study-a", "project-b");
  acceptVcrPendingDraft({ vcrPendingDraft: { ...marker, version: 2 } }, "study-a", "project-a");
  expect(promoteVcrPendingDraft(state, "study-a", "project-a", "session-a")).toBeNull();
  acceptVcrPendingDraft(state, "study-a", "project-a");
  for (let index = 0; index < 20; index += 1) prepareVcrPendingDraft("study-a", "project-a", { draft: "Abandoned", restoreDraft: false });
  const intent = promoteVcrPendingDraft(state, "study-a", "project-a", "session-a")!;
  expect(runtimeUiIntentFromState({ runtimeUiIntent: intent }, "project-a")?.draft).toBe(draft.draft);
  expect(pendingRuntimeUiIntent("project-a", "session-a")).toBeNull();
  expect(promoteVcrPendingDraft(state, "study-a", "project-a", "session-a")).toEqual(intent);
  retireVcrPendingDraft("study-a", "project-a", intent);
  expect(vcrPendingDraftStatus(state, "study-a", "project-a")).toBeNull();
  expect(promoteVcrPendingDraft(state, "study-a", "project-a", "session-a")).toBeNull();
});


it("keeps committed drafts when preparation is full and evicts by commit order only after the next acceptance", () => {
  const prepare = (draft: string) => ({ vcrPendingDraft: prepareVcrPendingDraft("study-a", "project-a", { draft, restoreDraft: false }) });
  const accepted = Array.from({ length: 16 }, (_, index) => {
    const state = prepare(`Accepted ${index}`);
    acceptVcrPendingDraft(state, "study-a", "project-a");
    return state;
  });
  const abandoned = Array.from({ length: 17 }, (_, index) => prepare(`Abandoned ${index}`));
  expect(vcrPendingDraftStatus(abandoned[0], "study-a", "project-a")).toBe("lost");
  expect(promoteVcrPendingDraft(abandoned[16], "study-a", "project-a", "session-a")).toBeNull();
  for (const state of accepted) expect(vcrPendingDraftStatus(state, "study-a", "project-a")).toBe("waiting");

  acceptVcrPendingDraft(accepted[0], "study-a", "project-a");
  acceptVcrPendingDraft(abandoned[16], "study-a", "project-a");
  expect(vcrPendingDraftStatus(accepted[0], "study-a", "project-a")).toBe("lost");
  expect(vcrPendingDraftStatus(accepted[1], "study-a", "project-a")).toBe("waiting");
  expect(promoteVcrPendingDraft(abandoned[16], "study-a", "project-a", "session-a")).not.toBeNull();
});

it("clears both prepared and committed drafts when the account changes", () => {
  const prepare = (draft: string) => ({ vcrPendingDraft: prepareVcrPendingDraft("study-a", "project-a", { draft, restoreDraft: false }) });
  const prepared = prepare("First account, prepared");
  const committed = prepare("First account, committed");
  acceptVcrPendingDraft(committed, "study-a", "project-a");
  window.dispatchEvent(new Event(WEB_SESSION_STARTED_EVENT));

  for (const state of [prepared, committed]) {
    acceptVcrPendingDraft(state, "study-a", "project-a");
    expect(vcrPendingDraftStatus(state, "study-a", "project-a")).toBe("lost");
    expect(promoteVcrPendingDraft(state, "study-a", "project-a", "session-a")).toBeNull();
  }
});
