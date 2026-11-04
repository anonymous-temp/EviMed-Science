import { describe, expect, it } from "vitest";
import { newRuntimeUiIntent, runtimeUiIntentFromState, type RuntimeUiIntent } from "./runtimeUiNavigation";

const intent = (over: Partial<RuntimeUiIntent> = {}): RuntimeUiIntent => ({ kind: "create", projectId: "default", requestId: "req_1", sessionId: "ses_1", ...over });
const read = (value: unknown, projectId = "default") => runtimeUiIntentFromState({ runtimeUiIntent: value }, projectId);

describe("the intent a page hands the native session surface", () => {
  it("is read only from router state that carries one, for the project on screen", () => {
    expect(runtimeUiIntentFromState(null, "default")).toBeNull();
    expect(runtimeUiIntentFromState({}, "default")).toBeNull();
    expect(runtimeUiIntentFromState({ runtimeUiIntent: "x" }, "default")).toBeNull();
    expect(read(intent())).toEqual(intent());
    expect(read(intent({ projectId: "other" }))).toBeNull();
    expect(read(intent({ kind: "close" as never }))).toBeNull();
    expect(read(intent({ requestId: "has space" }))).toBeNull();
    expect(read(intent({ sessionId: "" }))).toBeNull();
  });

  it("may ask for the kernel's scheduled-task page, and for no other", () => {
    expect(read(intent({ panel: "schedules" }))?.panel).toBe("schedules");
    expect(read(intent({ kind: "open", panel: "schedules" }))?.panel).toBe("schedules");
    expect(read(intent())?.panel).toBeUndefined();
    for (const panel of ["settings", "files", "Schedules", "", "schedules ", null, 1, {}]) {
      expect(read(intent({ panel: panel as never })), JSON.stringify(panel)).toBeNull();
    }
  });

  it("keeps the panel beside a draft and the other things an intent can carry", () => {
    const value = read(intent({ panel: "schedules", draft: "每天早上整理新增文献" }));
    expect(value).toMatchObject({ panel: "schedules", draft: "每天早上整理新增文献" });
    expect(read(intent({ panel: "schedules", draft: "x".repeat(100_001) }))).toBeNull();
  });

  it("is minted for the project on screen, with a conversation of its own", () => {
    const minted = newRuntimeUiIntent();
    expect(minted).toMatchObject({ kind: "create", projectId: "default" });
    expect(minted.panel).toBeUndefined();
    expect(newRuntimeUiIntent().sessionId).not.toBe(minted.sessionId);
    expect(runtimeUiIntentFromState({ runtimeUiIntent: { ...minted, panel: "schedules" } }, "default")?.panel).toBe("schedules");
  });
});
