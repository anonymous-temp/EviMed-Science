import type { KeyboardEvent } from "react";
import { describe, expect, it } from "vitest";
import { viewerKey } from "./viewerKeyboard";

describe("viewerKey", () => {
  it("keeps browser zoom, composition and editable children outside viewer bindings", () => {
    const surface = document.createElement("div");
    const input = document.createElement("input");
    const event = { currentTarget: surface, target: surface, nativeEvent: { isComposing: false }, ctrlKey: false, metaKey: false, altKey: false };
    const accepts = (overrides: object) => viewerKey({ ...event, ...overrides } as unknown as KeyboardEvent<HTMLElement>);
    expect(accepts({})).toBe(true);
    expect(accepts({ target: input })).toBe(false);
    expect(accepts({ ctrlKey: true })).toBe(false);
    expect(accepts({ metaKey: true })).toBe(false);
    expect(accepts({ nativeEvent: { isComposing: true } })).toBe(false);
  });
});
