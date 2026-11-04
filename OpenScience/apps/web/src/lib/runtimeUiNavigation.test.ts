import { expect, it } from "vitest";
import { acknowledgeRuntimeUiIntent, newRuntimeUiIntent, pendingRuntimeUiIntent, prepareRuntimeUiIntent, registerPendingRuntimeUiIntent, runtimeUiIntentFromState, runtimeUiIntentWasLost, sanitizeRuntimeUiHistoryState } from "./runtimeUiNavigation";

it("retains an unacknowledged draft through same-account history, retires it only on success", () => {
  const intent = { ...newRuntimeUiIntent("private draft", "session-a"), kind: "open" as const };
  const state = { runtimeUiIntent: prepareRuntimeUiIntent(intent) };
  expect(state.runtimeUiIntent).toEqual({ kind: intent.kind, projectId: intent.projectId, requestId: intent.requestId, sessionId: intent.sessionId });
  expect(JSON.stringify(state)).not.toContain("private draft");
  expect(runtimeUiIntentFromState(structuredClone(state), intent.projectId)).toEqual(intent);
  // A failed open has no acknowledgement and can be retried with its original content.
  expect(runtimeUiIntentFromState({ ...state }, intent.projectId)).toEqual(intent);
  acknowledgeRuntimeUiIntent(intent);
  expect(runtimeUiIntentFromState(state, intent.projectId)).toBeNull();
  expect(runtimeUiIntentFromState({ ...state }, intent.projectId)).toBeNull();
});

it("refuses the previous account's intent even for the same project and session", () => {
  const intent = { ...newRuntimeUiIntent("account A draft", "same-session"), kind: "open" as const,
    resultRevision: { referenceId: `rr_${"a".repeat(64)}` } };
  const state = { runtimeUiIntent: prepareRuntimeUiIntent(intent) };
  window.dispatchEvent(new StorageEvent("storage", { key: "open-science:web-session-sync", newValue: '{"kind":"started"}' }));
  expect(runtimeUiIntentFromState(state, intent.projectId)).toBeNull();
  expect(runtimeUiIntentWasLost(state, intent.projectId)).toBe(true);
  const next = { ...newRuntimeUiIntent("account B draft", "same-session"), kind: "open" as const };
  expect(runtimeUiIntentFromState({ runtimeUiIntent: prepareRuntimeUiIntent(next) }, next.projectId)).toEqual(next);
});

it("rejects a history intent without this document's owner", () => {
  const intent = { ...newRuntimeUiIntent("old document", "same-session"), owner: "a-different-document" };
  expect(runtimeUiIntentFromState({ runtimeUiIntent: intent }, intent.projectId)).toBeNull();
});

it("uses secure random bytes without randomUUID and fails closed without secure randomness", async () => {
  const { newSessionOwner } = await import("./sessionLifecycle");
  const source = { getRandomValues: (bytes: Uint8Array) => { bytes.fill(0xab); return bytes; } } as unknown as Pick<Crypto, "randomUUID" | "getRandomValues">;
  expect(newSessionOwner(source)).toBe("ab".repeat(32));
  expect(newSessionOwner({} as Pick<Crypto, "randomUUID" | "getRandomValues">)).toBe("");
});


it("keeps a committed pending intent for only the exact project, GEO scope and session until ACK", () => {
  const scope = { kind: "geo" as const, geoProjectId: "g1", sessionId: "s1" };
  const intent = { ...newRuntimeUiIntent("unsent", "s1", { projectId: "p1", scope }), kind: "open" as const };
  const state = { runtimeUiIntent: prepareRuntimeUiIntent(intent) };
  const committed = runtimeUiIntentFromState(state, intent.projectId);
  expect(committed).not.toBeNull();
  registerPendingRuntimeUiIntent(committed!);
  expect(pendingRuntimeUiIntent("p1", "s1", scope)).toEqual(intent);
  expect(pendingRuntimeUiIntent("other", "s1", scope)).toBeNull();
  expect(pendingRuntimeUiIntent("p1", "s2", scope)).toBeNull();
  expect(pendingRuntimeUiIntent("p1", "s1", { ...scope, geoProjectId: "g2" })).toBeNull();
  expect(pendingRuntimeUiIntent("p1", "s1")).toBeNull();
  acknowledgeRuntimeUiIntent(intent);
  expect(pendingRuntimeUiIntent("p1", "s1", scope)).toBeNull();
  expect(runtimeUiIntentFromState(state, "p1")).toBeNull();
});

