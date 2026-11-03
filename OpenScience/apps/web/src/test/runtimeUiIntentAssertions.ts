import { expect } from "vitest";
import { runtimeUiIntentFromState, type RuntimeUiIntent } from "@/lib/runtimeUiNavigation";

/** Assert history privacy separately from the contents of the session's unsent handoff. */
export function expectOpaqueRuntimeUiIntent(state: unknown, expectedProjectId?: string): RuntimeUiIntent {
  const marker = (state as { runtimeUiIntent?: unknown } | null)?.runtimeUiIntent;
  expect(marker).toEqual({
    kind: expect.stringMatching(/^(?:create|open)$/u),
    projectId: expectedProjectId ?? expect.stringMatching(/\S/u),
    requestId: expect.stringMatching(/\S/u),
    sessionId: expect.stringMatching(/\S/u),
  });
  const { projectId } = marker as { projectId: string };
  const intent = runtimeUiIntentFromState(state, projectId);
  expect(intent).toMatchObject(marker as object);
  expect(intent).not.toHaveProperty("send");
  return intent!;
}

export function optionalOpaqueRuntimeUiIntent(state: unknown): RuntimeUiIntent | null {
  return state && typeof state === "object" && "runtimeUiIntent" in state
    ? expectOpaqueRuntimeUiIntent(state)
    : null;
}
