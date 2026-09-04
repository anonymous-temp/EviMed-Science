import { describe, expect, it } from "vitest";
import { formatExecResult, KERNEL_UNAVAILABLE_MESSAGE } from "./kernel";

describe("formatExecResult", () => {
  it("renders desktop kernel stdout and expression result", () => {
    expect(
      formatExecResult({
        ok: true,
        stdout: "hello\n",
        result: "42",
        error: null,
      }),
    ).toBe("hello\n42");
  });

  it("renders hosted kernel stderr for failed executions", () => {
    expect(
      formatExecResult({
        ok: false,
        stdout: "",
        stderr: "Traceback\nboom\n",
        artifacts: [],
      }),
    ).toBe("Traceback\nboom");
  });

  it("keeps hosted kernel warnings visible on successful executions", () => {
    expect(
      formatExecResult({
        ok: true,
        stdout: "done\n",
        stderr: "warning: fallback path\n",
        artifacts: [],
      }),
    ).toBe("done\nwarning: fallback path");
  });

  it("exposes a backend-neutral unavailable message", () => {
    expect(KERNEL_UNAVAILABLE_MESSAGE).toContain("计算内核");
    expect(KERNEL_UNAVAILABLE_MESSAGE).not.toMatch(/desktop/i);
  });
});