it("discards committed pending intents across an account boundary", () => {
  const intent = { ...newRuntimeUiIntent("private", "same"), kind: "open" as const };
  const state = { runtimeUiIntent: prepareRuntimeUiIntent(intent) };
  const committed = runtimeUiIntentFromState(state, intent.projectId);
  expect(committed).not.toBeNull();
  registerPendingRuntimeUiIntent(committed!);
  expect(pendingRuntimeUiIntent(intent.projectId, "same")).toEqual(intent);
  window.dispatchEvent(new StorageEvent("storage", { key: "open-science:web-session-sync", newValue: '{"kind":"started"}' }));
  expect(pendingRuntimeUiIntent(intent.projectId, "same")).toBeNull();
});


it("does not activate a prepared but uncommitted intent or accept a forged locator", () => {
  const intent = { ...newRuntimeUiIntent("not yet committed", "s1"), kind: "open" as const };
  const marker = prepareRuntimeUiIntent(intent);
  expect(pendingRuntimeUiIntent(intent.projectId, "s1")).toBeNull();
  expect(runtimeUiIntentFromState({ runtimeUiIntent: { ...marker, sessionId: "s2" } }, intent.projectId)).toBeNull();
  expect(runtimeUiIntentFromState({ runtimeUiIntent: { ...marker, draft: "injected" } }, intent.projectId)).toBeNull();
  expect(runtimeUiIntentFromState({ runtimeUiIntent: marker }, intent.projectId)?.draft).toBe("not yet committed");
});


it("resolves a committed marker by its exact request even after prepared capacity is exceeded", () => {
  const scope = { kind: "geo" as const, geoProjectId: "geo_capacity", sessionId: "session-capacity" };
  const intent = { ...newRuntimeUiIntent("Still committed", scope.sessionId, { projectId: "capacity", scope }), kind: "open" as const };
  const marker = prepareRuntimeUiIntent(intent);
  registerPendingRuntimeUiIntent(runtimeUiIntentFromState({ runtimeUiIntent: marker }, intent.projectId)!);
  for (let i = 0; i < 129; i += 1) prepareRuntimeUiIntent(newRuntimeUiIntent("Guarded but never committed", `pending-${i}`));
  expect(runtimeUiIntentFromState({ runtimeUiIntent: marker }, intent.projectId)).toEqual(intent);
  expect(runtimeUiIntentWasLost({ runtimeUiIntent: marker }, intent.projectId)).toBe(false);
  expect(runtimeUiIntentFromState({ runtimeUiIntent: { ...marker, sessionId: "another" } }, intent.projectId)).toBeNull();
  acknowledgeRuntimeUiIntent(intent);
  expect(runtimeUiIntentFromState({ runtimeUiIntent: marker }, intent.projectId)).toBeNull();
});

it("scrubs legacy history without resolving or copying the old draft and references", () => {
  const intent = { ...newRuntimeUiIntent("old plaintext", "legacy-session"), resultRevision: { referenceId: `rr_${"a".repeat(64)}` } };
  const legacy = { runtimeUiIntent: intent, userFlag: "retained" };
  const clean = sanitizeRuntimeUiHistoryState(legacy);
  expect(clean).toEqual({ runtimeUiIntent: { kind: intent.kind, projectId: intent.projectId, requestId: intent.requestId, sessionId: intent.sessionId }, userFlag: "retained" });
  expect(runtimeUiIntentFromState(clean, intent.projectId)).toBeNull();
  expect(sanitizeRuntimeUiHistoryState(clean)).toBe(clean);
});

it("may ask for the kernel's scheduled-task page, and for no other", () => {
  const intent = { ...newRuntimeUiIntent(undefined, "session-tasks"), panel: "schedules" as const };
  expect(runtimeUiIntentFromState({ runtimeUiIntent: prepareRuntimeUiIntent(intent) }, intent.projectId)?.panel).toBe("schedules");
  // The history entry holds no payload, the page's name included.
  expect(prepareRuntimeUiIntent(intent)).not.toHaveProperty("panel");
  for (const panel of ["settings", "files", "Schedules", "", "schedules ", null, 1, {}]) {
    const other = { ...newRuntimeUiIntent(undefined, "session-other"), panel: panel as never };
    expect(runtimeUiIntentFromState({ runtimeUiIntent: prepareRuntimeUiIntent(other) }, other.projectId), JSON.stringify(panel)).toBeNull();
  }
});
