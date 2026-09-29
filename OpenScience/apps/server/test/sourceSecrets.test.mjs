import assert from "node:assert/strict";
import test from "node:test";
import { suspiciousLines } from "../../../scripts/ops/audit-source-secrets.mjs";

test("source secret audit catches live credentials without flagging environment placeholders", () => {
  assert.deepEqual(suspiciousLines("password: ${DATABASE_PASSWORD:}\napi-key: replace-with-your-key\n", "fixture.yml"), []);
  assert.deepEqual(suspiciousLines("password: literal-production-password\n", "fixture.yml"), [1]);
  const liveToken = ["sk", "live", "sensitivevalue1234567890"].join("-");
  assert.deepEqual(suspiciousLines(`Authorization: Bearer ${liveToken}\n`, "fixture.md"), [1]);
  const credentialUrl = ["mongodb://user", "literal-password@database:27017/app"].join(":");
  assert.deepEqual(suspiciousLines(`${credentialUrl}\n`, "fixture.txt"), [1]);
  assert.deepEqual(
    suspiciousLines("const dsn = `postgresql://user:${encodeURIComponent(password)}@database/app`;\n", "fixture.mjs"),
    [],
  );
});

test("a P-number in a URL path or query is a document id, not a subject label", () => {
  const attachment = ["https://www.example.gov.cn/zwgk/", ["P", "020220719624226963916"].join(""), ".pdf"].join("");
  assert.deepEqual(suspiciousLines(`见附件（${attachment}）\n`, "fixture.md"), []);
  assert.deepEqual(suspiciousLines(`https://example.org/view?id=${["P", "0202207196"].join("")}\n`, "fixture.md"), []);
  assert.deepEqual(suspiciousLines(`受试者 ${["P", "1234567"].join("")} 的记录\n`, "fixture.md"), [1]);
  assert.deepEqual(suspiciousLines(`受试者 ${["P", "9123456"].join("")} 的记录\n`, "fixture.md"), []);
});

test("the default scan covers the workspace docs tree, which is published with the code", async () => {
  const { auditSourceSecrets } = await import("../../../scripts/ops/audit-source-secrets.mjs");
  const source = auditSourceSecrets.toString();
  assert.match(source, /"\.\.\/docs"/);
});
