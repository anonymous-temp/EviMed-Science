// The repository is public. On 2026-09-26 it carried wording about open issues
// of the host platform we are fused with, in the deployment guide, a service's
// header comment and a test (fusion audit F-G1). The ruling: say what an
// operator must do ("switch only after the platform's security items have
// shipped"), never what is open. History was rewritten on 2026-09-28 to take
// the wording out of every past commit; this keeps it out of new ones. The
// phrases are stored encoded so that this file does not restate them.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
const workspace = path.resolve(path.dirname(here), "../../../..");

/** The closed list of phrases (regular-expression source and flags), base64-encoded. */
const DISCLOSURES = [
  ["SlMtcmVhZGFibGU=", "i"],
  ["cGFyZW50LWRvbWFpbiBjcmVkZW50aWFs", "i"],
  ["XGJ2LWh0bWxcYg==", ""],
  ["SHR0cE9ubHkgcmV3b3Jr", "i"],
  ["5Yet5o2u5pS55oiQIEh0dHBPbmx5", ""],
].map(([source, flags]) => new RegExp(Buffer.from(source, "base64").toString("utf8"), flags));

/** The specs tree is never committed from here, so it is not scanned. */
const OWNED_ELSEWHERE = [/^docs\/superpowers\/specs\//];

test("no tracked text describes the host platform's open security defects", (t) => {
  let files;
  try {
    files = execFileSync("git", ["ls-files", "-z"], { cwd: workspace, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  } catch (error) {
    if (/** @type {any} */ (error)?.code === "ENOENT") { t.skip("no git on this machine"); return; }
    throw error;
  }
  const self = path.relative(workspace, here).split(path.sep).join("/");
  const scoped = files.filter((file) => (file.startsWith("OpenScience/") || file.startsWith("docs/") || !file.includes("/"))
    && file !== self && !file.includes("/node_modules/") && !OWNED_ELSEWHERE.some((rule) => rule.test(file))
    && /\.(md|mjs|js|ts|tsx|json|ya?ml|py|sh|txt)$/.test(file));
  assert.ok(scoped.length > 1000, `walked ${scoped.length} files`);
  const found = [];
  for (const file of scoped) {
    let text;
    try { text = readFileSync(path.join(workspace, file), "utf8"); } catch { continue; }
    for (const phrase of DISCLOSURES) if (phrase.test(text)) found.push(`${file}: ${phrase}`);
  }
  assert.deepEqual(found, []);
});
