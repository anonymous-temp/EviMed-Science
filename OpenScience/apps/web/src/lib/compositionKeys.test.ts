import { describe, expect, it } from "vitest";
import { isComposingKey, isSubmitKey } from "./compositionKeys";

describe("host submission keys", () => {
  it("leaves IME Enter and Safari's final 229 key with the input method", () => {
    expect(isSubmitKey({ key: "Enter", nativeEvent: { isComposing: true } })).toBe(false);
    expect(isSubmitKey({ key: "Enter", nativeEvent: { keyCode: 229 } })).toBe(false);
    expect(isComposingKey({ isComposing: true })).toBe(true);
    expect(isSubmitKey({ key: "Enter" })).toBe(true);
    expect(isSubmitKey({ key: "Enter", shiftKey: true })).toBe(false);
    expect(isSubmitKey({ key: "Enter", defaultPrevented: true })).toBe(false);
  });
});
