import { describe, expect, it } from "vitest";
import { sha256Hex } from "./fileDigest";

/** jsdom's Blob has no `arrayBuffer`; a browser's does, and that is the one thing the function reads. */
const bytes = (text: string) => ({ arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer });

describe("sha256Hex", () => {
  it("is the digest the control plane derives a source from", async () => {
    // The SHA-256 of "abc" (FIPS 180-2 example), and of nothing.
    expect(await sha256Hex(bytes("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Hex(bytes(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
