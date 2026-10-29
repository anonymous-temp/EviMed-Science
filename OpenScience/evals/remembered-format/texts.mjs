// Prints, as JSON, the two texts of a conversation's first request that a remembered format is read against: the persona (the preset's
// own row, with the model name filled in the way the kernel fills it) and the guidance (`buildGuidanceText` over the checkout's
// capability manifests, with the options a native-memory account's runtime has). Nothing here is a copy: the arms of the harness are
// edits of this output, so a change to either text in the tree is what the "current" arm measures.
//
//   node evals/remembered-format/texts.mjs [--model deepseek-flash]
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { buildGuidanceText } from "../../packages/socket/src/guidanceText.mjs";

// The preset reads deployment values with `!!js`, a tag this parser does not know; the persona row has none, so the warnings are silenced.
const QUIET = { logLevel: "silent" };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const modelFlag = process.argv.indexOf("--model");
const model = modelFlag > 0 ? process.argv[modelFlag + 1] : "deepseek-flash";

const manifestsDirectory = path.join(root, "capabilities");
const manifests = readdirSync(manifestsDirectory).flatMap((id) => {
  try { return [parse(readFileSync(path.join(manifestsDirectory, id, "capability.yaml"), "utf8"), QUIET)]; } catch { return []; }
});
const guidance = buildGuidanceText(manifests, {
  askUserEnabled: true, capsuleActive: false, reviewEnabled: false, runPolicyEnabled: true, capsuleToolEnabled: false, openVikingMemory: true,
});

const rows = parse(readFileSync(path.join(root, "packages/socket/presets/evimed-universal/agent.cordis.yml"), "utf8"), QUIET);
const prefix = String(rows.find((row) => row?.id === "persona")?.config?.prefix ?? "").replace(/\s+/g, " ").trim();
if (!prefix) throw new Error("the persona row of the preset has no prefix");
// The kernel's own first line, then the preset's persona with the model name filled in.
const persona = `You are an AI agent powered by DeepSeek Harness.\n\n${prefix.replace("{{model}}", model)}`;

process.stdout.write(JSON.stringify({ persona, guidance, model }));
