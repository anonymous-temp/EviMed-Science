// Every prompt the control plane sends a kernel says whether a person is in the turn (`unattended`), and the runtime manager signs
// exactly that into the turn's attendance receipt. The receipt is what the runtime's run policy trusts: an unattended turn may not
// ask a question nobody will answer, nor make or change scheduled tasks. It must say the same as the run's context, which tells the
// model "nobody will answer" unless the dispatch is a person's (`prepareResearchContext`'s `attended`).
//
// Until 2026-10-25 a caller that said nothing was signed "attended", so every programme step, evolution run, learning or reading job
// held a receipt that contradicted its own context (review F4). A caller that says nothing is now signed unattended, and this file
// holds every call site to saying it out loud, so a new dispatch path cannot inherit either default by accident.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

/** The one call that forwards its caller's input whole, so the caller's own call is the one held to the rule. */
const PASS_THROUGH = [/this\.dispatchAdmittedPrompt\(project, sessionId, input\)/];

/** @param {string} directory @returns {AsyncGenerator<string>} */
async function* modules(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* modules(full);
    else if (entry.name.endsWith(".mjs")) yield full;
  }
}

/** The text of a call's arguments, from its opening parenthesis to the matching close. @param {string} text @param {number} open */
function argumentsAt(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")" && --depth === 0) return text.slice(open, index + 1);
  }
  throw new Error("unbalanced call");
}

test("every call that sends a prompt to a kernel states whether a person is in the turn", async () => {
  /** @type {{ site: string, value: string }[]} */
  const sites = [];
  const silent = [];
  for await (const file of modules(source)) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/\.(dispatchPrompt|dispatchAdmittedPrompt)\(/g)) {
      const open = /** @type {number} */ (match.index) + match[0].length - 1;
      const call = argumentsAt(text, open);
      const site = `${path.relative(source, file)}:${text.slice(0, match.index).split("\n").length}`;
      if (PASS_THROUGH.some((pattern) => pattern.test(`this.${match[1]}${call}`))) continue;
      const stated = /\bunattended\s*:\s*([^,\n}]+)/.exec(call);
      if (stated) sites.push({ site, value: stated[1].trim() });
      else silent.push(site);
    }
  }
  assert.deepEqual(silent, [], "each of these sends a prompt without saying whether anybody attends it");
  // The walk proves it walked: the dispatch paths as of 2026-10-25 (chat, channel and its steer, the steer route, a personal skill,
  // the scheduled execution and its re-check, a 虚拟临床研究 and a GEO step, evolution, learning and source reading).
  assert.ok(sites.length >= 12, `found only ${sites.length} dispatch sites`);
  // The person-initiated paths say so; everything else is a turn nobody attends unless the caller's own decision says otherwise.
  const attended = sites.filter((item) => item.value === "false").map((item) => item.site.split(":")[0]);
  assert.deepEqual([...new Set(attended)].sort(), ["runtimeManager.mjs", "server.mjs"]);
  assert.ok(sites.some((item) => item.value === "automated"), "the dispatch route forwards the decision its context gets");
});
