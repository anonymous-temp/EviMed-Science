import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LEDGER_STATUS_LABEL, labelFor } from "./statusLabel";

/** Every `audit(…, "action", "status")`, `securityAudit(…)` and download `settle("status")` the server writes with a literal status. */
function writtenStatuses(): Set<string> {
  const dir = path.resolve(__dirname, "../../../server/src");
  const found = new Set<string>();
  const call = /\b(?:audit|securityAudit)\??\.?\(\s*(?:[A-Za-z_.{}, :]+?,\s*)?["`'][a-z][a-z0-9_.]*["`']\s*,\s*["`']([a-z_]+)["`']/g;
  const runtime = /auditRuntimeLifecycle\(\s*[A-Za-z_.]+\s*,\s*[A-Za-z_.]+\s*,\s*"([a-z_]+)"/g;
  const settle = /\bsettle\(\s*"([a-z_]+)"/g;
  for (const name of fs.readdirSync(dir).filter((file) => file.endsWith(".mjs"))) {
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    for (const pattern of [call, runtime, settle]) for (const match of text.matchAll(pattern)) found.add(match[1]);
  }
  return found;
}

describe("the ledger status words", () => {
  it("has a Chinese word for every status the server writes with a literal", () => {
    const written = writtenStatuses();
    // A walk that finds nothing passes forever.
    expect(written.size).toBeGreaterThanOrEqual(10);
    for (const status of written) {
      expect(LEDGER_STATUS_LABEL[status], `${status} would read as 「未登记的状态」`).toBeTruthy();
      expect(labelFor(LEDGER_STATUS_LABEL, status)).toMatch(/[一-鿿]/);
    }
  });

  it("keeps the fallback for what the server computes, and never prints the code itself", () => {
    expect(labelFor(LEDGER_STATUS_LABEL, "a_status_nobody_wrote")).toBe("未登记的状态");
    expect(labelFor(LEDGER_STATUS_LABEL, "")).toBe("未登记的状态");
    expect(labelFor(LEDGER_STATUS_LABEL, "constructor")).toBe("未登记的状态");
  });
});
