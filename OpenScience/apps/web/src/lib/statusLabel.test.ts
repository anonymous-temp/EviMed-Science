import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LEDGER_STATUS_LABEL, auditTarget, commandLabel, labelFor, securityActionLabel } from "./statusLabel";

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

describe("an audit row's target in words", () => {
  it("names a document, a path and a command by what a person reads, and keeps the identifier apart", () => {
    expect(auditTarget("src_20a9d3af2947385e47bee76791993e26", null)).toEqual({ text: "资料", id: "src_20a9d3af2947385e47bee76791993e26" });
    expect(auditTarget("base:knowledge-base/kg/entities/防风.md", null)).toEqual({ text: "防风.md", id: "knowledge-base/kg/entities/防风.md" });
    expect(auditTarget("inputs/data.csv", null)).toEqual({ text: "data.csv", id: "inputs/data.csv" });
    expect(auditTarget("preview_url", "preview_url")).toEqual({ text: "预览文件", id: "preview_url" });
    expect(auditTarget(null, "write_workspace_file")).toEqual({ text: "写入文件", id: "write_workspace_file" });
    expect(auditTarget(null, null)).toEqual({ text: "项目", id: null });
  });

  it("never prints a command or a code it has no word for: 其他命令, 其他操作", () => {
    expect(commandLabel("a_command_nobody_wrote")).toBe("其他命令");
    expect(commandLabel(null)).toBe("其他命令");
    expect(securityActionLabel("auth.something.new")).toBe("其他操作");
    expect(securityActionLabel("auth.login")).toBe("登录");
  });
});
