// Writes evimed_h2/data/current-guidance.md: the platform's standing guidance as an ordinary conversation reads it, as read-only
// context for the harness editors. It evaluates packages/socket/src/guidanceText.mjs with its @evimed/domain imports stubbed
// (no workflow index, no skill roots), so it needs Node and nothing installed. The header records the source's sha256; the test
// `test_guidance_snapshot_is_current` fails when the source moves, which is the cue to run this again.
//
//   node tools/snapshot_guidance.mjs
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "..", "..", "..");
const sourcePath = path.join(root, "packages", "socket", "src", "guidanceText.mjs");
const source = readFileSync(sourcePath, "utf8");
const digest = createHash("sha256").update(source).digest("hex");

const importLine = /^import \{[^}]*\} from '@evimed\/domain'\s*$/m;
if (!importLine.test(source)) throw new Error("guidanceText.mjs no longer imports from @evimed/domain in the expected shape");
const stubbed = source.replace(importLine, "const capabilityListed = () => false; const capabilityTitle = () => ''; const skillRootGuidance = () => '';");

const dir = mkdtempSync(path.join(tmpdir(), "guidance-snapshot-"));
try {
  const file = path.join(dir, "guidanceText.mjs");
  writeFileSync(file, stubbed);
  const { buildGuidanceText } = await import(pathToFileURL(file).href);
  const text = buildGuidanceText([], { askUserEnabled: true, capsuleActive: false, reviewEnabled: false, openVikingMemory: true, runPolicyEnabled: false });
  const header = [
    "<!-- READ-ONLY CONTEXT. The platform's standing guidance, as a plain conversation reads it. It is not part of the harness you edit:",
    "     a change here is dropped. Your supplement goes in guidance.md and adds to this text; it must not repeat it. -->",
    `<!-- source: packages/socket/src/guidanceText.mjs sha256 ${digest}; the professional-workflow index and skill roots are left out -->`,
    "",
  ].join("\n");
  const out = path.join(here, "..", "evimed_h2", "data", "current-guidance.md");
  writeFileSync(out, header + text + "\n");
  console.log(`wrote ${out} (${text.length} chars from source ${digest.slice(0, 12)})`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
