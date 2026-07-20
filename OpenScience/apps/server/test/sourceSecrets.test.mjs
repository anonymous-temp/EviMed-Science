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
